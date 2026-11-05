import { describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createRenderCommitCounter, renderHook, useRenderCommitCounter } from '@/dev/testkit';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { act } from 'react-test-renderer';
import { isMachineReachable, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { publishMachineActivity } from '@/sync/domains/machines/machineActivity';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { storage } from '@/sync/domains/state/storageStore';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

const capabilityBoundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(capabilityBoundary.rpc);
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The package owns Reanimated's native SDK fixture. Keep Sync and capability
// decisions real; these projection-only cases never request a machine refresh.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Load the real Sync graph during suite collection, not inside the first
// behavioral test's budget; the mocked Socket boundary above remains installed.
await import('@/sync/syncEngine');
const { useNewSessionMachineRefreshState } = await import('./useNewSessionMachineRefreshState');

type UseNewSessionMachineRefreshState = typeof import('./useNewSessionMachineRefreshState').useNewSessionMachineRefreshState;
type HookParams = Parameters<UseNewSessionMachineRefreshState>[0];

function makeMachine(input: Readonly<{
    id: string;
    metadata?: Partial<NonNullable<Machine['metadata']>>;
}>): Machine {
    const base = createMachineFixture({ id: input.id });
    return {
        ...base,
        metadata: {
            ...(base.metadata ?? {}),
            ...(input.metadata ?? {}),
        } as NonNullable<Machine['metadata']>,
    };
}

function createSession(input: Readonly<{
    id: string;
    machineId: string;
    path: string;
    updatedAt?: number;
}>): Session {
    return {
        id: input.id,
        seq: 1,
        createdAt: 1,
        updatedAt: input.updatedAt ?? 1,
        active: true,
        activeAt: 1,
        metadata: {
            machineId: input.machineId,
            path: input.path,
            homeDir: '/Users/test',
            host: 'host.local',
            flavor: 'claude',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

async function renderMachineRefreshState(initialProps: HookParams) {
    return renderHook((props: HookParams) => useNewSessionMachineRefreshState(props), {
        initialProps,
    });
}

describe('useNewSessionMachineRefreshState', () => {
    it('prefetches wizard capabilities after retained Machine recovery without waking on heartbeats', async () => {
        const account = await restoreServerAccountForTest({ serverUrl: 'https://wizard-machine-recovery.test', accountId: 'wizard-account' });
        const machine = createMachineFixture({ id: 'wizard-recovered', active: false, activeAt: Date.now(), presenceProtocolVersion: 1 });
        storage.getState().applyMachines([machine], true, { sourceServerId: account.serverId });
        observeMachinePresenceForTest({ serverId: account.serverId, accountId: 'wizard-account' }, [machine.id]);
        const counter = createRenderCommitCounter();
        capabilityBoundary.rpc.mockResolvedValue({ protocolVersion: 1, results: {} });
        const params: HookParams = {
            capabilityServerId: account.serverId, selectedMachineId: machine.id, machines: [machine],
            recentMachinePaths: [], favoriteMachines: [], useEnhancedSessionWizard: true,
            refreshMachineEnvPresence: () => {}, sessions: [],
        };
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            const refresh = useNewSessionMachineRefreshState(params);
            const { binding } = useServerCredentialAccountScopeBinding(account.serverId);
            return { refresh, binding };
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().binding?.isCurrent()).toBe(true));
            expect(isMachineReachable(hook.getCurrent().binding!.scope, machine)).toBe(false);
            capabilityBoundary.rpc.mockClear();
            await act(async () => publishMachineActivity(machine, { active: true, activeAt: Date.now() + 1 }, []));
            expect(isMachineReachable(hook.getCurrent().binding!.scope, machine)).toBe(true);
            await vi.waitFor(() => expect(capabilityBoundary.rpc).toHaveBeenCalled());
            counter.reset();
            await act(async () => publishMachineActivity(machine, { active: true, activeAt: Date.now() + 2 }, []));
            expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        } finally {
            await hook.unmount();
            capabilityBoundary.rpc.mockReset();
            await account.dispose();
        }
    });

    it.each([
        { useEnhancedSessionWizard: false, focused: true },
        { useEnhancedSessionWizard: true, focused: false },
    ])('does not subscribe inactive wizard prefetch to fleet reachability (%j)', async demand => {
        const counter = createRenderCommitCounter();
        const params: HookParams = {
            ...demand,
            capabilityServerId: 'refresh-own-home', selectedMachineId: 'quiet-0',
            machines: Array.from({ length: 100 }, (_, index) => makeMachine({ id: `quiet-${index}` })),
            recentMachinePaths: [], favoriteMachines: [], sessions: [], refreshMachineEnvPresence: () => {},
        };
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useNewSessionMachineRefreshState(params);
        });
        try {
            counter.reset();
            for (let arrival = 0; arrival < 5; arrival += 1) {
                await act(async () => recordMachineRequestSucceeded({
                    serverId: 'refresh-foreign-home', accountId: 'refresh-foreign-account', machineId: `arrival-${arrival}`,
                }));
            }
            expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        } finally { await hook.unmount(); }
    });

    it('cancels a manual refresh on target change and retries on the next target', async () => {
        let signal: AbortSignal | undefined;
        capabilityBoundary.rpc.mockImplementationOnce((args: { signal?: AbortSignal }) => {
            signal = args.signal;
            return new Promise(() => {});
        });
        const initialProps: HookParams = {
            capabilityServerId: 'refresh-cancel-home', selectedMachineId: 'refresh-old-machine',
            machines: [makeMachine({ id: 'refresh-old-machine' }), makeMachine({ id: 'refresh-next-machine' })],
            recentMachinePaths: [], favoriteMachines: [], useEnhancedSessionWizard: false,
            refreshMachineEnvPresence: () => {}, sessions: [],
        };
        const hook = await renderMachineRefreshState(initialProps);
        await act(async () => { hook.getCurrent().refreshMachineData(); });
        await vi.waitFor(() => expect(signal).toBeDefined());
        await hook.rerender({ ...initialProps, selectedMachineId: 'refresh-next-machine' });
        expect(signal?.aborted).toBe(true);
        const { getMachineCapabilitiesCacheState } = await import('@/hooks/server/useMachineCapabilitiesCache');
        expect(getMachineCapabilitiesCacheState('refresh-old-machine', initialProps.capabilityServerId, 0)?.status).toBe('idle');
        capabilityBoundary.rpc.mockResolvedValueOnce({ protocolVersion: 1, results: {
            'tool.tmux': { ok: true, checkedAt: 1, data: { available: true } },
        } });
        await act(async () => { hook.getCurrent().refreshMachineData(); });
        await vi.waitFor(() => expect(getMachineCapabilitiesCacheState('refresh-next-machine', initialProps.capabilityServerId, 0)?.status).toBe('loaded'));
        await hook.unmount();
    });

    it('keeps recent and favorite machine arrays stable when only heartbeat changes', async () => {
        const machine = makeMachine({ id: 'machine-1', metadata: { homeDir: '/Users/test' } });
        const initialProps: HookParams = {
            capabilityServerId: 'server-a',
            selectedMachineId: 'machine-1',
            machines: [{ ...machine, activeAt: 100 }],
            recentMachinePaths: [
                { machineId: 'machine-1', path: '/Users/test/Development/lantern' },
            ],
            favoriteMachines: ['machine-1'],
            useEnhancedSessionWizard: false,
            refreshMachineEnvPresence: vi.fn(),
            sessions: [],
        };

        const hook = await renderMachineRefreshState(initialProps);
        const firstRecentMachines = hook.getCurrent().recentMachines;
        const firstFavoriteMachineItems = hook.getCurrent().favoriteMachineItems;

        await hook.rerender({
            ...initialProps,
            machines: [{ ...machine, activeAt: 200 }],
        });

        expect(hook.getCurrent().recentMachines).toBe(firstRecentMachines);
        expect(hook.getCurrent().favoriteMachineItems).toBe(firstFavoriteMachineItems);

        await hook.unmount();
    });

    it('includes previous session paths in the selected machine path suggestions', async () => {
        const initialProps = {
            capabilityServerId: 'server-a',
            selectedMachineId: 'machine-1',
            machines: [makeMachine({ id: 'machine-1', metadata: { homeDir: '/Users/test' } })],
            recentMachinePaths: [],
            favoriteMachines: [],
            useEnhancedSessionWizard: false,
            refreshMachineEnvPresence: vi.fn(),
            sessions: [
                createSession({
                    id: 'session-1',
                    machineId: 'machine-1',
                    path: '/Users/test/Development/atlas',
                    updatedAt: 25,
                }),
            ],
        };

        const hook = await renderMachineRefreshState(initialProps);

        expect(hook.getCurrent().recentPaths).toEqual(['/Users/test/Development/atlas']);

        await hook.unmount();
    });

    it('keeps previous path suggestions visible while session data is refreshing', async () => {
        const initialProps: HookParams = {
            capabilityServerId: 'server-a',
            selectedMachineId: 'machine-1',
            machines: [makeMachine({ id: 'machine-1', metadata: { homeDir: '/Users/test' } })],
            recentMachinePaths: [
                { machineId: 'machine-1', path: '/Users/test/Development/lantern' },
            ],
            favoriteMachines: [],
            useEnhancedSessionWizard: false,
            refreshMachineEnvPresence: vi.fn(),
            sessions: [
                createSession({
                    id: 'session-1',
                    machineId: 'machine-1',
                    path: '/Users/test/Development/atlas',
                    updatedAt: 25,
                }),
            ],
        };

        const hook = await renderMachineRefreshState(initialProps);

        expect(hook.getCurrent().recentPaths).toEqual([
            '/Users/test/Development/lantern',
            '/Users/test/Development/atlas',
        ]);

        await hook.rerender({
            ...initialProps,
            sessions: null,
        });

        expect(hook.getCurrent().recentPaths).toEqual([
            '/Users/test/Development/lantern',
            '/Users/test/Development/atlas',
        ]);

        await hook.unmount();
    });
});
