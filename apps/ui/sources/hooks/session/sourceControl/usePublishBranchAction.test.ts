import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';

const sessionScmRemotePublishSpy = vi.fn();
const invalidateFromMutationAndAwaitSpy = vi.fn();

vi.mock('@/sync/ops', () => ({
    sessionScmRemotePublish: (...args: unknown[]) => sessionScmRemotePublishSpy(...args),
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: (...args: unknown[]) => invalidateFromMutationAndAwaitSpy(...args),
    },
}));

const modalMock = createModalModuleMock();
vi.mock('@/modal', () => modalMock.module);

describe('usePublishBranchAction', () => {
    beforeEach(() => {
        sessionScmRemotePublishSpy.mockReset();
        invalidateFromMutationAndAwaitSpy.mockReset();
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
                    repo: { isRepo: true, remotes: [] },
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
});
