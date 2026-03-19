import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => ({ metadata: {} }),
    useSessionMessages: () => ({
        messages: [
            {
                kind: 'tool-call',
                id: 'tool_1',
                localId: null,
                createdAt: 10,
                tool: {
                    name: 'Diff',
                    state: 'completed',
                    input: {
                        files: [
                            {
                                file_path: 'src/app.ts',
                                unified_diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
                            },
                        ],
                        _happier: {
                            v: 2,
                            protocol: 'codex',
                            provider: 'codex',
                            rawToolName: 'CodexDiff',
                            canonicalToolName: 'Diff',
                            sessionChangeScope: 'turn',
                            turnId: 'turn_1',
                            sessionId: 'session_1',
                            source: 'provider_native',
                            confidence: 'exact',
                            turnStatus: 'completed',
                            seqRange: {
                                startSeqInclusive: 1,
                                endSeqInclusive: 4,
                            },
                        },
                    },
                    createdAt: 10,
                    startedAt: 10,
                    completedAt: 11,
                    description: null,
                    result: { status: 'completed' },
                },
                children: [],
            },
        ],
    }),
}));

describe('useDerivedSessionChangeSet', () => {
    it('derives a session change set and provider diffs from canonical Diff messages', async () => {
        const { useDerivedSessionChangeSet } = await import('./useDerivedSessionChangeSet');

        let currentSessionChangeSet: unknown = null;
        let currentLatestTurnId: string | null = null;
        let currentProviderDiffByPath: unknown = null;

        function Probe() {
            const current = useDerivedSessionChangeSet('session_1');
            currentSessionChangeSet = current.sessionChangeSet;
            currentLatestTurnId = current.latestTurnChangeSet?.turnId ?? null;
            currentProviderDiffByPath = current.providerDiffByPath;
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
        });

        expect(currentSessionChangeSet).toEqual(expect.objectContaining({
            sessionId: 'session_1',
            turns: [expect.objectContaining({ turnId: 'turn_1' })],
        }));
        expect(currentLatestTurnId).toBe('turn_1');
        const providerDiffMap = currentProviderDiffByPath as ReadonlyMap<string, string> | null;
        expect(providerDiffMap).toBeInstanceOf(Map);
        if (!providerDiffMap) {
            throw new Error('Expected provider diff map');
        }
        expect(providerDiffMap.get('src/app.ts')).toContain('diff --git a/src/app.ts b/src/app.ts');
    });
});
