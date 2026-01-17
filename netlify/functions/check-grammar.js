// netlify/functions/check-grammar.js

exports.handler = async function(event, context) {
  console.log('=== Grammar Check Function Started ===');
  
  // Enable CORS for all origins
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    console.log('Handling OPTIONS preflight request');
    return {
      statusCode: 200,
      headers: headers,
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    console.log('Method not allowed:', event.httpMethod);
    return {
      statusCode: 405,
      headers: headers,
      body: JSON.stringify({ 
        success: false, 
        error: 'Method not allowed. Use POST.' 
      })
    };
  }

  try {
    // Parse the request body
    let text = '';
    try {
      const body = JSON.parse(event.body);
      text = body.text || '';
      console.log('Text received, length:', text.length);
      console.log('First 100 chars:', text.substring(0, 100) + '...');
    } catch (parseError) {
      console.error('Failed to parse request body:', parseError);
      console.log('Raw body:', event.body);
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ 
          success: false, 
          error: 'Invalid request body. Must be JSON with text property.' 
        })
      };
    }
    
    if (!text || text.trim().length === 0) {
      console.log('No text provided or empty text');
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ 
          success: false, 
          error: 'No text provided. Please enter text to check.' 
        })
      };
    }

    // Get Gemini API key from environment variable
    const apiKey = process.env.GEMINI_API_KEY;
    console.log('API Key configured:', !!apiKey);
    
    if (!apiKey) {
      console.log('GEMINI_API_KEY is not set in environment variables, using demo mode');
      const demoErrors = getDemoErrors(text);
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({
          success: true,
          original: text,
          errors: demoErrors,
          errorCount: demoErrors.length,
          timestamp: new Date().toISOString(),
          note: 'Demo mode (API key not configured)',
          mode: 'demo'
        })
      };
    }

    console.log('Calling Gemini API...');
    
    try {
      // Call Gemini AI API
      const apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';
      
      // Optimized prompt for grammar checking
      const prompt = `Please analyze this text for grammar, spelling, punctuation, and style errors. 
Return a JSON array of error objects. Each error object should have:
1. "text": the incorrect word/phrase (exact text from the input)
2. "suggestion": the corrected version
3. "reason": brief explanation of the error
4. "type": error type (grammar, spelling, punctuation, or style)

Example response format:
[
  {
    "text": "is",
    "suggestion": "are",
    "reason": "Subject-verb agreement error with plural subject",
    "type": "grammar"
  }
]

Text to analyze: "${text.substring(0, 2000)}"`;

      console.log('Sending request to Gemini API...');
      const response = await fetch(`${apiUrl}?key=${apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1500,
            topP: 0.8,
            topK: 40
          },
          safetySettings: [
            {
              category: "HARM_CATEGORY_HARASSMENT",
              threshold: "BLOCK_NONE"
            },
            {
              category: "HARM_CATEGORY_HATE_SPEECH",
              threshold: "BLOCK_NONE"
            },
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              threshold: "BLOCK_NONE"
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_NONE"
            }
          ]
        })
      });

      console.log('Gemini API response status:', response.status);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Gemini API error response:', errorText);
        throw new Error(`Gemini API returned ${response.status}: ${errorText.substring(0, 200)}`);
      }

      const data = await response.json();
      console.log('Gemini API response received');
      
      let errors = [];
      let aiResponseText = '';
      
      if (data.candidates && 
          data.candidates[0] && 
          data.candidates[0].content && 
          data.candidates[0].content.parts[0]) {
        
        aiResponseText = data.candidates[0].content.parts[0].text.trim();
        console.log('AI Response (first 300 chars):', aiResponseText.substring(0, 300) + '...');
        
        // Try to extract JSON from the response
        try {
          // First, try to parse the entire response as JSON
          const parsed = JSON.parse(aiResponseText);
          if (Array.isArray(parsed)) {
            errors = parsed;
            console.log('Successfully parsed as JSON array');
          } else if (parsed.errors && Array.isArray(parsed.errors)) {
            errors = parsed.errors;
            console.log('Found errors array in parsed object');
          } else if (typeof parsed === 'object') {
            // If it's an object but not in expected format, try to extract errors
            errors = Object.values(parsed).filter(item => 
              item && typeof item === 'object' && item.text && item.suggestion
            );
            console.log('Extracted errors from object:', errors.length);
          }
        } catch (parseError) {
          console.log('Could not parse as JSON directly, trying to extract JSON...');
          
          // Try to find JSON array in the response using regex
          const jsonMatch = aiResponseText.match(/\[[\s\S]*?\]/);
          if (jsonMatch) {
            try {
              const extracted = JSON.parse(jsonMatch[0]);
              if (Array.isArray(extracted)) {
                errors = extracted;
                console.log('Successfully extracted JSON array from response');
              }
            } catch (e) {
              console.error('Failed to parse extracted JSON:', e.message);
            }
          } else {
            console.log('No JSON array found in AI response');
            // Try to parse line by line for error patterns
            const lines = aiResponseText.split('\n').filter(line => 
              line.includes('"text"') || line.includes('"suggestion"') || 
              line.includes('text:') || line.includes('suggestion:')
            );
            console.log('Found lines with potential error data:', lines.length);
          }
        }
      } else {
        console.log('No valid response structure from Gemini API');
        if (data.error) {
          console.error('API error:', data.error);
        }
      }

      // If no errors found by AI, use demo errors
      if (errors.length === 0) {
        console.log('No errors found by AI, using demo errors as fallback');
        errors = getDemoErrors(text);
      } else {
        console.log(`AI found ${errors.length} potential errors`);
      }

      // Validate and format errors
      const validErrors = errors
        .filter(error => {
          if (!error || typeof error !== 'object') return false;
          
          const hasText = error.text || error.incorrect || error.error;
          const hasSuggestion = error.suggestion || error.correct || error.correction;
          
          if (!hasText || !hasSuggestion) {
            console.log('Skipping invalid error object:', error);
            return false;
          }
          
          // Check if the error text actually appears in the original text
          const errorText = error.text || error.incorrect || error.error;
          const escapedText = errorText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escapedText, 'gi');
          const foundInText = regex.test(text);
          
          if (!foundInText) {
            console.log(`Error text "${errorText}" not found in original text`);
          }
          
          return foundInText;
        })
        .map((error, index) => {
          // Standardize error object format
          return {
            text: error.text || error.incorrect || error.error,
            suggestion: error.suggestion || error.correct || error.correction,
            reason: error.reason || error.explanation || error.description || 'Grammar improvement suggested',
            type: error.type || 'grammar',
            id: index,
            original: error.text || error.incorrect || error.error
          };
        });

      console.log(`Returning ${validErrors.length} valid errors`);
      
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({
          success: true,
          original: text,
          errors: validErrors,
          errorCount: validErrors.length,
          timestamp: new Date().toISOString(),
          mode: validErrors.length > 0 ? 'ai' : 'demo',
          note: validErrors.length > 0 ? 
            `Found ${validErrors.length} error(s)` : 
            'No errors found'
        })
      };

    } catch (apiError) {
      console.error('Gemini API call failed:', apiError.message);
      
      // Use demo errors as fallback
      const demoErrors = getDemoErrors(text);
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({
          success: true,
          original: text,
          errors: demoErrors,
          errorCount: demoErrors.length,
          timestamp: new Date().toISOString(),
          mode: 'demo',
          note: `Using demo errors (API error: ${apiError.message.substring(0, 100)})`
        })
      };
    }

  } catch (error) {
    console.error('Unexpected error in check-grammar function:', error);
    console.error('Error stack:', error.stack);
    
    // Return a safe response with demo errors
    let text = '';
    try {
      const parsedBody = JSON.parse(event.body);
      text = parsedBody.text || '';
    } catch (e) {
      text = '';
    }
    
    const demoErrors = getDemoErrors(text);
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: true,
        original: text,
        errors: demoErrors,
        errorCount: demoErrors.length,
        timestamp: new Date().toISOString(),
        mode: 'demo',
        note: 'Using demo errors (server error occurred)'
      })
    };
  }
};

// Enhanced demo errors function
function getDemoErrors(text) {
  if (!text || text.trim().length === 0) {
    console.log('No text for demo errors');
    return [];
  }
  
  console.log('Generating demo errors for text');
  const textLower = text.toLowerCase();
  const errors = [];
  
  // Common grammar errors with better detection
  const errorPatterns = [
    {
      pattern: /\b(i|we|you|they|people|countries|students|friends)\s+(is|was|has|does)\b/gi,
      text: (match) => match.split(' ')[1], // Get the verb
      suggestion: (match) => {
        const words = match.split(' ');
        const subject = words[0].toLowerCase();
        const verb = words[1].toLowerCase();
        
        const corrections = {
          'is': 'are',
          'was': 'were',
          'has': 'have',
          'does': 'do'
        };
        
        return corrections[verb] || verb;
      },
      reason: 'Subject-verb agreement error',
      type: 'grammar'
    },
    {
      pattern: /\b(he|she|it)\s+(are|were|have|do)\b/gi,
      text: (match) => match.split(' ')[1],
      suggestion: (match) => {
        const verb = match.split(' ')[1].toLowerCase();
        const corrections = {
          'are': 'is',
          'were': 'was',
          'have': 'has',
          'do': 'does'
        };
        return corrections[verb] || verb;
      },
      reason: 'Subject-verb agreement error with singular subject',
      type: 'grammar'
    },
    {
      pattern: /\b(dont|wont|cant|isnt|arent|wasnt|werent|hasnt|havent|doesnt|dont)\b/gi,
      text: (match) => match,
      suggestion: (match) => {
        const contractions = {
          'dont': 'don\'t',
          'wont': 'won\'t',
          'cant': 'can\'t',
          'isnt': 'isn\'t',
          'arent': 'aren\'t',
          'wasnt': 'wasn\'t',
          'werent': 'weren\'t',
          'hasnt': 'hasn\'t',
          'havent': 'haven\'t',
          'doesnt': 'doesn\'t'
        };
        return contractions[match.toLowerCase()] || match;
      },
      reason: 'Missing apostrophe in contraction',
      type: 'punctuation'
    },
    {
      pattern: /\b(its)\b(?![\.\,\?\!\'\"]|$)/gi,
      text: (match) => match,
      suggestion: 'it\'s',
      reason: 'Should be "it\'s" (contraction of "it is")',
      type: 'spelling'
    },
    {
      pattern: /\b(your)\s+(welcome|going|right)\b/gi,
      text: (match) => 'your',
      suggestion: 'you\'re',
      reason: 'Should be "you\'re" (contraction of "you are")',
      type: 'spelling'
    },
    {
      pattern: /\b(there)\s+(house|car|book|dog|cat)\b/gi,
      text: (match) => 'there',
      suggestion: 'their',
      reason: 'Should be "their" (possessive pronoun)',
      type: 'spelling'
    },
    {
      pattern: /\b(then)\s+(more|less|better|worse)\b/gi,
      text: (match) => 'then',
      suggestion: 'than',
      reason: 'Should be "than" for comparisons',
      type: 'spelling'
    },
    {
      pattern: /\b(loose)\s+(weight|the game)\b/gi,
      text: (match) => 'loose',
      suggestion: 'lose',
      reason: 'Should be "lose" (verb meaning to not win)',
      type: 'spelling'
    },
    {
      pattern: /\b(affect)\s+(the|an|a)\b/gi,
      text: (match) => 'affect',
      suggestion: 'effect',
      reason: 'Should be "effect" (noun meaning result)',
      type: 'spelling'
    },
    {
      pattern: /(\.|\?|\!)([A-Za-z])/g,
      text: (match) => match,
      suggestion: (match) => match[0] + ' ' + match[1].toUpperCase(),
      reason: 'Missing space after punctuation',
      type: 'punctuation'
    }
  ];

  // Check for each error pattern
  errorPatterns.forEach((patternObj, index) => {
    const matches = text.match(patternObj.pattern);
    if (matches) {
      matches.forEach(match => {
        const errorText = typeof patternObj.text === 'function' ? patternObj.text(match) : patternObj.text;
        const suggestion = typeof patternObj.suggestion === 'function' ? patternObj.suggestion(match) : patternObj.suggestion;
        
        // Check if this error is already in our list
        const existingError = errors.find(e => e.text === errorText && e.suggestion === suggestion);
        if (!existingError) {
          errors.push({
            text: errorText,
            suggestion: suggestion,
            reason: patternObj.reason,
            type: patternObj.type,
            id: errors.length,
            original: errorText
          });
        }
      });
    }
  });

  // Add some random common errors if we found too few
  if (errors.length < 3 && text.length > 50) {
    const commonErrors = [
      { text: 'alot', suggestion: 'a lot', reason: 'Should be two words: "a lot"', type: 'spelling' },
      { text: 'everyday', suggestion: 'every day', reason: 'Should be two words when meaning "each day"', type: 'spelling' },
      { text: 'alright', suggestion: 'all right', reason: 'Formal writing prefers "all right"', type: 'style' },
      { text: 'gonna', suggestion: 'going to', reason: 'Avoid contractions in formal writing', type: 'style' },
      { text: 'wanna', suggestion: 'want to', reason: 'Avoid contractions in formal writing', type: 'style' }
    ];
    
    commonErrors.forEach(error => {
      if (textLower.includes(error.text) && errors.length < 5) {
        errors.push({
          ...error,
          id: errors.length,
          original: error.text
        });
      }
    });
  }

  console.log(`Generated ${errors.length} demo errors`);
  return errors.slice(0, 10); // Limit to 10 errors max
}
