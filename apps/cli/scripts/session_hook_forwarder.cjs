#!/usr/bin/env node
/**
 * Session Hook Forwarder
 * 
 * This script is executed by Claude's SessionStart hook.
 * It reads JSON data from stdin and forwards it to Happier's hook server.
 * 
 * Usage: echo '{"session_id":"..."}' | node session_hook_forwarder.cjs <port> [hook_event_name]
 */

const http = require('http');

const port = parseInt(process.argv[2], 10);
const hookEventName = typeof process.argv[3] === 'string' && process.argv[3].length > 0 ? process.argv[3] : '';

if (!port || isNaN(port)) {
    process.exit(1);
}

const chunks = [];

process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    let body = Buffer.concat(chunks);
    if (hookEventName) {
        try {
            const parsed = JSON.parse(body.toString('utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.hook_event_name !== 'string') {
                parsed.hook_event_name = hookEventName;
                body = Buffer.from(JSON.stringify(parsed), 'utf8');
            }
        } catch {
            // Preserve original payload if Claude sends unexpected data.
        }
    }
    
    const req = http.request({
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: '/hook/session-start',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length
        }
    }, (res) => {
        res.resume(); // Drain response
    });
    
    req.on('error', () => {
        // Silently ignore errors - don't break Claude
    });
    
    req.end(body);
});

process.stdin.resume();
