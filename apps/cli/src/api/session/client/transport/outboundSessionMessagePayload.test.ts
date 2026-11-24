import { describe, expect, it } from 'vitest';

import { decodeBase64, decrypt } from '../../../encryption';
import {
    buildDurableOutboundSessionMessagePayload,
    buildOutboundSessionMessagePayload as encode,
} from './outboundSessionMessagePayload';
import { registerTranscriptSecret, TRANSCRIPT_SECRET_REDACTED as R } from './transcriptSecretRedaction';

// Short person-chosen Project secrets that also occur as ordinary words in control data.
const SHORT_SECRETS = ['native', 'postgres', '1', 'secret', 'true'];

function withSecrets<T>(run: () => T): T {
    const releases = SHORT_SECRETS.map(registerTranscriptSecret);
    try { return run(); } finally { releases.forEach(release => release()); }
}

describe('outbound Session message content redaction', () => {
    const meta = { sentFrom: 'cli', source: 'cli', runtimeTurnId: 'turn-1', happier: { kind: 'native', payload: { secret: true } } };

    it('masks only the Agent-authored text and tool input/output values, never the envelope', () => {
        const toolCall = {
            role: 'agent',
            content: { type: 'acp', agentId: 'native', data: {
                type: 'tool-call', callId: 'call-1', id: 'native-1', name: 'mcp__postgres__query', sidechainId: 'side-1',
                input: { postgresUrl: 'postgres://made-up:secret@host/db', limit: 1, dryRun: true },
            } },
            meta,
        };
        const toolResult = {
            role: 'agent',
            content: { type: 'acp', agentId: 'native', data: {
                type: 'tool-result', callId: 'call-1', id: 'native-2', isError: false,
                output: { rows: [{ secret: 'value is secret' }], count: 1 },
            } },
            meta,
        };
        const userText = { role: 'user', content: { type: 'text', text: 'my password is secret' }, meta };
        const [call, result, text] = withSecrets(() => [toolCall, toolResult, userText]
            .map(content => encode({ mode: 'plain', ctx: null }, content)));
        expect(call).toEqual({ t: 'plain', v: { ...toolCall, content: { ...toolCall.content, data: {
            ...toolCall.content.data, input: { postgresUrl: `${R}://made-up:${R}@host/db`, limit: 1, dryRun: true },
        } } } });
        expect(result).toEqual({ t: 'plain', v: { ...toolResult, content: { ...toolResult.content, data: {
            ...toolResult.content.data, output: { rows: [{ secret: `value is ${R}` }], count: 1 },
        } } } });
        expect(text).toEqual({ t: 'plain', v: { ...userText, content: { type: 'text', text: `my password is ${R}` } } });
    });

    it('keeps every key of a tool-call permission offer, even one that does not parse, and masks only values', () => {
        const toolCall = {
            role: 'agent',
            content: { type: 'acp', agentId: 'native', data: {
                type: 'tool-call', callId: 'call-1', id: 'native-1', name: 'mcp__postgres__query', input: {},
                permission: { id: 'perm-1', status: 'pending', source: 'native', nativeChoices: { postgres: { secret: 'run postgres' }, native: 1 } },
            } },
            meta,
        };
        const payload = withSecrets(() => encode({ mode: 'plain', ctx: null }, toolCall)) as { v: typeof toolCall };
        const permission = payload.v.content.data.permission;
        expect({ ...permission, nativeChoices: undefined }).toEqual({ ...toolCall.content.data.permission, nativeChoices: undefined });
        expect(permission.nativeChoices).toEqual({ postgres: { secret: `run ${R}` }, native: 1 });
        expect(payload.v.content.data.name).toBe('mcp__postgres__query');
    });

    it('classifies every stored body type from the transcript schema, and keeps an unknown body\'s identity exact', () => {
        const ids = { callId: 'call-1', id: 'native-1', sidechainId: 'side-1' };
        const callResult = { role: 'agent', content: { type: 'acp', agentId: 'native', data: {
            type: 'tool-call-result', ...ids, output: { text: 'secret' } } } };
        const codex = { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', ...ids, name: 'native', input: { q: 'postgres' } } } };
        const unknown = { role: 'agent', content: { type: 'acp', agentId: 'native', data: { type: 'native-future', ...ids, body: 'postgres' } } };
        const [a, b, c] = withSecrets(() => [callResult, codex, unknown].map(content => encode({ mode: 'plain', ctx: null }, content)));
        expect(a).toEqual({ t: 'plain', v: { ...callResult, content: { ...callResult.content, data: {
            ...callResult.content.data, output: { text: R } } } } });
        expect(b).toEqual({ t: 'plain', v: { ...codex, content: { ...codex.content, data: { ...codex.content.data, input: { q: R } } } } });
        expect(c).toEqual({ t: 'plain', v: { ...unknown, content: { ...unknown.content, data: { ...unknown.content.data, body: R } } } });
    });

    it('applies the same projection to the durable writer', () => {
        const message = {
            role: 'agent',
            content: { type: 'acp', agentId: 'native', data: { type: 'message', message: 'connect to postgres', id: 'native-3' } },
            meta,
        };
        const durable = withSecrets(() => buildDurableOutboundSessionMessagePayload({ mode: 'plain', ctx: null },
            { content: message, sessionId: 'session-1', localId: 'local-1' }));
        expect(durable.payload).toEqual({ t: 'plain', v: { ...message, content: { ...message.content, data: {
            ...message.content.data, message: `connect to ${R}`,
        } } } });
    });
});

describe('outbound Session message payload', () => {
    it('preserves plain content without acquiring a transport or encryption material', () => {
        const content = { role: 'agent', content: { text: 'hello' } };
        expect(encode({ mode: 'plain', ctx: null }, content)).toEqual({ t: 'plain', v: content });
    });

    it.each(['legacy', 'dataKey'] as const)('seals %s content for the existing message reader', encryptionVariant => {
        const encryptionKey = new Uint8Array(32).fill(7);
        const content = { role: 'agent', content: { text: 'private' } };
        const payload = encode({ mode: 'e2ee', ctx: { encryptionKey, encryptionVariant } }, content);
        expect(typeof payload).toBe('string');
        if (typeof payload !== 'string') throw new Error('Expected encrypted payload');
        expect(decrypt(encryptionKey, encryptionVariant, decodeBase64(payload))).toEqual(content);
    });
    it.each(['legacy', 'dataKey'] as const)('compresses %s transcript bytes before sealing', encryptionVariant => {
        const encryptionKey = new Uint8Array(32).fill(7);
        const content = { role: 'agent', content: { text: 'repeat tool output 🗝️\n'.repeat(256) } };
        const payload = encode({ mode: 'e2ee', ctx: { encryptionKey, encryptionVariant } }, content);
        if (typeof payload !== 'string') throw new Error('Expected encrypted payload');
        const bytes = decodeBase64(payload);
        expect(bytes.byteLength).toBeLessThan(new TextEncoder().encode(JSON.stringify(content)).byteLength);
        if (encryptionVariant === 'dataKey') expect(bytes[0]).toBe(1);
        expect(decrypt(encryptionKey, encryptionVariant, bytes)).toEqual(content);
    });
});
