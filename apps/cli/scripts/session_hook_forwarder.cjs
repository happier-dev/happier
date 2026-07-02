#!/usr/bin/env node
/**
 * Session Hook Forwarder
 *
 * This script is executed by Claude's SessionStart hook.
 * It reads JSON data from stdin and forwards it to Happier's hook server.
 *
 * Usage: echo '{"session_id":"..."}' | node session_hook_forwarder.cjs <port> [hook_event_name] [secret]
 */

const http = require('http');
const fs = require('fs');

const port = parseInt(process.argv[2], 10);
const hookEventName = typeof process.argv[3] === 'string' && process.argv[3].length > 0 ? process.argv[3] : '';

function readSecret(args) {
    if (args[0] !== '--secret-file' || typeof args[1] !== 'string' || args[1].length === 0) {
        return '';
    }
    try {
        return fs.readFileSync(args[1], 'utf8').trim();
    } catch {
        return '';
    }
}

const secret = readSecret(process.argv.slice(4));

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

    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': body.length
    };
    if (secret.length > 0) {
        headers['x-happier-hook-secret'] = secret;
    }

    const req = http.request({
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: '/hook/session-start',
        headers
    }, (res) => {
        res.resume(); // Drain response
    });

    req.on('error', () => {
        // Silently ignore errors - don't break Claude
    });

    req.end(body);
});

process.stdin.resume();
