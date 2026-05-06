import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
    SCM_OPERATION_ERROR_CODES,
} from '@happier-dev/protocol';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';

const sessionScmRemotePublishSpy = vi.fn();
const sessionScmRepositoryRemoveIndexLockSpy = vi.fn();
const invalidateFromMutationAndAwaitSpy = vi.fn();

vi.mock('@/sync/ops', () => ({
    sessionScmRemotePublish: (...args: unknown[]) => sessionScmRemotePublishSpy(...args),
    sessionScmRepositoryRemoveIndexLock: (...args: unknown[]) => sessionScmRepositoryRemoveIndexLockSpy(...args),
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: (...args: unknown[]) => invalidateFromMutationAndAwaitSpy(...args),
    },
}));

const modalMock = createModalModuleMock({ confirmResult: true });
vi.mock('@/modal', () => modalMock.module);

describe('usePublishBranchAction', () => {
    beforeEach(() => {
        sessionScmRemotePublishSpy.mockReset();
        sessionScmRepositoryRemoveIndexLockSpy.mockReset();
        sessionScmRepositoryRemoveIndexLockSpy.mockResolvedValue({
            success: true,
            removed: true,
            lockPath: '/repo/.git/index.lock',
        });
        invalidateFromMutationAndAwaitSpy.mockReset();
        modalMock.spies.confirm.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('does not allow publishing an untracked branch when no remote is configured', async () => {
        const { usePublishBranchAction } = await import('./usePublishBranchAction');
        const hook = await renderHook(() =>
            usePublishBranchAction({
                sessionId: 's1',
                writeEnabled: true,
                disabled: false,
            snapshot: {
                    capabilities: { writeRemotePublish: true },
                    repo: { isRepo: true, rootPath: '/repo', remotes: [] },
                    branch: { detached: false, head: 'main', upstream: null },
                } as any,
            }),
        );

        expect(hook.getCurrent().canPublish).toBe(false);

        await act(async () => {
            await expect(hook.getCurrent().publishBranch()).resolves.toBe(false);
        });

        expect(sessionScmRemotePublishSpy).not.toHaveBeenCalled();
    });

    it('normalizes session ids and publishes to origin before invalidating branch state', async () => {
        sessionScmRemotePublishSpy.mockResolvedValue({ success: true });
        invalidateFromMutationAndAwaitSpy.mockResolvedValue(undefined);

        const { usePublishBranchAction } = await import('./usePublishBranchAction');
        const hook = await renderHook(() =>
            usePublishBranchAction({
                sessionId: '  s1  ',
                writeEnabled: true,
                disabled: false,
                snapshot: {
                    capabilities: { writeRemotePublish: true },
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        remotes: [
                            { name: 'upstream', fetchUrl: 'git@example.com:upstream.git' },
                            { name: 'origin', fetchUrl: 'git@example.com:origin.git' },
                        ],
                    },
                    branch: { detached: false, head: 'main', upstream: null },
                } as any,
            }),
        );

        expect(hook.getCurrent().canPublish).toBe(true);

        await act(async () => {
            await expect(hook.getCurrent().publishBranch()).resolves.toBe(true);
        });

        expect(sessionScmRemotePublishSpy).toHaveBeenCalledWith('s1', { remote: 'origin' });
        expect(invalidateFromMutationAndAwaitSpy).toHaveBeenCalledWith('s1');
    });

    it('publishes to the first configured remote when origin is unavailable', async () => {
        sessionScmRemotePublishSpy.mockResolvedValue({ success: true });
        invalidateFromMutationAndAwaitSpy.mockResolvedValue(undefined);

        const { usePublishBranchAction } = await import('./usePublishBranchAction');
        const hook = await renderHook(() =>
            usePublishBranchAction({
                sessionId: 's1',
                writeEnabled: true,
                disabled: false,
                snapshot: {
                    capabilities: { writeRemotePublish: true },
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        remotes: [{ name: 'upstream', fetchUrl: 'git@example.com:upstream.git' }],
                    },
                    branch: { detached: false, head: 'main', upstream: null },
                } as any,
            }),
        );

        await act(async () => {
            await expect(hook.getCurrent().publishBranch()).resolves.toBe(true);
        });

        expect(sessionScmRemotePublishSpy).toHaveBeenCalledWith('s1', { remote: 'upstream' });
    });

    it('offers stale Git index-lock recovery and retries branch publish once', async () => {
        sessionScmRemotePublishSpy
            .mockResolvedValueOnce({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            })
            .mockResolvedValueOnce({ success: true });
        invalidateFromMutationAndAwaitSpy.mockResolvedValue(undefined);

        const { usePublishBranchAction } = await import('./usePublishBranchAction');
        const hook = await renderHook(() =>
            usePublishBranchAction({
                sessionId: 's1',
                writeEnabled: true,
                disabled: false,
                snapshot: {
                    capabilities: { writeRemotePublish: true },
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        remotes: [{ name: 'origin', fetchUrl: 'git@example.com:origin.git' }],
                    },
                    branch: { detached: false, head: 'main', upstream: null },
                } as any,
            }),
        );

        await act(async () => {
            await expect(hook.getCurrent().publishBranch()).resolves.toBe(true);
        });

        expect(modalMock.spies.confirm).toHaveBeenCalledTimes(1);
        expect(sessionScmRepositoryRemoveIndexLockSpy).toHaveBeenCalledWith('s1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
        });
        expect(sessionScmRemotePublishSpy).toHaveBeenCalledTimes(2);
        expect(invalidateFromMutationAndAwaitSpy).toHaveBeenCalledWith('s1');
    });
});
