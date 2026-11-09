import * as React from 'react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { act, createDeferred, createMachineFixture, renderHook, renderScreen } from '@/dev/testkit';
import type { CapabilitiesDetectRequest, CapabilitiesDetectResponse } from '@/sync/api/capabilities/capabilitiesProtocol';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});

import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { UpdateFactsBackgroundRuntime } from './UpdateFactsBackgroundRuntime';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { useMachinesCapabilitySnapshots } from './machineCapabilitySnapshots';
import { refreshMachineUpdateFacts } from './machineUpdateRuns';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';

afterEach(() => boundary.rpc.mockReset());

describe('Updates cold fleet capability demand', () => {
    it('keeps cold update discovery across unchanged registry invalidations and refreshes real install changes once', async () => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const accountId = 'capversion-global';
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailability = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        let machine = createMachineFixture({ id: 'capversion-global', active: true, activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } });
        storage.setState({ profileScope: { serverId, accountId }, machines: { [machine.id]: machine },
            machineListByServerId: { [serverId]: [machine] } });
        let installedVersion = '1.0.0';
        boundary.rpc.mockImplementation(async ({ payload }: { payload: CapabilitiesDetectRequest }): Promise<CapabilitiesDetectResponse> => ({
            protocolVersion: 1,
            results: Object.fromEntries((payload.requests ?? []).map(({ id }) => [id, { ok: true, checkedAt: Date.now(),
                data: id.startsWith('cli.') ? { available: machine.metadata?.agentInventory?.installedAgentIds.includes(id.slice(4)) ?? false,
                    version: id === 'cli.codex' ? installedVersion : '1.0.0',
                    installSource: 'managed', updateSupported: true, latestVersion: '3.0.0' }
                    : id === 'tool.systemTasks' ? { kinds: [] }
                    : { installed: false, installedVersion: null, sourceKind: 'managed', latestVersionCheck: { ok: true, latestVersion: null } },
            }])),
        }));
        const snapshots = await renderHook(() => useMachinesCapabilitySnapshots(serverId, [machine.id], accountId));
        const screen = await renderScreen(<><UpdateFactsBackgroundRuntime enabled /><UpdateFactsBackgroundRuntime enabled /></>);
        const updateDetects = () => boundary.rpc.mock.calls.filter(([request]) =>
            (request.payload as CapabilitiesDetectRequest).requests?.some(item => item.id === 'tool.systemTasks')).length;
        try {
            await vi.waitFor(() => expect(snapshots.getCurrent().get(machine.id)?.response.results['cli.codex'])
                .toMatchObject({ data: { version: '1.0.0', latestVersion: '3.0.0' } }));
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            for (let invalidation = 0; invalidation < 12; invalidation++) await act(async () => {
                publishMachineContributionRegistryProjectionInvalidation({ serverId, machineId: machine.id }, 'authority');
            });
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            // Machine-kind wakes publish full rows as well as liveness. Neither
            // carrier versions nor a refreshed inventory timestamp is an install.
            for (let wake = 0; wake < 12; wake++) await act(async () => {
                machine = { ...machine, seq: machine.seq + 1, updatedAt: machine.updatedAt + 1,
                    metadataVersion: machine.metadataVersion + 1, daemonStateVersion: machine.daemonStateVersion + 1,
                    metadata: { ...machine.metadata!, agentInventory: { checkedAt: wake + 10, installedAgentIds: ['codex'] } },
                    daemonState: { ...machine.daemonState, status: 'running' } };
                storage.getState().applyMachines([machine], false, { sourceServerId: serverId, sourceAccountId: accountId });
                storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: Date.now() + wake }],
                    { sourceServerId: serverId, sourceAccountId: accountId });
            });
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            installedVersion = '2.0.0';
            machine = { ...machine, metadataVersion: machine.metadataVersion + 1, metadata: { ...machine.metadata!,
                agentInventory: { checkedAt: 2, installedAgentIds: ['claude', 'codex'] } } };
            await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId, sourceAccountId: accountId }));
            await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(2));
            expect(snapshots.getCurrent().get(machine.id)?.response.results['cli.codex']).toMatchObject({ data: { version: '2.0.0' } });
            expect(snapshots.getCurrent().get(machine.id)?.response.results['cli.claude']).toMatchObject({ data: { available: true } });
            // A real Agent probe can discover an updated executable without a
            // roster change. Its installation fact wakes the same collector.
            installedVersion = '2.1.0';
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('The Updates fixture needs an applied Account');
            await act(async () => { await prefetchMachineCapabilities({ machineId: machine.id, serverId, accountLifetime: lifetime,
                cacheKeySalt: 'agent-version-probe', request: { requests: [{ id: 'cli.codex' }] } }); });
            await vi.waitFor(() => expect(updateDetects()).toBe(3));
            expect(snapshots.getCurrent().get(machine.id)?.response.results['cli.codex']).toMatchObject({ data: { version: '2.1.0' } });
            await act(async () => { await refreshMachineUpdateFacts(serverId, machine.id); });
            expect(updateDetects()).toBe(4);
            machine = { ...machine, metadataVersion: machine.metadataVersion + 1, metadata: { ...machine.metadata!,
                agentInventory: { checkedAt: 3, installedAgentIds: ['codex'] } } };
            await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId, sourceAccountId: accountId }));
            await vi.waitFor(() => expect(updateDetects()).toBe(5));
            expect(snapshots.getCurrent().get(machine.id)?.response.results['cli.claude']).toMatchObject({ data: { available: false } });
            machine = { ...machine, daemonStateVersion: machine.daemonStateVersion + 1,
                daemonState: { ...machine.daemonState, status: machine.daemonState?.status ?? 'running', runtimeId: 'replacement-daemon' } };
            await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId, sourceAccountId: accountId }));
            await vi.waitFor(() => expect(updateDetects()).toBe(6));
        } finally {
            await screen.unmount(); await snapshots.unmount(); storage.setState(previous, true);
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailability);
        }
    });

    it('does not commit the mounted background runtime for unrelated Machine details', async () => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        let machine = createMachineFixture({ id: 'updates-membership', activeAt: Date.now() });
        const publish = () => storage.setState({ profileScope: null,
            machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        let commits = 0;
        publish();
        const screen = await renderScreen(<React.Profiler id="update-facts" onRender={() => { commits++; }}>
            <UpdateFactsBackgroundRuntime enabled />
        </React.Profiler>);
        try {
            const before = commits;
            for (let tick = 1; tick <= 5; tick++) {
                machine = { ...machine, daemonStateVersion: tick, updatedAt: machine.updatedAt + 1 };
                await act(async () => publish());
            }
            expect(commits - before).toBe(0);
        } finally {
            await screen.unmount();
            storage.setState(previous, true);
        }
    });

    it('preserves each pending machine probe while other machines arrive or leave', async () => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const reply = createDeferred<unknown>();
        const signals: AbortSignal[] = [];
        boundary.rpc.mockImplementation(({ signal }: { signal: AbortSignal }) => {
            signals.push(signal);
            return reply.promise;
        });
        const machines = ['perf8-first', 'perf8-second', 'perf8-third'].map(id => createMachineFixture({
            id, active: true, activeAt: Date.now(),
        }));
        const publish = (rows: typeof machines) => storage.setState({
            profileScope: { serverId, accountId: 'perf8' },
            machines: Object.fromEntries(rows.map(machine => [machine.id, machine])),
            machineListByServerId: { [serverId]: rows },
        });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            publish(machines.slice(0, 1));
            screen = await renderScreen(<><UpdateFactsBackgroundRuntime enabled /><UpdateFactsBackgroundRuntime enabled /></>);
            await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
            await act(async () => publish(machines.slice(0, 2)));
            await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(2));
            expect(signals[0]?.aborted).toBe(false);
            await act(async () => publish(machines));
            await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(3));
            await act(async () => publish(machines.slice(0, 2)));
            expect(signals[0]?.aborted).toBe(false);
            expect(signals[1]?.aborted).toBe(false);
            expect(signals[2]?.aborted).toBe(true);
            await act(async () => reply.resolve({ protocolVersion: 1, results: {} }));
            await screen.unmount();
            screen = await renderScreen(<UpdateFactsBackgroundRuntime enabled />);
            expect(boundary.rpc).toHaveBeenCalledTimes(3);
            await act(async () => publishMachineContributionRegistryProjectionInvalidation({ serverId, machineId: machines[0]!.id }, 'authority'));
            expect(boundary.rpc).toHaveBeenCalledTimes(3);
        } finally {
            reply.resolve({ protocolVersion: 1, results: {} });
            await screen?.unmount();
            storage.setState(previous);
        }
    });
});

// P03-TESTKIT-SERVER: the unconfigured test build seeds no Home; select one through the real owner.
beforeEach(async () => { await selectActiveTestHomeForTests(); });
