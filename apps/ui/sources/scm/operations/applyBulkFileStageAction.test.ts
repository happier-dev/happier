import { beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { installScmOperationsCommonModuleMocks } from './scmOperationsTestHelpers';

const sessionScmChangeInclude = vi.hoisted(() => vi.fn());
const sessionScmChangeExclude = vi.hoisted(() => vi.fn());
const invalidateFromMutationAndAwait = vi.hoisted(() => vi.fn(async () => {}));
const withSessionProjectScmOperationLock = vi.hoisted(() => vi.fn(async (input: any) => {
    await input.run();
    return { started: true, message: '' };
}));
const evaluateScmOperationPreflight = vi.hoisted(() => vi.fn(() => ({ allowed: true, message: '' })));

vi.mock('@/sync/ops', () => ({
    sessionScmChangeInclude,
    sessionScmChangeExclude,
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait,
    },
}));

vi.mock('@/scm/operations/withOperationLock', () => ({
    withSessionProjectScmOperationLock,
}));

vi.mock('@/scm/core/operationPolicy', () => ({
    evaluateScmOperationPreflight,
}));

installScmOperationsCommonModuleMocks();

describe('applyBulkFileStageAction', () => {
    const initialStorageState = storage.getState();

    function createSession(sessionId: string, workspacePath: string) {
        const now = Date.now();
        return {
            id: sessionId,
            seq: 1,
            createdAt: now,
            updatedAt: now,
            active: true,
            activeAt: now,
            metadata: {
                machineId: 'machine-1',
                path: workspacePath,
                host: 'localhost',
                version: '1.0.0',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
            optimisticThinkingAt: null,
        };
    }

    beforeEach(() => {
        storage.setState(initialStorageState, true);
        sessionScmChangeInclude.mockReset();
        sessionScmChangeExclude.mockReset();
        invalidateFromMutationAndAwait.mockReset();
        withSessionProjectScmOperationLock.mockClear();
        evaluateScmOperationPreflight.mockClear();
    });

    it('marks atomic commit selection paths without invoking SCM RPC operations', async () => {
        const { applyBulkFileStageAction } = await import('./applyBulkFileStageAction');

        const state = storage.getState();
        type StoredSession = Parameters<typeof state.applySessions>[0][number];
        state.applySessions([createSession('s1', '/tmp') as unknown as StoredSession]);

        await applyBulkFileStageAction({
            sessionId: 's1',
            sessionPath: '/tmp',
            snapshot: null,
            scmWriteEnabled: true,
            commitStrategy: 'atomic',
            stage: true,
            paths: ['a.txt', 'b.txt'],
            surface: 'files',
        });

        expect(storage.getState().getSessionProjectScmCommitSelectionPaths('s1').sort()).toEqual(['a.txt', 'b.txt']);
        expect(sessionScmChangeInclude).not.toHaveBeenCalled();
        expect(sessionScmChangeExclude).not.toHaveBeenCalled();
    });

    it('invokes a single include/exclude RPC for non-atomic strategies', async () => {
        sessionScmChangeInclude.mockResolvedValueOnce({ success: true });

        const { applyBulkFileStageAction } = await import('./applyBulkFileStageAction');

        await applyBulkFileStageAction({
            sessionId: 's1',
            sessionPath: '/tmp',
            snapshot: null,
            scmWriteEnabled: true,
            commitStrategy: 'git_staging',
            stage: true,
            paths: ['a.txt', 'a.txt', 'b.txt'],
            surface: 'files',
        });

        expect(sessionScmChangeInclude).toHaveBeenCalledTimes(1);
        expect(sessionScmChangeInclude).toHaveBeenCalledWith('s1', { paths: ['a.txt', 'b.txt'] });
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledTimes(1);
    });
});
