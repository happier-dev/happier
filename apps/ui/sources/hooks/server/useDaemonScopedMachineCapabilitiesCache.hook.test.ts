import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';

// Only transport is replaced; machine currentness and capability caching stay real.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
import { useDaemonScopedMachineCapabilitiesCache } from './useDaemonScopedMachineCapabilitiesCache';

afterEach(() => { standardCleanup(); machineRpc.mockReset(); storage.setState(storage.getInitialState(), true); });

describe('daemon-scoped capability currentness', () => {
    it('retains a loaded answer across unrelated publications and probes a changed registry', async () => {
        const server = await upsertAndActivateServer({ serverUrl: 'https://daemon-capability-currentness.example.test' });
        const machine = createMachineFixture({ id: 'capability-currentness-machine', daemonStateVersion: 1,
            daemonState: { status: 'running', pid: 12, contributionRegistryProjectionRevision: 0 } });
        storage.getState().applyMachines([machine], false, { sourceServerId: server.id });
        let available = true;
        machineRpc.mockImplementation(async () => ({ protocolVersion: 1, results: {
            'tool.tmux': { ok: true, checkedAt: 12, data: { available } },
        } }));
        const hook = await renderHook(() => useDaemonScopedMachineCapabilitiesCache({ machineId: machine.id, serverId: server.id,
            enabled: true, request: { requests: [{ id: 'tool.tmux' }] } }));
        await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('loaded'));
        const ready = hook.getCurrent().state;
        available = false;
        machineRpc.mockClear();
        await act(async () => storage.getState().applyMachines([{ ...machine, daemonStateVersion: 2,
            daemonState: { ...machine.daemonState, localServices: { v: 1, state: 'ready', runningCount: 1 } } }], false, { sourceServerId: server.id }));
        await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('loaded'));
        expect(hook.getCurrent().state).toBe(ready);
        expect(machineRpc).not.toHaveBeenCalled();
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machine.id }));
        await vi.waitFor(() => expect(hook.getCurrent().state).toMatchObject({ status: 'loaded', snapshot: {
            response: { results: { 'tool.tmux': { data: { available: false } } } },
        } }));
        await hook.unmount();
    });
});
