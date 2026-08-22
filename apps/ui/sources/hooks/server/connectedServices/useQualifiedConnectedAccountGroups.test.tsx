import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createDeferred,
    flushHookEffects,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

const createClientMock = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
    credentials: {
        token: 'token-a',
        secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));
vi.mock('@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource', async (
    importOriginal,
) => ({
    ...await importOriginal<
        typeof import('@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource')
    >(),
    createQualifiedConnectedAccountGroupsClient: createClientMock,
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

const policy = {
    v: 1 as const,
    strategy: 'least_limited' as const,
    autoSwitch: false,
    switchOn: {
        usageLimit: true,
        authExpired: true,
        accountChanged: true,
        refreshFailure: false,
    },
    cooldownMs: 30_000,
    honorProviderResetsAt: true,
    autoRestorePrimaryWhenReset: false,
    maxSwitchesPerTurn: 1,
    maxSwitchesPerSessionHour: 3,
    softSwitchRemainingPercent: 15,
    probeIfSnapshotOlderThanMs: 300_000,
    preTurnProbeMode: 'when_stale' as const,
    preTurnProbeOrder: 'current_first_then_candidates' as const,
    recoveryMode: 'switch_or_wait' as const,
    resumePromptMode: 'standard' as const,
};

function groupFor(
    service: Readonly<{ pluginId: string; localId: string }>,
    groupId: string,
) {
    return {
        ref: { service, groupId },
        displayName: groupId,
        policy,
        activeAccountId: null,
        revision: {
            protocol: 'v4' as const,
            incarnation: `group-row:${groupId}`,
            generation: 1,
            runtimeStateRevision: 1,
        },
        state: {},
        members: [],
    };
}

describe('useQualifiedConnectedAccountGroups', () => {
    beforeEach(() => {
        standardCleanup();
        createClientMock.mockReset();
    });

    it('does not expose service A groups while a changed server/service/auth basis loads or fails', async () => {
        const serviceA = { pluginId: 'acme.accounts', localId: 'a' };
        const serviceB = { pluginId: 'acme.accounts', localId: 'b' };
        const groupA = groupFor(serviceA, 'group-a');
        createClientMock.mockImplementation((params: Readonly<{
            service: typeof serviceA;
        }>) => params.service.localId === 'a'
            ? {
                list: vi.fn().mockResolvedValue([groupA]),
            }
            : {
                list: vi.fn().mockRejectedValue(
                    Object.assign(new Error('unavailable'), {
                        code: 'qualified_peer_unavailable',
                    }),
                ),
            });

        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(
            (params: Readonly<{
                serverId: string;
                service: typeof serviceA;
                peer: {
                    status: 'ready';
                    transport: { protocol: 'v4' };
                    errorCode: null;
                };
            }>) => useQualifiedConnectedAccountGroups(params),
            {
                initialProps: {
                    serverId: 'server-a',
                    service: serviceA,
                    peer: {
                        status: 'ready',
                        transport: { protocol: 'v4' },
                        errorCode: null,
                    },
                },
            },
        );
        await flushHookEffects();
        expect(hook.getCurrent().groups.map((group) => group.ref.groupId))
            .toEqual(['group-a']);

        authState.credentials = {
            token: 'token-b',
            secret: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        };
        const changed = await hook.rerender({
            serverId: 'server-b',
            service: serviceB,
            peer: {
                status: 'ready',
                transport: { protocol: 'v4' },
                errorCode: null,
            },
        });
        expect(changed.groups).toEqual([]);
        expect(changed.source).toEqual({ protocol: 'v4' });

        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'error',
            source: { protocol: 'v4' },
            groups: [],
        }));
    });

    it('never surfaces the raw peer error code as displayed copy', async () => {
        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service: { pluginId: 'acme.accounts', localId: 'a' },
            peer: {
                status: 'error',
                transport: null,
                errorCode: 'connected_account_daemon_unavailable',
            },
        }));
        await flushHookEffects();

        // The peer arm publishes a machine code; every other arm of this hook
        // already routes through the bounded presenter, so this one must too.
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'error',
            groups: [],
            error: 'connectedServices.errors.generic',
        }));
    });

    it('maps a known peer error code to its own bounded copy', async () => {
        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service: { pluginId: 'acme.accounts', localId: 'a' },
            peer: {
                status: 'error',
                transport: null,
                errorCode: 'connect_group_not_found',
            },
        }));
        await flushHookEffects();

        expect(hook.getCurrent().error)
            .toBe('connectedServices.errors.groupNotFound');
    });

    it('keeps the loaded pools visible while a refresh is in flight', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'a' };
        // The peer state must keep its identity across renders: the hook's load
        // basis is derived from it, and a new object per render would restart
        // the mount load instead of exercising refresh().
        const peer = {
            status: 'ready' as const,
            transport: { protocol: 'v4' as const },
            errorCode: null,
        };
        const groupA = groupFor(service, 'group-a');
        let releaseSecondList!: (groups: unknown[]) => void;
        const pendingList = new Promise<unknown[]>((resolve) => {
            releaseSecondList = resolve;
        });
        const list = vi.fn()
            .mockResolvedValueOnce([groupA])
            .mockReturnValueOnce(pendingList);
        createClientMock.mockReturnValue({ list });

        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service,
            peer,
        }));
        await flushHookEffects();
        expect(hook.getCurrent().groups.map((group) => group.ref.groupId))
            .toEqual(['group-a']);

        let refreshed!: Promise<void>;
        await act(async () => {
            refreshed = hook.getCurrent().refresh();
        });
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'loading',
            groups: [groupA],
        }));

        await act(async () => {
            releaseSecondList([groupA]);
            await refreshed;
        });
        await flushHookEffects();
        expect(hook.getCurrent().groups.map((group) => group.ref.groupId))
            .toEqual(['group-a']);
    });

    it('does not let an older initial list hide a newly created pool', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'a' };
        const peer = {
            status: 'ready' as const,
            transport: { protocol: 'v4' as const },
            errorCode: null,
        };
        const createdGroup = groupFor(service, 'group-created');
        const olderList = createDeferred<unknown[]>();
        const list = vi.fn(() => olderList.promise);
        const create = vi.fn().mockResolvedValue(createdGroup);
        createClientMock.mockReturnValue({ list, create });

        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service,
            peer,
        }));
        await flushHookEffects();
        expect(list).toHaveBeenCalledTimes(1);

        await act(async () => {
            await hook.getCurrent().create({
                groupId: createdGroup.ref.groupId,
                displayName: createdGroup.displayName,
            });
        });
        expect(hook.getCurrent().groups).toEqual([createdGroup]);

        await act(async () => {
            olderList.resolve([]);
            await olderList.promise;
        });
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'loaded',
            source: { protocol: 'v4' },
            groups: [createdGroup],
            error: null,
        }));
    });

    it('does not let an older refresh resurrect a deleted pool', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'a' };
        const peer = {
            status: 'ready' as const,
            transport: { protocol: 'v4' as const },
            errorCode: null,
        };
        const group = groupFor(service, 'group-a');
        const olderRefresh = createDeferred<unknown[]>();
        const list = vi.fn()
            .mockResolvedValueOnce([group])
            .mockReturnValueOnce(olderRefresh.promise);
        const deleteGroup = vi.fn().mockResolvedValue(undefined);
        createClientMock.mockReturnValue({ list, delete: deleteGroup });

        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service,
            peer,
        }));
        await flushHookEffects();
        expect(hook.getCurrent().groups).toEqual([group]);

        let refreshed!: Promise<void>;
        await act(async () => {
            refreshed = hook.getCurrent().refresh();
        });
        expect(list).toHaveBeenCalledTimes(2);

        await act(async () => {
            await hook.getCurrent().delete(group);
        });
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'loaded',
            groups: [],
        }));

        await act(async () => {
            olderRefresh.resolve([group]);
            await refreshed;
        });
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'loaded',
            source: { protocol: 'v4' },
            groups: [],
            error: null,
        }));
    });

    it('does not let a late pool mutation replace a newer list revision', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'a' };
        const peer = {
            status: 'ready' as const,
            transport: { protocol: 'v4' as const },
            errorCode: null,
        };
        const initial = groupFor(service, 'group-a');
        const newer = {
            ...initial,
            displayName: 'Current pool',
            revision: {
                protocol: 'v4' as const,
                generation: 2,
                runtimeStateRevision: 2,
            },
        };
        const olderMutationResult = {
            ...initial,
            displayName: 'Older pool name',
            revision: {
                protocol: 'v4' as const,
                generation: 2,
                runtimeStateRevision: 1,
            },
        };
        const mutation = createDeferred<typeof olderMutationResult>();
        const list = vi.fn()
            .mockResolvedValueOnce([initial])
            .mockResolvedValueOnce([newer]);
        const patch = vi.fn().mockReturnValue(mutation.promise);
        createClientMock.mockReturnValue({ list, patch });

        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service,
            peer,
        }));
        await flushHookEffects();

        let pendingMutation: Promise<unknown> = Promise.resolve(null);
        await act(async () => {
            pendingMutation = hook.getCurrent().patch({
                group: initial,
                displayName: 'Older pool name',
            });
        });
        await act(async () => {
            await hook.getCurrent().refresh();
        });
        expect(hook.getCurrent().groups).toEqual([newer]);

        let result: unknown;
        await act(async () => {
            mutation.resolve(olderMutationResult);
            result = await pendingMutation;
        });

        expect(result!).toBeNull();
        expect(hook.getCurrent().groups).toEqual([newer]);
    });

    it('does not let a late delete acknowledgement remove a recreated pool', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'a' };
        const peer = {
            status: 'ready' as const,
            transport: { protocol: 'v4' as const },
            errorCode: null,
        };
        const initial = {
            ...groupFor(service, 'group-a'),
            revision: {
                protocol: 'v4' as const,
                incarnation: 'original-group-row',
                generation: 0,
                runtimeStateRevision: 0,
            },
        };
        const recreated = {
            ...initial,
            displayName: 'Recreated pool',
            revision: {
                protocol: 'v4' as const,
                incarnation: 'recreated-group-row',
                generation: 0,
                runtimeStateRevision: 0,
            },
        };
        const deletion = createDeferred<void>();
        const list = vi.fn()
            .mockResolvedValueOnce([initial])
            .mockResolvedValueOnce([recreated]);
        const deleteGroup = vi.fn().mockReturnValue(deletion.promise);
        createClientMock.mockReturnValue({ list, delete: deleteGroup });

        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service,
            peer,
        }));
        await flushHookEffects();

        let pendingDeletion: Promise<unknown> = Promise.resolve(null);
        await act(async () => {
            pendingDeletion = hook.getCurrent().delete(initial);
        });
        await act(async () => {
            await hook.getCurrent().refresh();
        });
        expect(hook.getCurrent().groups).toEqual([recreated]);

        let deleted: unknown;
        await act(async () => {
            deletion.resolve();
            deleted = await pendingDeletion;
        });

        expect(deleted!).toBe(false);
        expect(hook.getCurrent().groups).toEqual([recreated]);
    });

    it('does not let a late active-account result replace a newer pool revision', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'a' };
        const peer = {
            status: 'ready' as const,
            transport: { protocol: 'v4' as const },
            errorCode: null,
        };
        const initial = groupFor(service, 'group-a');
        const newer = {
            ...initial,
            activeAccountId: 'account-b',
            revision: {
                protocol: 'v4' as const,
                generation: 2,
                runtimeStateRevision: 2,
            },
        };
        const olderMutationResult = {
            ...initial,
            activeAccountId: 'account-a',
            revision: {
                protocol: 'v4' as const,
                generation: 2,
                runtimeStateRevision: 1,
            },
        };
        const activeMutation = createDeferred<typeof olderMutationResult>();
        const list = vi.fn()
            .mockResolvedValueOnce([initial])
            .mockResolvedValueOnce([newer]);
        const setActiveAccount = vi.fn().mockReturnValue(activeMutation.promise);
        createClientMock.mockReturnValue({ list, setActiveAccount });

        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service,
            peer,
        }));
        await flushHookEffects();

        let pendingMutation: Promise<unknown> = Promise.resolve(null);
        await act(async () => {
            pendingMutation = hook.getCurrent().setActiveAccount({
                group: initial,
                account: { service, accountId: 'account-a' },
            });
        });
        await act(async () => {
            await hook.getCurrent().refresh();
        });
        expect(hook.getCurrent().groups).toEqual([newer]);

        let result: unknown;
        await act(async () => {
            activeMutation.resolve(olderMutationResult);
            result = await pendingMutation;
        });

        expect(result!).toBeNull();
        expect(hook.getCurrent().groups).toEqual([newer]);
    });
});
