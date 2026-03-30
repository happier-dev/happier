import { createStorageModuleStub, createToolCallMessageFixture, renderHook } from '@/dev/testkit';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const message = createToolCallMessageFixture({
    id: 'tool-call-1',
    createdAt: 10,
    tool: {
        name: 'Diff',
        state: 'completed',
        input: {
            files: [
                {
                    file_path: 'src/app.ts',
                    oldText: 'a\n',
                    newText: 'b\n',
                    unified_diff: 'diff --git a/src/app.ts b/src/app.ts\n',
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
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSession: () => ({ metadata: {} }),
    useSessionMessages: () => ({
            messages: [message],
        }),
});
});

describe('useDerivedSessionChangeSet', () => {
    it('derives a session change set and provider diffs from canonical Diff messages', async () => {
        vi.resetModules();
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
