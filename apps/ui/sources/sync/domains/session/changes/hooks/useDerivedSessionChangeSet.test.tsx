import { createStorageModuleStub, createToolCallMessageFixture, renderHook } from '@/dev/testkit';
import { makeToolCall } from '@/dev/testkit/harness/toolViewTestHelpers';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/state/storage', async () => {
    const message = createToolCallMessageFixture({
        id: 'tool_1',
        createdAt: 10,
        tool: makeToolCall({
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
            completedAt: 11,
        }),
    });
    return createStorageModuleStub({
        useSession: () => ({ metadata: {} }),
        useSessionMessages: () => ({
            messages: [message],
        }),
    });
});

describe('useDerivedSessionChangeSet', () => {
    it('derives a session change set and provider diffs from canonical Diff messages', async () => {
        const { useDerivedSessionChangeSet } = await import('./useDerivedSessionChangeSet');
        const { getCurrent } = await renderHook(() => useDerivedSessionChangeSet('session_1'));
        const current = getCurrent();

        expect(current.sessionChangeSet).toEqual(expect.objectContaining({
            sessionId: 'session_1',
            turns: [expect.objectContaining({ turnId: 'turn_1' })],
        }));
        expect(current.latestTurnChangeSet?.turnId).toBe('turn_1');
        const providerDiffMap = current.providerDiffByPath;
        expect(providerDiffMap).toBeInstanceOf(Map);
        if (!providerDiffMap) {
            throw new Error('Expected provider diff map');
        }
        expect(providerDiffMap.get('src/app.ts')).toContain('diff --git a/src/app.ts b/src/app.ts');
    });
});
