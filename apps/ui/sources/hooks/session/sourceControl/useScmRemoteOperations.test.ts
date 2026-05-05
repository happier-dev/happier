import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    createModalModuleMock,
    createStorageModuleStub,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

const {
    sessionScmRemotePush,
    invalidateFromMutationAndAwait,
    loadCommitHistory,
    refreshScmData,
} = vi.hoisted(() => ({
    sessionScmRemotePush: vi.fn(async () => ({ success: true, stdout: 'pushed' })),
    invalidateFromMutationAndAwait: vi.fn(async () => {}),
    loadCommitHistory: vi.fn(async () => {}),
    refreshScmData: vi.fn(async () => {}),
}));

const storageMock = createStorageModuleStub({});
const modalMock = createModalModuleMock({ confirmResult: true });

vi.mock('@/sync/ops', () => ({
    sessionScmRemoteFetch: vi.fn(async () => ({ success: true, stdout: 'fetched' })),
    sessionScmRemotePull: vi.fn(async () => ({ success: true, stdout: 'pulled' })),
    sessionScmRemotePush,
}));

vi.mock('@/sync/domains/state/storage', () => storageMock);
vi.mock('@/modal', () => modalMock.module);

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait,
    },
}));

vi.mock('@/scm/core/operationPolicy', () => ({
    evaluateScmOperationPreflight: () => ({ allowed: true }),
}));

vi.mock('@/scm/operations/remoteTarget', () => ({
    inferRemoteTargetFromSnapshot: () => ({ remote: 'origin', branch: 'main' }),
}));

vi.mock('@/scm/operations/withOperationLock', () => ({
    withSessionProjectScmOperationLock: async ({ run }: { run: () => Promise<void> }) => {
        await run();
        return { started: true };
    },
}));

vi.mock('@/scm/operations/reporting', () => ({
    reportSessionScmOperation: vi.fn(),
    trackBlockedScmOperation: vi.fn(),
}));

vi.mock('@/track', () => ({
    tracking: {},
}));

vi.mock('@/scm/operations/scmDaemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForScmOperationFailure: () => false,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useScmRemoteOperations', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('can run push through the canonical remote hook without confirmation when requested', async () => {
        const { useScmRemoteOperations } = await import('./useScmRemoteOperations');
        const hook = await renderHook(() => useScmRemoteOperations({
            sessionId: 'session-1',
            sessionPath: '/repo',
            scmSnapshot: null,
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        }));

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push', { skipConfirmation: true });
        });

        expect(modalMock.spies.confirm).not.toHaveBeenCalled();
        expect(sessionScmRemotePush).toHaveBeenCalledWith('session-1', {
            remote: 'origin',
            branch: 'main',
        });
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledWith('session-1');
        expect(loadCommitHistory).toHaveBeenCalledWith({ reset: true });
    });
});
