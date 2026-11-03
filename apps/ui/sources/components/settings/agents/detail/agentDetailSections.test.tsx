import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MachineAgentInventoryItemSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

// Keep inventory, Account admission, setup, and row actions real beneath daemon HTTP/Socket.IO.
const network = await installSessionOpsNetworkBoundary();
const { createMachineAdministrationTargetSelectionMock } = await import('@/dev/testkit/mocks/machineAdministrationTargetSelection');
const { storage } = await import('@/sync/domains/state/storageStore');
const { refreshMachineAgents } = await import('@/agents/machineAgents/useMachineAgents');
const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { AgentMachinesSection } = await import('./AgentMachinesSection');
const { AgentSourceAndUpdatesSection } = await import('./AgentSourceAndUpdatesSection');

beforeEach(() => network.resetRequests());
afterEach(async () => {
    standardCleanup();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    storage.setState(storage.getInitialState(), true);
});
afterAll(() => network.dispose());

it('offers retry after a cold inventory projection failure and recovers to the detected agent', async () => {
    const home = await network.addHome('https://agent-detail-cold-failure.example.test', 'cold-account');
    const scope = { serverId: home.id, accountId: 'cold-account' };
    const machine = createMachineFixture({ id: 'cold-machine', activeAt: Date.now() });
    const emptyMachine = createMachineFixture({ id: 'empty-machine', activeAt: Date.now() });
    storage.setState({ machineListByServerId: { [home.id]: [machine, emptyMachine] }, profileScope: scope });
    let failed = true;
    const projection = PluginProjectionV2Schema.parse({
        v: 2, generation: 1, installedPackagesById: {},
        agentsById: { review: { id: 'review', title: 'Review', capabilities: {
            surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
        } } },
        actionsById: {},   resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [],
    });
    network.setRpcResponder(async ({ method, targetId }) => {
        if (method.includes('contributionRegistryProjection.describe')) {
            if (targetId === emptyMachine.id) return { protocolVersion: 1, projection: { ...projection, agentsById: {} } };
            if (failed) throw new Error('transport disconnected');
            return { protocolVersion: 1, projection };
        }
        if (method === 'capabilities.detect') return { protocolVersion: 1, results: {
            'cli.review': { ok: true, checkedAt: 12, data: MachineAgentInventoryItemSchema.parse({
                agentId: 'review', title: 'Review', managed: true, installed: false, version: null, latestVersion: null,
                update: { supported: false, command: null },
                signIn: { status: 'signedOut', required: true, loginSupport: 'login_terminal' },
                platform: { supported: true },
                install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
            }) },
        } };
        return { jobs: [] };
    });
    const selection = createMachineAdministrationTargetSelectionMock({
        serverId: home.id, serverIdentityId: home.id, machines: [
            { machineId: machine.id, displayName: 'Workstation' }, { machineId: emptyMachine.id, displayName: 'Spare workstation' },
        ],
    });
    function Detail() {
        const targetSelection = selection.module.useMachineAdministrationTargetSelection('agents');
        return <AgentMachinesSection agentTitle="Review" agentId="review" pinnedVersion={null}
            serverId={home.id} targetSelection={targetSelection} testID="cold-agents" />;
    }
    const screen = await renderScreen(<Detail />);
    await vi.waitFor(() => expect(machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id)))
        .toMatchObject({ status: 'error', agents: [] }));
    await vi.waitFor(() => expect(machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', emptyMachine.id)))
        .toMatchObject({ status: 'ready', agents: [] }));
    await vi.waitFor(() => expect(screen.findByTestId('cold-agents:machine:cold-machine:action:checkAgain')).toBeTruthy());
    expect(screen.getTextContent()).not.toContain('machineAgents.checking');
    failed = false;
    await screen.pressByTestIdAsync('cold-agents:machine:cold-machine:action:checkAgain');
    await vi.waitFor(() => expect(screen.findByTestId('cold-agents:machine:cold-machine:action:install')).toBeTruthy());
    expect(screen.findByTestId('cold-agents:machine:cold-machine:action:checkAgain')).toBeNull();
});

it('shows each machine’s Install, Update, Remove and Sign in and opens that machine’s setup form', async () => {
    const home = await network.addHome('https://agent-detail-sections.example.test', 'detail-account');
    const scope = { serverId: home.id, accountId: 'detail-account' };
    const machines = ['install', 'update', 'signin'].map(id => createMachineFixture({
        id, activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, displayName: `Machine ${id}`, host: id },
    }));
    storage.setState({ machineListByServerId: { [home.id]: machines }, profileScope: scope });
    const projection = PluginProjectionV2Schema.parse({
        v: 2, generation: 1, installedPackagesById: {},
        agentsById: { review: { id: 'review', title: 'Review', capabilities: {
            surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
        } } },
        actionsById: {},   resourcesById: {},
        settingsById: {}, familiesById: {}, diagnostics: [],
    });
    network.setRpcResponder(async ({ method, targetId }) => {
        if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
        if (method === 'capabilities.detect') return { protocolVersion: 1, results: {
            'cli.review': { ok: true, checkedAt: 12, data: MachineAgentInventoryItemSchema.parse({
                agentId: 'review', title: 'Review', managed: true, installed: targetId !== 'install',
                version: targetId === 'install' ? null : '1.0', latestVersion: targetId === 'update' ? '2.0' : '1.0',
                update: { supported: true, command: null },
                signIn: { status: targetId === 'signin' ? 'signedOut' : 'signedIn', required: true, loginSupport: 'login_terminal' },
                platform: { supported: true },
                install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
            }) },
        } };
        return { jobs: [] };
    });
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    await Promise.all(machines.map(machine => refreshMachineAgents({
        serverId: home.id, machineId: machine.id, accountLifetime: lifetime,
    })));
    const selection = createMachineAdministrationTargetSelectionMock({
        serverId: home.id, serverIdentityId: home.id,
        machines: machines.map(machine => ({ machineId: machine.id, displayName: machine.metadata!.displayName! })),
    });
    function Detail() {
        const targetSelection = selection.module.useMachineAdministrationTargetSelection('agents');
        return <AgentMachinesSection agentTitle="Review" agentId="review" pinnedVersion="2.0"
            serverId={home.id} targetSelection={targetSelection} testID="agent-machines" />;
    }
    const screen = await renderScreen(<Detail />);
    await vi.waitFor(() => expect(screen.findByTestId('agent-machines:machine:signin:action:signIn')).toBeTruthy());
    expect(screen.findByTestId('agent-machines:machine:install:action:install')).toBeTruthy();
    expect(screen.findByTestId('agent-machines:machine:update:action:update')).toBeTruthy();
    expect(screen.findByTestId('agent-machines:machine:update:action:remove')).toBeTruthy();
    expect(screen.findByTestId('agent-machines:machine:install:action:remove')).toBeNull();
    expect(screen.findHostByTestId('agent-machines:machine:signin:setup')).toBeNull();
    await screen.pressByTestIdAsync('agent-machines:machine:signin:action:signIn');
    await vi.waitFor(() => expect(screen.findHostByTestId('agent-machines:machine:signin:setup')).toBeTruthy());
    expect(screen.findByTestId('agent-machines:machine:signin:setup.openTerminal')).toBeTruthy();
    expect(selection.controller.selectedTargets).toEqual([{ serverIdentityId: home.id, machineId: 'signin' }]);
    expect(screen.findHostByTestId('agent-machines:machine:install:setup')).toBeNull();
});

it('shows registry source, pinned version and checksum and offers checking then the available update', async () => {
    const definition = AcpBackendDefinitionV1Schema.parse({
        id: 'registry-review', name: 'review', title: 'Review',
        launch: { kind: 'archive', version: '1.0', args: [], assetsByPlatform: {
            'linux-x64': { archiveUrl: 'https://registry.example.test/review.tar.gz', executableSubpath: 'review' },
            'darwin-arm64': { archiveUrl: 'https://registry.example.test/review-mac.tar.gz', executableSubpath: 'review', sha256: 'a'.repeat(64) },
        } },
        env: {}, createdAt: 1, updatedAt: 1,
        origin: { kind: 'registry', publisher: 'Review authors', provenance: {
            sourceId: 'acp-registry', format: 'acp-registry', sourceUrl: 'https://registry.example.test',
            itemId: 'review', ref: { kind: 'version', version: '1.0' }, importedAt: 1,
        } },
    });
    const checkNow = vi.fn();
    const update = vi.fn();
    const props = { definition, check: { checking: false, failed: false, checkedAt: null },
        onCheckNow: checkNow, onUpdate: update, updating: false, testID: 'agent-source' };
    const screen = await renderScreen(<AgentSourceAndUpdatesSection {...props} />);
    expect(screen.findByTestId('agent-source:registry')).toBeTruthy();
    expect(screen.getTextContent()).toContain('1.0');
    expect(screen.getTextContent()).toContain('settingsAgents.detailPage.checksumNotPublished');
    expect(screen.getTextContent()).not.toContain('settingsAgents.detailPage.checksumVerified');
    await screen.pressByTestIdAsync('agent-source:checkNow');
    expect(checkNow).toHaveBeenCalled();
    await act(async () => screen.update(<AgentSourceAndUpdatesSection {...props} definition={{
        ...definition, origin: { ...definition.origin!, upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } } },
    }} />));
    await screen.pressByTestIdAsync('agent-source:update');
    expect(update).toHaveBeenCalledWith('2.0');
    expect(screen.findByTestId('agent-source:checkNow')).toBeNull();
});
