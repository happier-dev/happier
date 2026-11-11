import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from "./normalize.js";
import { readUnsupportedContentMeta } from "../messages/unsupportedContentMeta.js";

/**
 * Released builds before 2026-07-10 wrote the ACP agent envelope as
 * `{ type: 'acp', provider, data }`. The current writer emits `agentId`
 * (apps/cli/src/api/session/acpMessageEnvelope.ts). Those legacy rows are still persisted in real
 * user history, so the reader must render their true content instead of the unparsed placeholder.
 *
 * The fixtures below are structurally faithful captures of persisted records decrypted from real
 * sessions; only the string values are elided.
 */
describe('normalizeRawMessage legacy ACP `provider` envelope', () => {
    it('renders the real agent text of a legacy `provider` message record', () => {
        const raw = {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'codex',
                data: { type: 'message', message: 'the real agent answer' },
            },
            meta: { sentFrom: 'cli', source: 'codex-app-server-runtime' },
        };

        const normalized = normalizeRawMessage('msg-legacy-1', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized || normalized.role !== 'agent') throw new Error('expected an agent message');
        expect(normalized.content).toEqual([
            expect.objectContaining({ type: 'text', text: 'the real agent answer' }),
        ]);
        expect(readUnsupportedContentMeta(normalized.meta)).toBeNull();
    });

    it('renders a legacy `provider` tool-call record as a tool call, not a placeholder', () => {
        const raw = {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'codex',
                data: {
                    type: 'tool-call',
                    callId: 'call_legacy_tool_call_1',
                    name: 'Bash',
                    id: 'tool-call-legacy-1',
                    input: { cmd: 'ls', workdir: '/tmp', locations: [] },
                },
            },
            meta: { sentFrom: 'cli', source: 'runtime', runtimeEventKind: 'tool-call' },
        };

        const normalized = normalizeRawMessage('msg-legacy-2', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized || normalized.role !== 'agent') throw new Error('expected an agent message');
        expect(normalized.content).toEqual([
            expect.objectContaining({ type: 'tool-call', name: 'Bash' }),
        ]);
        expect(readUnsupportedContentMeta(normalized.meta)).toBeNull();
    });

    it('still yields the unparsed placeholder for an ACP record that identifies no agent', () => {
        const raw = {
            role: 'agent',
            content: {
                type: 'acp',
                data: { type: 'message', message: 'the real agent answer' },
            },
        };

        const normalized = normalizeRawMessage('msg-legacy-3', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized || normalized.role !== 'agent') throw new Error('expected an agent message');
        expect(normalized.content).toEqual([
            expect.objectContaining({ type: 'text', text: '[Unparsed agent message]' }),
        ]);
        expect(readUnsupportedContentMeta(normalized.meta)).toBe('unparsed-agent-message');
    });

    it('still yields the unparsed placeholder when `provider` is not a usable agent id', () => {
        const blank = normalizeRawMessage('msg-legacy-4', null, 1000, {
            role: 'agent',
            content: { type: 'acp', provider: '   ', data: { type: 'message', message: 'x' } },
        });
        const structured = normalizeRawMessage('msg-legacy-5', null, 1000, {
            role: 'agent',
            content: { type: 'acp', provider: { id: 'codex' }, data: { type: 'message', message: 'x' } },
        });

        expect(readUnsupportedContentMeta(blank?.meta)).toBe('unparsed-agent-message');
        expect(readUnsupportedContentMeta(structured?.meta)).toBe('unparsed-agent-message');
    });

    it('quietly skips a future content envelope without treating its provider field as ACP', () => {
        const normalized = normalizeRawMessage('msg-legacy-6', null, 1000, {
            role: 'agent',
            content: { type: 'totally-unknown-content-type', provider: 'codex', data: { type: 'message' } },
        });

        expect(normalized).toBeNull();
    });
});

// QA r1111c external Muse import: tool records have a native callId and an
// outer stored message id, but no redundant presentation id inside ACP data.
it.each(['tool-call', 'tool-result'] as const)('renders imported Muse %s without an inner presentation id', type => {
    const normalized = normalizeRawMessage('imported-row', null, 1000, {
        role: 'agent', content: { type: 'acp', agentId: 'muse', data: type === 'tool-call'
            ? { type, callId: 'native-call', name: 'bash', input: { command: 'printf OK' } }
            : { type, callId: 'native-call', output: 'OK', isError: false } },
    });
    expect(readUnsupportedContentMeta(normalized?.meta)).toBeNull();
    expect(normalized?.role === 'agent' && normalized.content).toEqual([
        expect.objectContaining(type === 'tool-call'
            ? { type, id: 'native-call', name: 'bash', input: { command: 'printf OK' }, uuid: 'imported-row' }
            : { type, tool_use_id: 'native-call', content: 'OK', uuid: 'imported-row' }),
    ]);
});
