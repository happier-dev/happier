import { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
    SCM_OPERATION_ERROR_CODES,
} from '@happier-dev/protocol';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createScmNetworkTestHarness, scmNetworkSnapshot } from './scmNetworkTestHarness';

const modalMock = createModalModuleMock({ confirmResult: true });
vi.mock('@/modal', () => modalMock.module);
const harness = await createScmNetworkTestHarness();
const { renderHook, standardCleanup } = await import('@/dev/testkit');
const publishResponses = vi.fn();
const publishRequests = () => harness.network.requests.filter(request => request.method === RPC_METHODS.SCM_REMOTE_PUBLISH);

describe('usePublishBranchAction', () => {
    beforeEach(() => {
        harness.reset();
        publishResponses.mockReset();
        harness.network.setRpcResponder(async request => {
            if (request.method === RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK) return { success: true, removed: true, lockPath: '/repo/.git/index.lock' };
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE, error: 'status unavailable' };
            return await publishResponses();
        });
        modalMock.spies.confirm.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });
    afterAll(() => harness.dispose());

    it('does not allow publishing an untracked branch when no remote is configured', async () => {
        const { usePublishBranchAction } = await import('./usePublishBranchAction');
        const hook = await renderHook(() =>
            usePublishBranchAction({
                sessionId: 's1',
                serverId: harness.serverId,
                writeEnabled: true,
                disabled: false,
            snapshot: {
                    ...scmNetworkSnapshot,
                    repo: { ...scmNetworkSnapshot.repo, remotes: [] },
                    branch: { ...scmNetworkSnapshot.branch, upstream: null },
                },
            }),
        );

        expect(hook.getCurrent().canPublish).toBe(false);

        await act(async () => {
            await expect(hook.getCurrent().publishBranch()).resolves.toBe(false);
        });

        expect(publishRequests()).toHaveLength(0);
    });

    it('normalizes session ids and publishes to origin before invalidating branch state', async () => {
        publishResponses.mockResolvedValue({ success: true });

        const { usePublishBranchAction } = await import('./usePublishBranchAction');
        const hook = await renderHook(() =>
            usePublishBranchAction({
                sessionId: '  s1  ',
                serverId: harness.serverId,
                writeEnabled: true,
                disabled: false,
                snapshot: {
                    ...scmNetworkSnapshot,
                    repo: {
                        ...scmNetworkSnapshot.repo,
                        remotes: [
                            { name: 'upstream', fetchUrl: 'git@example.com:upstream.git' },
                            { name: 'origin', fetchUrl: 'git@example.com:origin.git' },
                        ],
                    },
                    branch: { ...scmNetworkSnapshot.branch, upstream: null },
                },
            }),
        );

        expect(hook.getCurrent().canPublish).toBe(true);

        await act(async () => {
            await expect(hook.getCurrent().publishBranch()).resolves.toBe(true);
        });

        expect(publishRequests()).toEqual([expect.objectContaining({ targetId: 'machine-1', payload: expect.objectContaining({ remote: 'origin', cwd: '/repo' }) })]);
        expect(harness.network.requests.some(request => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toBe(true);
    });

    it('publishes to the first configured remote when origin is unavailable', async () => {
        publishResponses.mockResolvedValue({ success: true });

        const { usePublishBranchAction } = await import('./usePublishBranchAction');
        const hook = await renderHook(() =>
            usePublishBranchAction({
                sessionId: 's1',
                serverId: harness.serverId,
                writeEnabled: true,
                disabled: false,
                snapshot: {
                    ...scmNetworkSnapshot,
                    repo: {
                        ...scmNetworkSnapshot.repo,
                        remotes: [{ name: 'upstream', fetchUrl: 'git@example.com:upstream.git' }],
                    },
                    branch: { ...scmNetworkSnapshot.branch, upstream: null },
                },
            }),
        );

        await act(async () => {
            await expect(hook.getCurrent().publishBranch()).resolves.toBe(true);
        });

        expect(publishRequests()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ remote: 'upstream' }) })]);
    });

    it('offers stale Git index-lock recovery and retries branch publish once', async () => {
        publishResponses
            .mockResolvedValueOnce({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            })
            .mockResolvedValueOnce({ success: true });

        const { usePublishBranchAction } = await import('./usePublishBranchAction');
        const hook = await renderHook(() =>
            usePublishBranchAction({
                sessionId: 's1',
                serverId: harness.serverId,
                writeEnabled: true,
                disabled: false,
                snapshot: {
                    ...scmNetworkSnapshot,
                    repo: {
                        ...scmNetworkSnapshot.repo,
                        remotes: [{ name: 'origin', fetchUrl: 'git@example.com:origin.git' }],
                    },
                    branch: { ...scmNetworkSnapshot.branch, upstream: null },
                },
            }),
        );

        await act(async () => {
            await expect(hook.getCurrent().publishBranch()).resolves.toBe(true);
        });

        expect(modalMock.spies.confirm).toHaveBeenCalledTimes(1);
        expect(harness.network.requests.find(request => request.method === RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK)).toMatchObject({ targetId: 'machine-1', payload: {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN,
        } });
        expect(publishRequests()).toHaveLength(2);
        expect(harness.network.requests.some(request => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toBe(true);
    });
});
