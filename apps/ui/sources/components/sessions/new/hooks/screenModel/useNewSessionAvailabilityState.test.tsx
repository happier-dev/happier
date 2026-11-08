import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { act } from 'react-test-renderer';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

installNewSessionScreenModelCommonModuleMocks({ storage: async (importOriginal) => importOriginal() });

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { useServerScopedLaunchMachine } = await import('@/sync/store/hooks');
const { getMachineCapabilitiesCacheState } = await import('@/hooks/server/useMachineCapabilitiesCache');
const { resolveDaemonCapabilitiesCacheKeySalt } = await import('@/hooks/server/useDaemonScopedMachineCapabilitiesCache');
const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { EMPTY_MACHINE_AGENTS } = await import('@/agents/machineAgents/machineAgentInventoryStore');
const { useMachinePresenceSummary } = await import('@/sync/domains/machines/reachability/useMachinePresenceSummary');
const machineAgents = { ...EMPTY_MACHINE_AGENTS, refresh: async () => {} };

beforeEach(() => {
    network.resetRequests();
    network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
        ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
});
afterEach(async () => {
    vi.useRealTimers();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
});
afterAll(() => network.dispose());

describe('machine launch readiness', () => {
    it('uses inventory offline and recovery status for the Agent picker availability callbacks', async () => {
        const { getResolvedBackendCatalogEntries } = await import('@/agents/backendCatalog/getResolvedBackendCatalogEntries');
        const [entry] = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex'] });
        if (!entry) throw new Error('Expected bundled Codex catalog entry');
        const home = await network.addHome('https://agent-picker-offline.example.test', 'agent-picker-owner');
        const machine = createMachineFixture({ id: 'agent-picker-machine', active: true, activeAt: Date.now() });
        storage.getState().applyMachines([machine], false, { sourceServerId: home.id });
        let status: 'offline' | 'loading' = 'offline';
        const hook = await renderHook(() => useNewSessionAvailabilityState({
            machineAgents: { ...machineAgents, status },
            selectedMachineId: machine.id, selectedMachine: machine, capabilityServerId: home.id,
            machineProbesEnabled: false, externalSessionsFeatureEnabled: false, settings: settingsDefaults,
            resumeSessionId: null, backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [entry],
            selectedBackendEntry: entry, setBackendTarget: vi.fn(), machines: [machine], allProfiles: [],
        }));
        try {
            expect(hook.getCurrent().isBackendEntrySelectable(entry)).toBe(false);
            expect(hook.getCurrent().getBackendEntryUnavailabilityReason(entry)).toBe('agent-not-ready:codex');
            expect(hook.getCurrent().isAgentSelectable('codex')).toBe(false);
            status = 'loading';
            await hook.rerender();
            expect(hook.getCurrent().isBackendEntrySelectable(entry)).toBe(true);
            expect(hook.getCurrent().getBackendEntryUnavailabilityReason(entry)).toBeNull();
            expect(hook.getCurrent().isAgentSelectable('codex')).toBe(true);
        } finally {
            await hook.unmount();
        }
    });
    it('keeps pending capability detection in the single unknown readiness state', async () => {
        const home = await network.addHome('https://pending-readiness.example.test', 'pending-readiness-owner');
        const machine = createMachineFixture({ id: 'pending-readiness', active: true, activeAt: Date.now() });
        storage.getState().applyMachines([machine], false, { sourceServerId: home.id });
        let releaseDetection!: (value: unknown) => void;
        const detection = new Promise<unknown>(resolve => { releaseDetection = resolve; });
        network.setRpcResponder(async request => request.method === 'capabilities.detect'
            ? detection : { protocolVersion: 1, results: {} });
        const hook = await renderHook(() => useNewSessionAvailabilityState({
            machineAgents,
            selectedMachineId: machine.id, selectedMachine: machine, capabilityServerId: home.id,
            externalSessionsFeatureEnabled: false, settings: settingsDefaults, resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [], selectedBackendEntry: null,
            setBackendTarget: vi.fn(), machines: [machine], allProfiles: [],
        }));
        try {
            await network.waitForRpcRequest(request => request.method === 'capabilities.detect');
            expect(hook.getCurrent().selectedMachineCapabilities.status).toBe('loading');
            expect(hook.getCurrent().selectedMachineSpawnReadiness.status).toBe('unknown');
            await act(async () => { releaseDetection({ protocolVersion: 1, results: {} }); });
            await vi.waitFor(() => expect(hook.getCurrent().selectedMachineSpawnReadiness.status).toBe('ready'));
        } finally {
            releaseDetection({ protocolVersion: 1, results: {} });
            await hook.unmount();
        }
    });
    it('keeps roster and launch admission active until the authoritative withdrawal push', async () => {
        const home = await network.addHome('https://presence-deadline.example.test', 'presence-owner');
        vi.useFakeTimers();
        const machine = createMachineFixture({ id: 'presence-deadline', active: true,
            activeAt: Date.now() - 59_990 });
        storage.getState().applyMachines([machine], false, { sourceServerId: home.id });
        const hook = await renderHook(() => {
            const selectedMachine = useServerScopedLaunchMachine(home.id, machine.id);
            return {
                roster: useMachinePresenceSummary(home.id, machine.id),
                launch: useNewSessionAvailabilityState({
                    machineAgents, selectedMachineId: machine.id, selectedMachine,
                    capabilityServerId: home.id, machineProbesEnabled: false,
                    externalSessionsFeatureEnabled: false, settings: settingsDefaults, resumeSessionId: null,
                    backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [], selectedBackendEntry: null,
                    setBackendTarget: vi.fn(), machines: selectedMachine ? [selectedMachine] : [], allProfiles: [],
                }),
            };
        }, { flushOptions: { advanceTimersMs: 0 } });
        try {
            expect(hook.getCurrent().roster.reachability).toBe('reachable');
            expect(hook.getCurrent().launch.selectedMachineReachability).toBe('reachable');
            await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
            expect(hook.getCurrent().roster.reachability).toBe('reachable');
            expect(hook.getCurrent().launch.selectedMachineReachability).toBe('reachable');
            await act(async () => storage.getState().applyMachines([{ ...machine, active: false, activeAt: Date.now() }], false, { sourceServerId: home.id }));
            expect(hook.getCurrent().roster.reachability).toBe('unreachable');
            expect(hook.getCurrent().launch.selectedMachineReachability).toBe('unreachable');
            expect(hook.getCurrent().launch.selectedMachineSpawnReadiness.status).toBe('offline');
        } finally { await hook.unmount(); }
    });
    it('looks up acquired catalog targets without revalidating them and withdraws removed inventory', async () => {
        const { getResolvedBackendCatalogEntries } = await import('@/agents/backendCatalog/getResolvedBackendCatalogEntries');
        const { createMachineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
        const targets = await import('@happier-dev/protocol/backends/targets/backendTargetRefV2');
        const entry = getResolvedBackendCatalogEntries({ enabledAgentIds: ['codex'] })[0]!;
        const inventory = createMachineAgentInventoryStore();
        inventory.publish('target-lookup', { status: 'ready', items: [], lastCheckedAt: 1,
            descriptors: [{ agentId: 'codex', title: 'Codex' }],
        });
        const agents = inventory.read('target-lookup').agents;
        const hook = await renderHook((currentAgents: typeof agents) => useNewSessionAvailabilityState({
            machineAgents: { ...machineAgents, agents: currentAgents },
            selectedMachineId: null, selectedMachine: null, capabilityServerId: 'target-lookup', machineProbesEnabled: false,
            externalSessionsFeatureEnabled: false, settings: settingsDefaults, resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [entry], selectedBackendEntry: entry,
            setBackendTarget: vi.fn(), machines: [], allProfiles: [],
        }), { initialProps: agents });
        expect(hook.getCurrent().getBackendEntryMachineAgent(entry)).toBe(agents[0]);
        const parse = vi.spyOn(targets, 'readBackendTargetKeyV2');
        try {
            for (let index = 0; index < 100; index += 1) {
                expect(hook.getCurrent().getBackendEntryMachineAgent(entry)).toBe(agents[0]);
            }
            expect(parse).not.toHaveBeenCalled();
            inventory.publish('target-lookup', { status: 'ready', items: [], descriptors: [], lastCheckedAt: 2 });
            await hook.rerender(inventory.read('target-lookup').agents);
            expect(hook.getCurrent().getBackendEntryMachineAgent(entry)).toBeNull();
        } finally {
            parse.mockRestore();
            await hook.unmount();
        }
    });

    it.each([false, true])('loads Windows Terminal facts on picker demand or selected launch (selected: %s)', async (selected) => {
        const machine = createMachineFixture({ id: `windows-terminal-demand-${selected}`, active: true, activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, platform: 'win32' } });
        const home = await network.addHome(`https://windows-terminal-demand-${selected}.example.test`, 'windows-terminal-owner');
        storage.getState().applyMachines([machine], false, { sourceServerId: home.id });
        network.respond('capabilities.detect', { protocolVersion: 1, results: {} });
        const hook = await renderHook((windowsTerminalRequested: boolean) => useNewSessionAvailabilityState({
            machineAgents,
            selectedMachineId: machine.id, selectedMachine: machine, capabilityServerId: home.id, windowsTerminalRequested,
            externalSessionsFeatureEnabled: false, settings: { ...settingsDefaults, sessionTerminalHost: 'none', sessionUseTmux: false },
            resumeSessionId: null, backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [], selectedBackendEntry: null,
            setBackendTarget: vi.fn(), machines: [machine], allProfiles: [],
        }), { initialProps: selected });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().selectedMachineCapabilities.status).toBe('loaded'));
            expect(network.requests.filter(({ method }) => method === 'capabilities.detect').map(({ payload }) => payload)).toEqual([
                { requests: selected ? [{ id: 'tool.windowsTerminal' }] : [] },
            ]);
            if (!selected) {
                await act(async () => hook.getCurrent().onWindowsTerminalIntent());
                await vi.waitFor(() => expect(network.requests.filter(({ method }) => method === 'capabilities.detect').map(({ payload }) => payload)).toEqual([
                    { requests: [] }, { requests: [{ id: 'tool.windowsTerminal' }] },
                ]));
            }
        } finally { await hook.unmount(); }
    });

    it.each([false, true])('requests only selected launch facts (external dependency: %s)', async (hasDependency) => {
        const { publishProjectedAgentUiBehaviorDescriptors, clearProjectedAgentUiBehaviorDescriptors } = await import('@/agents/registry/agentUiBehaviorProjection');
        const machine = createMachineFixture({ id: `selected-dependencies-${hasDependency}`, active: true, activeAt: Date.now() });
        const home = await network.addHome(`https://selected-dependencies-${hasDependency}.example.test`, 'selected-dependencies-owner');
        storage.getState().applyMachines([machine], false, { sourceServerId: home.id });
        const agentId = 'acme.tools/agent';
        publishProjectedAgentUiBehaviorDescriptors({ machineId: machine.id, descriptorsByAgentId: {
            [agentId]: { kind: 'plugin.ui.v1', pluginId: 'acme.tools', agentId, version: 1,
                behavior: { newSession: { relevantInstallableDepKeys: hasDependency ? ['acme.tool'] : [] } } },
        } });
        network.respond('capabilities.detect', { protocolVersion: 1, results: {} });
        const hook = await renderHook(() => useNewSessionAvailabilityState({
            machineAgents,
            selectedMachineId: machine.id, selectedMachine: machine, capabilityServerId: home.id,
            runtimeCarrierAgentId: agentId, externalSessionsFeatureEnabled: false,
            settings: { ...settingsDefaults, sessionTerminalHost: hasDependency ? 'tmux' : 'none', sessionUseTmux: hasDependency },
            pluginProjectionV2: { familiesById: { managedDependencies: { family: 'managedDependencies', entriesById: Object.fromEntries(
                ['acme.tool', 'unrelated.tool'].map((key) => [key, { id: key, key, capabilityId: `dep.${key}`,
                    sourceKind: 'github_release_binary', display: { name: key },
                    defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' }, experimental: false }]),
            ) } } },
            resumeSessionId: null, backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [], selectedBackendEntry: null,
            setBackendTarget: vi.fn(), machines: [machine], allProfiles: [],
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().selectedMachineCapabilities.status).toBe('loaded'));
            const requests = network.requests.filter(({ method }) => method === 'capabilities.detect');
            expect(requests.map(({ payload }) => payload)).toEqual([{
                requests: hasDependency ? [{ id: 'tool.tmux' }, { id: 'dep.acme.tool' }] : [],
            }]);
            expect(hook.getCurrent().wizardInstallableDeps.map(({ entry }) => entry.key)).toEqual(hasDependency ? ['acme.tool'] : []);
        } finally {
            await hook.unmount();
            clearProjectedAgentUiBehaviorDescriptors();
        }
    });

    it('keeps current cached Agent resume facts without probing a passive embedded composer', async () => {
        const { PluginProjectionV2Schema} = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        const { useDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/useDaemonMergedProjectionInputs');
        const home = await network.addHome('https://passive-availability.example.test', 'passive-owner');
        const machine = createMachineFixture({ id: 'passive-availability', active: true, activeAt: Date.now() });
        storage.getState().applyMachines([machine], false, { sourceServerId: home.id });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, agentsById: {
            'acme.resume/resume': { id: 'acme.resume/resume', identity: { pluginId: 'acme.resume', localId: 'resume' },
                capabilities: { surfaces: ['terminal'], sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } } },
        } });
        network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { protocolVersion: 1, projection });
        const warmer = await renderHook(() => useDaemonMergedProjectionInputs({ sections: 'complete', machineId: machine.id, serverId: home.id }));
        await vi.waitFor(() => expect(warmer.getCurrent().phase).toBe('ready'));
        expect(warmer.getCurrent().inputs?.pluginProjectionV2?.agentsById['acme.resume/resume']?.capabilities?.sessions?.open).toContain('resume');
        const requestsBefore = network.requests.length;
        const hook = await renderHook(() => useNewSessionAvailabilityState({
            machineAgents,
            selectedMachineId: machine.id, selectedMachine: machine, capabilityServerId: home.id,
            machineProbesEnabled: false, runtimeCarrierAgentId: 'acme.resume/resume',
            externalSessionsFeatureEnabled: false, settings: settingsDefaults, resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [], selectedBackendEntry: null,
            setBackendTarget: vi.fn(), machines: [machine], allProfiles: [],
        }));
        expect(hook.getCurrent().showResumePicker).toBe(true);
        expect(network.requests.slice(requestsBefore)).toEqual([]);
        await hook.unmount();
        await warmer.unmount();
    });

    it('checks the new registry namespace after hydration without rechecking unrelated publications', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        network.respond('capabilities.detect', { protocolVersion: 1, results: {
            'tool.tmux': { ok: true, checkedAt: Date.now(), data: { available: true } },
        } });
        const machine = createMachineFixture({ id: 'launch-hydration', activeAt: Date.now(), daemonStateVersion: 0 });
        const home = await network.addHome('https://launch-hydration.example.test', 'launch-account');
        const serverId = home.id;
        storage.getState().applyMachines([machine], false, { sourceServerId: serverId });
        const hook = await renderHook((selectedMachine: typeof machine) => useNewSessionAvailabilityState({
            machineAgents,
            selectedMachineId: machine.id, selectedMachine, capabilityServerId: serverId,
            externalSessionsFeatureEnabled: false, settings: settingsDefaults, resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [], selectedBackendEntry: null,
            setBackendTarget: vi.fn(), machines: [selectedMachine], allProfiles: [],
        }), { initialProps: machine, flushOptions: { advanceTimersMs: 0 } });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().selectedMachineSpawnReadiness.status).toBe('ready'));
            const hydrated = { ...machine, daemonStateVersion: 1103, daemonState: { status: 'running', pid: 12, contributionRegistryProjectionRevision: 0 } };
            await act(async () => storage.getState().applyMachines([hydrated], false, { sourceServerId: serverId }));
            await hook.rerender(hydrated);
            await vi.waitFor(() => expect(getMachineCapabilitiesCacheState(machine.id, serverId, resolveDaemonCapabilitiesCacheKeySalt(hydrated, serverId))?.status).toBe('loaded'));
            expect(hook.getCurrent().selectedMachineCapabilities.status).toBe('loaded');
            expect(hook.getCurrent().selectedMachineSpawnReadiness.status).toBe('ready');
            const probesAfterHydration = network.requests.length;
            const published = { ...hydrated, daemonStateVersion: 1104, daemonState: { ...hydrated.daemonState, localServices: { v: 1, state: 'ready', runningCount: 1 } } };
            await act(async () => storage.getState().applyMachines([published], false, { sourceServerId: serverId }));
            await hook.rerender(published);
            expect(hook.getCurrent().selectedMachineSpawnReadiness.status).toBe('ready');
            expect(network.requests.length).toBe(probesAfterHydration);
            await hook.rerender({ ...published, activeAt: Date.now() + 1, seq: machine.seq + 1 });
            expect(network.requests.length).toBe(probesAfterHydration);
        } finally {
            await hook.unmount();
        }
    });
});

describe('effective terminal host availability', () => {
    it.each(['herdr', 'zellij', 'tmux', 'none'] as const)('warns about tmux only when the effective host is tmux, not %s', async (host) => {
        const hook = await renderHook(() => useNewSessionAvailabilityState({
            machineAgents,
            selectedMachineId: null, selectedMachine: null, capabilityServerId: 'server-a',
            externalSessionsFeatureEnabled: false,
            settings: { ...settingsDefaults, sessionTerminalHost: host, sessionUseTmux: host === 'tmux' },
            staticAgentId: 'codex', resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [], selectedBackendEntry: null,
            setBackendTarget: vi.fn(), machines: [], allProfiles: [],
        }));
        expect(hook.getCurrent().tmuxRequested).toBe(host === 'tmux');
        await hook.unmount();
    });
});
