import { describe, expect, it } from 'vitest';
import { curateToolTraceFixturesFromJsonlLines } from './curateToolTraceFixtures';

describe('curateToolTraceFixturesFromJsonlLines', () => {
    it('prefers higher-signal examples and obeys maxExamplesPerKey', () => {
        const fixtures = curateToolTraceFixturesFromJsonlLines([
            JSON.stringify({
                v: 1,
                ts: 1,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'opencode',
                kind: 'tool-call',
                payload: { type: 'tool-call', name: 'read', input: {} },
            }),
            JSON.stringify({
                v: 1,
                ts: 2,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'opencode',
                kind: 'tool-call',
                payload: { type: 'tool-call', name: 'read', input: { file_path: '/etc/hosts' } },
            }),
            JSON.stringify({
                v: 1,
                ts: 3,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'opencode',
                kind: 'tool-call',
                payload: { type: 'tool-call', name: 'read', input: { file_path: '/etc/hosts', limit: 3 } },
            }),
        ], { maxExamplesPerKey: 2 });

        const key = 'acp/opencode/tool-call/read';
        expect(fixtures.examples[key]).toHaveLength(2);
        // The empty-input example should be dropped when maxExamplesPerKey=2.
        expect((fixtures.examples[key][0] as any).payload.input).toEqual(expect.objectContaining({ file_path: '/etc/hosts' }));
        expect((fixtures.examples[key][1] as any).payload.input).toEqual(expect.objectContaining({ file_path: '/etc/hosts' }));
    });

    it('can filter by allowlist keys', () => {
        const fixtures = curateToolTraceFixturesFromJsonlLines([
            JSON.stringify({
                v: 1,
                ts: 1,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'opencode',
                kind: 'tool-call',
                payload: { type: 'tool-call', name: 'read', input: { file_path: '/etc/hosts' } },
            }),
            JSON.stringify({
                v: 1,
                ts: 2,
                direction: 'outbound',
                sessionId: 's1',
                protocol: 'acp',
                provider: 'opencode',
                kind: 'tool-call',
                payload: { type: 'tool-call', name: 'execute', input: { command: 'echo hi' } },
            }),
        ], { allowlistKeys: new Set(['acp/opencode/tool-call/read']) });

        expect(Object.keys(fixtures.examples)).toEqual(['acp/opencode/tool-call/read']);
    });
});
