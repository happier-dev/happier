import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

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

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
    },
}));

describe('usePublishBranchAction', () => {
    beforeEach(() => {
        sessionScmRemotePublishSpy.mockReset();
        invalidateFromMutationAndAwaitSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes session ids before publishing and invalidating branch state', async () => {
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
                    repo: { isRepo: true },
                    branch: { detached: false, head: 'main', upstream: null },
                } as any,
            }),
        );

        expect(hook.getCurrent().canPublish).toBe(true);

        await act(async () => {
            await expect(hook.getCurrent().publishBranch()).resolves.toBe(true);
        });

        expect(sessionScmRemotePublishSpy).toHaveBeenCalledWith('s1', {});
        expect(invalidateFromMutationAndAwaitSpy).toHaveBeenCalledWith('s1');
    });
});
