exports.handler = async function(event) {
    const { text } = JSON.parse(event.body);
    const apiKey = process.env.GEMINI_API_KEY;
    
    // Call Gemini API here
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                parts: [{
                    text: `Analyze this text for grammar errors: ${text}`
                }]
            }]
        })
    });
    
    // Process and return results
    return {
        statusCode: 200,
        body: JSON.stringify(await response.json())
    };
};
