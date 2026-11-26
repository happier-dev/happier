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

function reportFailure(stage, error) {
    // Error messages can contain secret-file paths or hook payloads; emit only OS codes.
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
        ? ` (${error.code})`
        : '';
    process.stderr.write(`[happier hook] ${stage}${code}\n`);
}

const port = parseInt(process.argv[2], 10);

// Args after the port: an optional hook event name, then optional `--secret-file <path>`
// (keeps the secret off the world-visible command line; mirrors permission_hook_forwarder.cjs).
let hookEventName = '';
let secretFilePath = '';
const restArgs = process.argv.slice(3);
for (let i = 0; i < restArgs.length; i += 1) {
    const arg = restArgs[i];
    if (arg === '--secret-file') {
        secretFilePath = typeof restArgs[i + 1] === 'string' ? restArgs[i + 1] : '';
        i += 1;
        continue;
    }
    if (!hookEventName && typeof arg === 'string' && arg.length > 0) {
        hookEventName = arg;
    }
}

let secret = '';
if (secretFilePath) {
    try {
        secret = require('fs').readFileSync(secretFilePath, 'utf8').trim();
    } catch (error) {
        reportFailure('Cannot read hook secret file', error);
        // Unreadable secret file: forward without a secret; the server rejects if it requires one.
        secret = '';
    }
}

if (!port || isNaN(port)) {
    reportFailure('Invalid hook server port');
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
            'Content-Length': body.length,
            ...(secret.length > 0 ? { 'x-happier-hook-secret': secret } : {})
        }
    }, (res) => {
        res.resume(); // Drain response
        res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                reportFailure(`Hook server returned HTTP ${res.statusCode}`);
                process.exitCode = 1;
            }
        });
    });
    
    req.on('error', (error) => {
        reportFailure('Hook request failed', error);
        // A failed observer delivery must be visible to Claude instead of looking successful.
        process.exitCode = 1;
    });
    
    req.end(body);
});

process.stdin.resume();
