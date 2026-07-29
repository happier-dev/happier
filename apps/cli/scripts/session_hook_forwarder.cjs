#!/usr/bin/env node
/**
 * Session Hook Forwarder
 *
 * This script is executed by a non-controlling Agent lifecycle hook.
 * It makes one bounded attempt to forward JSON from stdin to Happier's existing hook server.
 *
 * Usage: echo '{"session_id":"..."}' | node session_hook_forwarder.cjs <port> [hook_event_name] [--qualified-external-session] --secret-file <path>
 */

const http = require('http');
const fs = require('fs');

const FORWARDING_DEADLINE_MS = 500;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_QUALIFIED_INPUT_BYTES = 64 * 1024;
const MAX_HOSTED_SECRET_FILE_BYTES = 4 * 1024;
const MAX_QUALIFIED_SECRET_FILE_BYTES = 44;
const QUALIFIED_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const QUALIFIED_EXTERNAL_SESSION_HOOK_PATH = '/hook/qualified-external-session';
const forwardingStartedAtMs = Date.now();
const port = parseInt(process.argv[2], 10);
const hookEventName = typeof process.argv[3] === 'string' && process.argv[3].length > 0 ? process.argv[3] : '';
const flags = process.argv.slice(4);
const qualifiedExternalSession = flags.includes('--qualified-external-session');
let request = null;
let settled = false;

function finish() {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    request?.destroy();
    process.exit(0);
}

const deadline = setTimeout(finish, FORWARDING_DEADLINE_MS);

function readFlagValue(args, flag) {
    const index = args.indexOf(flag);
    if (index < 0 || typeof args[index + 1] !== 'string' || args[index + 1].length === 0) {
        return '';
    }
    return args[index + 1];
}

async function readSecret(args) {
    const secretFile = readFlagValue(args, '--secret-file');
    if (!secretFile) {
        return '';
    }
    let file = null;
    try {
        file = await fs.promises.open(secretFile, 'r');
        const metadata = await file.stat();
        const maxBytes = qualifiedExternalSession
            ? MAX_QUALIFIED_SECRET_FILE_BYTES
            : MAX_HOSTED_SECRET_FILE_BYTES;
        if (
            !metadata.isFile()
            || !Number.isSafeInteger(metadata.size)
            || metadata.size < 0
            || metadata.size > maxBytes
        ) {
            return '';
        }
        const contents = Buffer.alloc(metadata.size);
        let offset = 0;
        while (offset < contents.length) {
            const read = await file.read(
                contents,
                offset,
                contents.length - offset,
                offset,
            );
            if (read.bytesRead === 0) return '';
            offset += read.bytesRead;
        }
        const tail = Buffer.alloc(1);
        const afterBound = await file.read(tail, 0, 1, contents.length);
        if (afterBound.bytesRead !== 0) return '';
        const raw = contents.toString('utf8');
        if (!qualifiedExternalSession) return raw.trim();
        const token = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
        return QUALIFIED_SECRET_PATTERN.test(token) ? token : '';
    } catch {
        return '';
    } finally {
        if (file) await file.close().catch(() => undefined);
    }
}

const secret = readSecret(flags);

if (!port || isNaN(port)) {
    finish();
}

const chunks = [];
let inputBytes = 0;

process.stdin.on('data', (chunk) => {
    if (settled) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    inputBytes += buffer.length;
    if (
        inputBytes > MAX_INPUT_BYTES
        || (qualifiedExternalSession && inputBytes > MAX_QUALIFIED_INPUT_BYTES)
    ) {
        finish();
        return;
    }
    chunks.push(buffer);
});

process.stdin.on('end', async () => {
    if (settled) return;
    let body = Buffer.concat(chunks);
    if (qualifiedExternalSession) {
        try {
            const nativePayload = JSON.parse(body.toString('utf8'));
            body = Buffer.from(JSON.stringify({
                eventId: hookEventName,
                observedAtMs: forwardingStartedAtMs,
                forwardingStartedAtMs,
                nativePayload,
            }), 'utf8');
        } catch {
            finish();
            return;
        }
    } else if (hookEventName) {
        try {
            const parsed = JSON.parse(body.toString('utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.hook_event_name !== 'string') {
                parsed.hook_event_name = hookEventName;
                body = Buffer.from(JSON.stringify(parsed), 'utf8');
            }
        } catch {
            // Preserve the original payload if the Agent sends unexpected data.
        }
    }
    if (
        body.length > MAX_INPUT_BYTES
        || (qualifiedExternalSession && body.length > MAX_QUALIFIED_INPUT_BYTES)
    ) {
        finish();
        return;
    }

    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': body.length
    };
    const resolvedSecret = await secret;
    if (settled) return;
    if (resolvedSecret.length > 0) {
        headers['x-happier-hook-secret'] = resolvedSecret;
    }

    request = http.request({
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: qualifiedExternalSession
            ? QUALIFIED_EXTERNAL_SESSION_HOOK_PATH
            : '/hook/session-start',
        headers
    }, (res) => {
        res.resume(); // Drain response
        res.on('end', finish);
    });

    request.on('error', finish);

    request.end(body);
});

process.stdin.resume();
