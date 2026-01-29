import { describe, expect, it } from 'vitest';
import { extractToolTraceFixturesFromJsonlLines } from './extractToolTraceFixtures';

describe('extractToolTraceFixturesFromJsonlLines', () => {
    it('groups tool events by protocol/provider/kind/tool name', () => {
        const fixtures = extractToolTraceFixturesFromJsonlLines([
            JSON.stringify({
                v: 1,
                ts: 1,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'opencode',
                kind: 'tool-call',
                payload: { type: 'tool-call', name: 'read', input: { filePath: '/etc/hosts' } },
            }),
            JSON.stringify({
                v: 1,
                ts: 2,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'opencode',
                kind: 'message',
                payload: { type: 'message', message: 'hello' },
            }),
            JSON.stringify({
                v: 1,
                ts: 3,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'codex',
                provider: 'codex',
                kind: 'tool-call',
                payload: { type: 'tool-call', name: 'CodexBash', input: { command: 'ls' } },
            }),
        ]);

        expect(fixtures.v).toBe(1);
        expect(Object.keys(fixtures.examples)).toEqual(
            expect.arrayContaining(['acp/opencode/tool-call/read', 'codex/codex/tool-call/CodexBash'])
        );
        expect(fixtures.examples['acp/opencode/tool-call/read']).toHaveLength(1);
        expect(fixtures.examples['codex/codex/tool-call/CodexBash']).toHaveLength(1);
        expect(fixtures.examples['acp/opencode/message']).toBeUndefined();
    });

    it('keys tool-result events by tool name even when the tool-call arrives later in the trace', () => {
        const fixtures = extractToolTraceFixturesFromJsonlLines([
            JSON.stringify({
                v: 1,
                ts: 1,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'opencode',
                kind: 'tool-result',
                payload: { type: 'tool-result', callId: 'c1', output: { stdout: 'ok' } },
            }),
            JSON.stringify({
                v: 1,
                ts: 2,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'opencode',
                kind: 'tool-call',
                payload: { type: 'tool-call', callId: 'c1', name: 'read', input: { filePath: '/etc/hosts' } },
            }),
        ]);

        expect(Object.keys(fixtures.examples)).toEqual(
            expect.arrayContaining(['acp/opencode/tool-result/read'])
        );
    });

    it('keys tool-result events by tool name when only a permission-request exists (no tool-call)', () => {
        const fixtures = extractToolTraceFixturesFromJsonlLines([
            JSON.stringify({
                v: 1,
                ts: 1,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'gemini',
                kind: 'tool-result',
                payload: { type: 'tool-result', callId: 'c1', output: { status: 'failed' } },
            }),
            JSON.stringify({
                v: 1,
                ts: 2,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'gemini',
                kind: 'permission-request',
                payload: { type: 'permission-request', permissionId: 'c1', toolName: 'read', input: { file_path: '/etc/hosts' } },
            }),
        ]);

        expect(Object.keys(fixtures.examples)).toEqual(
            expect.arrayContaining(['acp/gemini/tool-result/read'])
        );
    });
});
