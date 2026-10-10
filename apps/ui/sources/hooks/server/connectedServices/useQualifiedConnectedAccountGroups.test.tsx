import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQualifiedConnectedAccountGroups, type UseQualifiedConnectedAccountGroupsResult } from './useQualifiedConnectedAccountGroups';

import {
    createDeferred,
    flushHookEffects,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

const createClientMock = vi.hoisted(() => vi.fn());
const serverFetchMock = vi.hoisted(() => vi.fn());
// HTTP is the external boundary; the race regression uses the real client below it.
vi.mock('@/sync/http/client', () => ({ serverFetch: serverFetchMock }));
// Pool hooks render no Markdown; fail if this unavailable third-party export is used.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in pool hook'); },
}));
// Pool hooks do not invoke Session/Team envelope HTTP APIs. Keep unrelated
// transport imports isolated without replacing any encryption/domain logic.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected Session envelope API in pool hook'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
vi.mock('@/sync/api/teams/membershipSessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Unexpected Team envelope API in pool hook'); };
    return { createMembershipSessionDataKeyEnvelopeClient: unused, prepareMembershipHistoryEnvelopesForScope: unused,
        prepareMembershipHistoryEnvelopesDetached: unused, membershipHistoryPreparationScopeKey: unused };
});
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

function wireGroupFor(group: ReturnType<typeof groupFor>) {
    return { v: 1, ref: group.ref, displayName: group.displayName, policy: group.policy,
        incarnation: group.revision.incarnation, generation: group.revision.generation,
        runtimeStateRevision: group.revision.runtimeStateRevision, activeConnectedAccountId: group.activeAccountId,
        state: group.state, createdAt: 0, updatedAt: 0, members: [] };
}

async function useRealHttpClient() {
    const { createQualifiedConnectedAccountGroupsClient } = await vi.importActual<
        typeof import('@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource')
    >('@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource');
    createClientMock.mockImplementation(createQualifiedConnectedAccountGroupsClient);
}

describe('useQualifiedConnectedAccountGroups', () => {
    beforeEach(() => {
        standardCleanup();
        createClientMock.mockReset();
        serverFetchMock.mockReset();
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
            error: 'connectedServices.errors.accountMachineUnavailable',
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

    it('does not select the removed V3 group client for a revisioned legacy peer', async () => {
        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            peer: {
                status: 'ready',
                transport: {
                    protocol: 'legacy',
                    peerClass: 'revisioned-v2-v3',
                    legacyServiceId: 'openai-codex',
                },
                errorCode: null,
            },
        }));
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'unsupported',
            source: null,
            groups: [],
        }));
        expect(createClientMock).not.toHaveBeenCalled();
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
        const olderList = createDeferred<Response>();
        let firstList = true;
        const wireCreatedGroup = wireGroupFor(createdGroup);
        let currentGroups: typeof wireCreatedGroup[] = [];
        await useRealHttpClient();
        serverFetchMock.mockImplementation(async (_path: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                currentGroups = [wireCreatedGroup];
                return new Response(JSON.stringify({ group: wireCreatedGroup }), { status: 200 });
            }
            if (firstList) { firstList = false; return olderList.promise; }
            return new Response(JSON.stringify({ groups: currentGroups }), { status: 200 });
        });

        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service,
            peer,
        }));
        await flushHookEffects();

        await act(async () => {
            await hook.getCurrent().create({
                groupId: createdGroup.ref.groupId,
                displayName: createdGroup.displayName,
            });
        });
        expect(hook.getCurrent().groups.map(({ ref }) => ref)).toEqual([createdGroup.ref]);

        await act(async () => {
            olderList.resolve(new Response(JSON.stringify({ groups: [] }), { status: 200 }));
            await olderList.promise;
        });
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'loaded',
            source: { protocol: 'v4' },
            groups: [expect.objectContaining({ ref: createdGroup.ref })],
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
        const olderRefresh = createDeferred<Response>();
        const wireGroup = wireGroupFor(group);
        let currentGroups = [wireGroup];
        let listNumber = 0;
        await useRealHttpClient();
        serverFetchMock.mockImplementation(async (_path: string, init?: RequestInit) => {
            if (init?.method === 'DELETE') {
                currentGroups = [];
                return new Response(JSON.stringify({ success: true }), { status: 200 });
            }
            if (++listNumber === 2) return olderRefresh.promise;
            return new Response(JSON.stringify({ groups: currentGroups }), { status: 200 });
        });

        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(() => useQualifiedConnectedAccountGroups({
            serverId: 'server-a',
            service,
            peer,
        }));
        await flushHookEffects();
        expect(hook.getCurrent().groups.map(({ ref }) => ref)).toEqual([group.ref]);

        let refreshed!: Promise<void>;
        await act(async () => {
            refreshed = hook.getCurrent().refresh();
        });

        await act(async () => {
            await hook.getCurrent().delete(group);
        });
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'loaded',
            groups: [],
        }));

        await act(async () => {
            olderRefresh.resolve(new Response(JSON.stringify({ groups: [wireGroup] }), { status: 200 }));
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

    it('accepts deletion when a same-Account refresh already confirms the pool is absent', async () => {
        const service = { pluginId: 'acme.accounts', localId: 'a' };
        const peer = { status: 'ready' as const, transport: { protocol: 'v4' as const }, errorCode: null };
        // Keep the real client, its wire parsing and revision normalization; substitute HTTP only.
        await useRealHttpClient();
        const deleted = createDeferred<Response>();
        const wireGroup = { v: 1, ref: { service, groupId: 'group-a' }, displayName: 'Team', policy,
            incarnation: 'group-row:group-a', generation: 1, runtimeStateRevision: 1,
            activeConnectedAccountId: null, state: {}, createdAt: 0, updatedAt: 0, members: [] };
        let groups = [wireGroup];
        serverFetchMock.mockImplementation(async (_path: string, init?: RequestInit) => {
            if (init?.method === 'DELETE') return deleted.promise;
            return new Response(JSON.stringify({ groups }), { status: 200 });
        });
        try {
            const hook = await renderHook(() => useQualifiedConnectedAccountGroups({ serverId: 'server-a', service, peer }));
            await flushHookEffects();
            const group = hook.getCurrent().groups[0]!;
            let pending: ReturnType<UseQualifiedConnectedAccountGroupsResult['delete']> = Promise.resolve(false);
            await act(async () => { pending = hook.getCurrent().delete(group); });
            groups = [];
            await act(async () => { await hook.getCurrent().refresh(); });
            expect(hook.getCurrent().groups).toEqual([]);
            let result: Awaited<ReturnType<UseQualifiedConnectedAccountGroupsResult['delete']>> = false;
            await act(async () => {
                deleted.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
                result = await pending;
            });
            expect(result).toMatchObject({ applied: true });
            expect(hook.getCurrent().groups).toEqual([]);
        } finally {
            serverFetchMock.mockReset();
        }
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
