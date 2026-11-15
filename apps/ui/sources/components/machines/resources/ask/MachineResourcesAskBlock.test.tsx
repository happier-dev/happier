import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { t } from '@/text';
import type { NewSessionEmbeddedHost } from '@/components/sessions/new/navigation/newSessionHost';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

it('offers only the return notification without a last report and fills the global draft without sending', async () => {
    await prepareSessionDraftPersistenceStorage();
    const serverId = 'srv_offline_prompts';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://offline-prompts.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'machine-offline-prompts', active: false, activeAt: 1 });
    await publishMachineInventoryForTest(captureActiveServerAccountScopeLifetime()!.scope, [machine]);
    storage.setState({ isDataReady: true, isSessionDraftsReady: true });
    const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId={machine.id} machineName="Laptop" />);
    const list = () => screen.root.findAll(node => node.type === Reflect.get(HubComposerSuggestionList, 'type'))[0]!;
    expect(screen.root.findAllByType(NewSessionEmbeddedHostProvider)).toHaveLength(0);
    const scope = captureActiveServerAccountScopeLifetime()!.scope;
    expect(list().props.suggestions.map((entry: { kind: string }) => entry.kind)).toEqual(['notifyWhenBack']);
    storage.setState({ settings: settingsParse({ ...storage.getState().settings, actionsSettingsV1: { v: 1,
        actions: { 'session.authoring.open': { disabledSurfaces: ['ui'] } } } }) });
    const first = list().props.suggestions[0];
    await screen.pressByTestIdAsync(`hub-composer.suggestion.${first.id}`);
    expect(routePush).not.toHaveBeenCalled();
    storage.setState({ settings: settingsParse({ ...storage.getState().settings, actionsSettingsV1: { v: 1, actions: {} } }) });
    for (const kind of ['notifyWhenBack']) {
        const suggestion = list().props.suggestions.find((entry: { kind: string }) => entry.kind === kind);
        expect(suggestion).toBeDefined();
        const testId = `hub-composer.suggestion.${suggestion.id}`;
        expect(screen.findByTestId(testId)?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync(testId);
        await vi.waitFor(() => expect(routePush).toHaveBeenCalled());
        expect(routePush.mock.lastCall?.[0]).toEqual({ pathname: '/new', params: { draftId: expect.any(String), draftServerId: scope.serverId, draftAccountId: scope.accountId } });
        const route = routePush.mock.lastCall![0] as { params: { draftId: string } };
        const draft = readNewSessionDraftFromRepository({ scope, draftId: route.params.draftId });
        expect(draft?.input).toBe(suggestion.fill.text);
        expect(draft?.selectedMachineId).toBeNull();
        expect(draft?.executionTarget).toBeNull();
        if (kind === 'notifyWhenBack') {
            const { SettingsDeclarationActionInputSchemasV1 } = await import('@happier-dev/protocol/actions/settingsDeclarationActionFamily');
            const input = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(JSON.parse(draft!.input.split('\nsettings.set ')[1]!));
            expect(input).toEqual({ anchor: 'notifications.machineOffline', key: machine.id, value: true });
        }
    }
    expect(storage.getState().sessions).toEqual({});
    expect(rpc).not.toHaveBeenCalled();
    await act(async () => publishMachineInventoryForTest(captureActiveServerAccountScopeLifetime()!.scope,
        [{ ...machine, active: true, activeAt: Date.now() }]));
    await act(async () => list().props.onFill({ prompt: 'Inspect the current report', placement: { serverId, machineId: machine.id } }));
    const host: NewSessionEmbeddedHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    expect(host.params.prompt).toBe('Inspect the current report');
    expect(host.params.machineId).toBe(machine.id);
    await screen.unmount();
});

it('does not seed an offline machine alert prompt into another Home’s active Account during a page switch', async () => {
    await prepareSessionDraftPersistenceStorage();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://active-home.example.test', serverIdentityId: 'srv_active_home' });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'foreign-machine', active: false, activeAt: 1 });
    await publishMachineInventoryForTest({ ...captureActiveServerAccountScopeLifetime()!.scope, serverId: 'srv_foreign_home' }, [machine]);
    storage.setState({ isDataReady: true, isSessionDraftsReady: true });
    const screen = await renderScreen(<MachineResourcesAskBlock serverId="srv_foreign_home" machineId={machine.id} machineName="Studio" />);
    const list = screen.root.findAll(node => node.type === Reflect.get(HubComposerSuggestionList, 'type'))[0]!;
    const suggestion = list.props.suggestions.find((entry: { kind: string }) => entry.kind === 'notifyWhenBack');
    await screen.pressByTestIdAsync(`hub-composer.suggestion.${suggestion.id}`);
    expect(routePush).not.toHaveBeenCalled();
    expect(storage.getState().sessions).toEqual({});
    expect(rpc).not.toHaveBeenCalled();
    await screen.unmount();
});

// Native hosts and transport are the boundaries. The real embedded New Session,
// resource store, passive summary hook and suggestion projection remain mounted.
installDisconnectedServerSocketBoundary();
const rpc = vi.hoisted(() => vi.fn());
const routePush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: routePush },
}).module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
await loadSyncSingletonForTests();
const { HubComposerSuggestionList } = await import('@/components/hub/composer/suggestions/HubComposerSuggestions');
const { storage } = await import('@/sync/domains/state/storageStore');
const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
const { machineResourceStore } = await import('@/sync/domains/machines/resources/machineResourceStore');
const { machineStorageStore } = await import('@/sync/domains/machines/storage/machineStorageStore');
const { machineProcessesStore } = await import('@/sync/domains/machines/processes/machineProcessesStore');
const { MachineResourcesAskBlock } = await import('./MachineResourcesAskBlock');
const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { NewSessionEmbeddedHostProvider } = await import('@/components/sessions/new/navigation/newSessionHost');
const { useNewSessionMachinePathState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionMachinePathState');
const { useNewSessionServerTargetState } = await import('@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');

it('keeps the presented Ask launch model quiet across unrelated resource publications and heartbeats', async () => {
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { HappierStorageSummaryV1Schema } = await import('@happier-dev/protocol/storage/storageV1');
    const { MachineProcessesAnswerV1Schema } = await import('@happier-dev/protocol/machines/processes/machineProcessesV1');
    const { MachineResourcesPolicyV1Schema } = await import('@happier-dev/protocol/machines/resources/machineResourcesPolicyV1');
    const { composeMachineResourceAttentionV1, deriveMachineVitalsAttentionV1 } = await import('@happier-dev/protocol/machines/vitals/machineVitalsAttentionV1');
    await prepareSessionDraftPersistenceStorage();
    const serverId = 'srv_ask_tick_locality';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://ask-tick-locality.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const sampledAt = Date.now();
    const machine = createMachineFixture({ id: 'ask-tick-locality', active: true, activeAt: sampledAt, presenceProtocolVersion: 1, daemonStateVersion: 1,
      keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 1 },
      daemonState: { contributionRegistryProjectionRevision: 1 }, metadata: {
        ...createMachineFixture().metadata!, resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { memoryGuard: { enabled: false } } }),
    } });
    await publishMachineInventoryForTest(captureActiveServerAccountScopeLifetime()!.scope, [machine]);
    storage.setState({ isDataReady: true, isSessionDraftsReady: true });
    let at = sampledAt;
    let memoryPressure: 'calm' | 'elevated' = 'calm';
    let diskAvailableBytes = 50_000_000_000;
    let happierStorageBytes = 4_000_000_000;
    rpc.mockImplementation(async ({ method }: { method: string }) => {
        if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return HappierStorageSummaryV1Schema.parse({ revision: at, sizedAt: at, volumes: [], categories: [
            { categoryId: 'caches', size: { allocatedBytes: happierStorageBytes, freesBytes: happierStorageBytes,
                sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false }, count: 1, canGoBytes: happierStorageBytes, detailFacts: {} },
        ], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: at },
            wholeDisk: { enabled: false, scans: [] } })
        if (method === RPC_METHODS.MACHINES_PROCESSES_LIST) return MachineProcessesAnswerV1Schema.parse({ v: 1, machineId: machine.id, capturedAtMs: at, state: 'live',
            platform: 'linux', evidenceModel: 'fenced', owners: [], leftBehind: [],
            totals: { happier: { processCount: 0, memoryBytes: 0 }, leftBehind: { processCount: 0, memoryBytes: 0 } } })
        const sample: MachineVitalsSampleV1 = {
        v: 1, sampledAt: at, intervalMs: 2_000, cpu: { reported: true, busyPct: at % 100 },
        memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: memoryPressure, source: 'psi' } },
        disk: { reported: true, homeVolumeId: 'home', volumes: [{ id: 'home', label: 'Home', mount: '/home',
            totalBytes: 100_000_000_000, availableBytes: diskAvailableBytes }] }, network: { reported: true, rxBps: 12, txBps: 3 },
        };
        return { state: 'reporting', sample, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
            attention: composeMachineResourceAttentionV1([deriveMachineVitalsAttentionV1({ recent: [sample], previous: [], nearlyFull: { freeFraction: 0.1 } })]) };
    });
    // Keep the actual store writers and passive subscriptions beneath the transport boundary.
    const accountId = captureActiveServerAccountScopeLifetime()!.scope.accountId;
    const storageKey = { serverId, machineId: machine.id, expectedAccountId: accountId };
    const processKey = { serverId, machineId: machine.id, accountId, scope: 'happier' as const, view: 'owners' as const };
    await machineResourceStore.read({ ...storageKey, view: 'summary' });
    await machineStorageStore.read(storageKey);
    await machineProcessesStore.read(processKey);
    const modelModule = await import('@/components/sessions/new/hooks/useNewSessionScreenModel');
    const model = vi.spyOn(modelModule, 'useNewSessionScreenModel'); // Calls through the real model.
    onTestFinished(() => model.mockRestore());
    const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId={machine.id} machineName="Laptop" />);
    const list = () => screen.root.findAll(node => node.type === Reflect.get(HubComposerSuggestionList, 'type'))[0]!;
    const suggestions = list().props.suggestions;
    const host = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    const key = { serverId, machineId: machine.id, expectedAccountId: captureActiveServerAccountScopeLifetime()!.scope.accountId, view: 'summary' as const };
    model.mockClear();
    const start = performance.now();
    for (let index = 0; index < 30; index++) {
        at += 2_000;
        diskAvailableBytes++;
        await act(async () => { await machineResourceStore.read(key); });
    }
    const tickRenders = model.mock.calls.length;
    const elapsedMs = performance.now() - start;
    model.mockClear();
    // Exercise production publication: the canonical writer owns heartbeat retention,
    // while FX84/FX86's launch selectors retain unchanged launch choices.
    for (let index = 1; index <= 5; index++) {
        const current = storage.getState().machines[machine.id]!;
        await act(async () => storage.getState().applyMachines([{ ...current, seq: current.seq + 1,
            daemonStateVersion: current.daemonStateVersion + 1,
            keyBasis: { ...current.keyBasis!, daemonStateVersion: current.daemonStateVersion + 1 },
            activeAt: sampledAt + index, updatedAt: sampledAt + index }], false, { sourceServerId: serverId }));
    }
    const heartbeatRenders = model.mock.calls.length;
    model.mockClear();
    for (let index = 0; index < 5; index++) {
        at += 2_000;
        happierStorageBytes++;
        await act(async () => { await machineStorageStore.read(storageKey); await machineProcessesStore.read(processKey); });
    }
    const otherResourceRenders = model.mock.calls.length;
    console.info('FX89 presented Ask / 30 changing disk values + 5 heartbeats + 5 changing storage totals', {
        elapsedMs, tickRenders, heartbeatRenders, otherResourceRenders,
    });
    expect(list().props.suggestions).toBe(suggestions);
    expect(screen.root.findByType(NewSessionEmbeddedHostProvider).props.host).toBe(host);
    expect(tickRenders).toBe(0);
    expect(heartbeatRenders).toBe(0);
    expect(otherResourceRenders).toBe(0);
    // A shown fact must still reach the same retained composer and its suggestion list.
    model.mockClear();
    memoryPressure = 'elevated';
    at += 2_000;
    await act(async () => { await machineResourceStore.read(key); });
    expect(list().props.suggestions.some((entry: { kind: string }) => entry.kind === 'memory')).toBe(true);
    expect(model.mock.calls.length).toBe(0);
    expect(screen.root.findByType(NewSessionEmbeddedHostProvider).props.host).toBe(host);
    // A displayed amount refreshes when its formatted value changes, but not for byte-only changes.
    model.mockClear();
    happierStorageBytes = 5_000_000_000;
    at += 2_000;
    await act(async () => { await machineStorageStore.read(storageKey); });
    expect(list().props.suggestions.find((entry: { kind: string }) => entry.kind === 'storage').reason)
        .toBe(t('machineResources.askSuggestions.reasons.storage', { amount: '5 GB' }));
    expect(model.mock.calls.length).toBe(0);
    // Memory, disk and Guard fill the three slots: even a differently formatted Storage total is irrelevant.
    diskAvailableBytes = 9_000_000_000;
    at += 2_000;
    await act(async () => { await machineResourceStore.read(key); });
    expect(list().props.suggestions.map((entry: { kind: string }) => entry.kind)).toEqual(['memory', 'disk', 'guard']);
    const prioritySuggestions = list().props.suggestions;
    model.mockClear();
    diskAvailableBytes++;
    happierStorageBytes = 7_000_000_000;
    at += 2_000;
    await act(async () => { await machineResourceStore.read(key); await machineStorageStore.read(storageKey); });
    const hiddenStorageRenders = model.mock.calls.length;
    console.info('FX89 displayed-disk rounding / unshown Storage total', { hiddenStorageRenders });
    expect(list().props.suggestions).toBe(prioritySuggestions);
    expect(hiddenStorageRenders).toBe(0);
    expect(screen.root.findByType(NewSessionEmbeddedHostProvider).props.host).toBe(host);
    diskAvailableBytes = 8_000_000_000;
    at += 2_000;
    await act(async () => { await machineResourceStore.read(key); });
    expect(list().props.suggestions.find((entry: { kind: string }) => entry.kind === 'disk').reason)
        .toBe(t('machineResources.askSuggestions.reasons.disk', { amount: '8 GB' }));
    expect(model.mock.calls.length).toBe(0);
    expect(screen.root.findByType(NewSessionEmbeddedHostProvider).props.host).toBe(host);
    await screen.unmount();
});

it('recovers the mounted Ask composer from canonical presence without requiring a caller update', async () => {
    const serverId = 'srv_presence';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://presence.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'machine-presence', active: false, activeAt: 1, presenceProtocolVersion: 1 });
    await publishMachineInventoryForTest(captureActiveServerAccountScopeLifetime()!.scope, [machine]);
    const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId={machine.id} machineName="Laptop" />);
    const composers = () => screen.root.findAllByType(NewSessionEmbeddedHostProvider);
    expect(composers()).toHaveLength(0);
    await act(async () => publishMachineInventoryForTest(captureActiveServerAccountScopeLifetime()!.scope,
        [{ ...machine, active: true, activeAt: Date.now() }]));
    expect(composers()).toHaveLength(1);
    await act(async () => publishMachineInventoryForTest(captureActiveServerAccountScopeLifetime()!.scope,
        [{ ...machine, activeAt: Date.now() }]));
    expect(composers()).toHaveLength(0);
    await screen.unmount();
});

it('starts Ask on the page machine and home folder before intent, independently of a foreign remembered placement', async () => {
    const serverId = 'srv_placement';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://placement.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() });
    await publishMachineInventoryForTest(captureActiveServerAccountScopeLifetime()!.scope, [machine]);
    const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId="machine-a" machineName="Laptop" />);
    expect(rpc).not.toHaveBeenCalled();
    const host: NewSessionEmbeddedHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    const targetServer = await renderHook((hostTargetServerId: string | undefined) => useNewSessionServerTargetState({
        settings: { ...settingsDefaults, serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'home-b' },
        activeServerId: 'home-b',
        serverProfiles: [
            { id: serverId, serverUrl: 'https://placement.example.test', name: 'Home A', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
            { id: 'home-b', serverUrl: 'https://home-b.example.test', name: 'Home B', createdAt: 2, updatedAt: 2, lastUsedAt: 2 },
        ],
        hostTargetServerId,
        request: { spawnServerIdParam: typeof host.params.spawnServerId === 'string' ? host.params.spawnServerId : null },
    }), { initialProps: host.targetServerId });
    expect(targetServer.getCurrent().targetServerId).toBe(serverId);
    expect(targetServer.getCurrent().allowedTargetServerIds).toEqual([serverId]);
    expect(targetServer.getCurrent().showServerPickerChip).toBe(false);
    const placement = await renderHook(() => useNewSessionMachinePathState({
        serverId: targetServer.getCurrent().targetServerId,
        machines: [machine, createMachineFixture({ id: 'machine-b' })],
        recentMachinePaths: [{ machineId: 'machine-b', path: '/foreign/repo' }],
        machineIdParam: host.params.machineId,
        pathParam: host.params.directory,
        persistedExecutionTarget: { kind: 'machine', target: { serverId: 'home-b', machineId: 'machine-b' } },
        persistedPath: '/foreign/repo',
    }));
    expect(placement.getCurrent().executionTarget).toEqual({ kind: 'machine', target: { serverId, machineId: 'machine-a' } });
    expect(placement.getCurrent().directoryIntent).toEqual({ kind: 'path', path: '~' });
    expect(host.demanded).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(host.params.draftOrigin).toBeUndefined();
    await act(async () => host.setParams({ directory: '/authored/repo', resumeSessionId: 'foreign-session' }));
    const editedHost: NewSessionEmbeddedHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    expect(editedHost.params.directory).toBe('/authored/repo');
    await act(async () => editedHost.openDraft({ draftId: '4db4aa44-4b4a-4444-8444-4b4a4b4a4b4a', draftOrigin: 'ordinary' }));
    const restartedHost: NewSessionEmbeddedHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    expect(restartedHost.params.directory).toBe('~');
    expect(restartedHost.params.resumeSessionId).toBeUndefined();
    expect(restartedHost.params.machineId).toBe('machine-a');
    expect(restartedHost.params.draftOrigin).toBeUndefined();
    await targetServer.rerender('unavailable-home');
    expect(targetServer.getCurrent().targetServerId).toBe('unavailable-home');
    expect(targetServer.getCurrent().targetServerProfile).toBeNull();
    expect(targetServer.getCurrent().allowedTargetServerIds).toEqual(['unavailable-home']);
    expect(rpc).not.toHaveBeenCalled();
    await act(async () => screen.findByTestId('machine-resources-ask.composer')?.props.onPointerEnter());
    await vi.waitFor(() => expect(rpc.mock.calls.some(([call]) => call.method === 'capabilities.detect')).toBe(true));
    await placement.unmount();
    await targetServer.unmount();
    await screen.unmount();
});

afterEach(() => {
    standardCleanup();
    machineResourceStore.reset();
    machineStorageStore.reset();
    machineProcessesStore.reset();
    storage.setState({ sessions: {}, machines: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
    rpc.mockReset();
    routePush.mockReset();
});

it('never seeds Ask with the daemon home on a separate-users Machine, where the requester runs as its own member', async () => {
    const serverId = 'srv_member_ask';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://member-ask.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const ordinary = createMachineFixture({ id: 'machine-ordinary', active: true, activeAt: Date.now() });
    const base = createMachineFixture({ id: 'machine-member', active: true, activeAt: Date.now() });
    // R126U3: the daemon's /home/happier is not readable by member UID 997.
    const member = { ...base, metadata: { ...base.metadata!, platform: 'linux', homeDir: '/home/happier',
        agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' as const } } };
    await publishMachineInventoryForTest(captureActiveServerAccountScopeLifetime()!.scope, [ordinary, member]);
    const hostFor = async (machineId: string) => {
        const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId={machineId} machineName="Guest" />);
        const host: NewSessionEmbeddedHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
        await screen.unmount();
        return host;
    };
    // The member's folder is decided by the New Session placement owner from its own requester status.
    expect((await hostFor(member.id)).params.directory).toBeUndefined();
    // Elsewhere Ask starts at the home intent, which the native execution owner expands.
    expect((await hostFor(ordinary.id)).params.directory).toBe('~');
});

it('uses warmed Storage and Processes facts without extra reads and suppresses unavailable Automations', async () => {
    const { HappierStorageSummaryV1Schema } = await import('@happier-dev/protocol/storage/storageV1');
    const { MachineProcessesAnswerV1Schema } = await import('@happier-dev/protocol/machines/processes/machineProcessesV1');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { MachineResourcesPolicyV1Schema } = await import('@happier-dev/protocol/machines/resources/machineResourcesPolicyV1');
    await prepareSessionDraftPersistenceStorage();
    const serverId = 'srv_warmed_ask';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://warmed-ask.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'machine-warmed', active: true, activeAt: Date.now(), metadata: {
        ...createMachineFixture().metadata!, resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { memoryGuard: { enabled: true } } }),
    } });
    const existingSession = createSessionFixture({ id: 'existing-warmed-ask', serverId });
    await publishMachineInventoryForTest(captureActiveServerAccountScopeLifetime()!.scope, [machine]);
    storage.setState({ isDataReady: true, isSessionDraftsReady: true,
        sessions: { [existingSession.id]: existingSession },
        settings: { ...storage.getState().settings, featureToggles: { ...storage.getState().settings.featureToggles, automations: false } } });
    const accountId = captureActiveServerAccountScopeLifetime()!.scope.accountId;
    const storageReport = HappierStorageSummaryV1Schema.parse({ revision: 1, sizedAt: 1, volumes: [], categories: [
        { categoryId: 'caches', size: { allocatedBytes: 4_000_000_000, freesBytes: 4_000_000_000,
            sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false }, count: 1, canGoBytes: 4_000_000_000, detailFacts: {} },
    ], suggestionsTop: [], pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 },
        wholeDisk: { enabled: false, scans: [] } });
    const processReport = MachineProcessesAnswerV1Schema.parse({ v: 1, machineId: machine.id, capturedAtMs: 1,
        state: 'live', platform: 'linux', evidenceModel: 'fenced', owners: [], leftBehind: [
            { rowId: 'left', ref: 'left', name: 'vite', pid: 20, startedAtMs: 1, level: 'left_behind', memoryBytes: 100,
                memoryKind: 'rss', owner: { kind: 'session', sessionId: 'finished' }, confirmedAtMs: 1 },
        ], totals: { happier: { processCount: 0, memoryBytes: 0 }, leftBehind: { processCount: 1, memoryBytes: 100 } } });
    rpc.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET
        ? storageReport : method === RPC_METHODS.MACHINES_PROCESSES_LIST ? processReport : undefined);
    await machineStorageStore.read({ serverId, machineId: machine.id, expectedAccountId: accountId });
    await machineProcessesStore.read({ serverId, machineId: machine.id, accountId, scope: 'happier', view: 'owners' });
    rpc.mockClear();
    const resourceMethods = new Set([RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, RPC_METHODS.DAEMON_STORAGE_WATCH,
        RPC_METHODS.MACHINES_PROCESSES_LIST, RPC_METHODS.DAEMON_PROCESSES_WATCH]);
    const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId={machine.id} machineName="Laptop" />);
    const list = () => screen.root.findAll(node => node.type === Reflect.get(HubComposerSuggestionList, 'type'))[0]!;
    await vi.waitFor(() => {
        const suggestions = list().props.suggestions;
        expect(suggestions.find((entry: { kind: string }) => entry.kind === 'leftBehind')?.reason)
            .toBe(t('machineResources.askSuggestions.reasons.leftBehind', { count: 1 }));
        expect(suggestions.find((entry: { kind: string }) => entry.kind === 'storage')?.reason)
            .toBe(t('machineResources.askSuggestions.reasons.storage', { amount: '4 GB' }));
        expect(suggestions.some((entry: { kind: string }) => entry.kind === 'weeklyReview')).toBe(false);
    });
    const sessionsBefore = storage.getState().sessions;
    expect(sessionsBefore).toEqual({ [existingSession.id]: existingSession });
    expect(screen.root.findByType(NewSessionEmbeddedHostProvider).props.host.demanded).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    const suggestion = list().props.suggestions.find((entry: { kind: string }) => entry.kind === 'leftBehind');
    await screen.pressByTestIdAsync(`hub-composer.suggestion.${suggestion.id}`);
    const host: NewSessionEmbeddedHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    expect(host.params.prompt).toBe(suggestion.fill.text);
    expect(host.params.machineId).toBe(machine.id);
    expect(host.demanded).toBe(true);
    // Filling is explicit composer intent: it may load capabilities/catalogs, never resource facts or send a Session.
    expect(rpc.mock.calls.filter(([call]) => resourceMethods.has(call.method))).toEqual([]);
    expect(storage.getState().sessions).toBe(sessionsBefore);
    await screen.unmount();
});

it('mounts Ask with a real warmed summary and reads calm from canonical attention, not the value payload', async () => {
    const consoleErrors = vi.spyOn(console, 'error');
    await prepareSessionDraftPersistenceStorage();
    const serverId = 'srv_home_a';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://home-a.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const sampledAt = Date.now();
    const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: sampledAt, daemonStateVersion: 1, daemonState: {
        resources: { v: 1, vitals: { state: 'reporting' },
            host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } },
    } });
    await publishMachineInventoryForTest(captureActiveServerAccountScopeLifetime()!.scope, [machine]);
    storage.setState({ isDataReady: true, isSessionDraftsReady: true });
    rpc.mockResolvedValue({ state: 'reporting', sample: {
        v: 1, sampledAt, intervalMs: 15_000, cpu: { reported: true, busyPct: 20 },
        memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
        disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 },
    }, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] } });
    await machineResourceStore.read({ serverId, machineId: 'machine-a', expectedAccountId: captureActiveServerAccountScopeLifetime()!.scope.accountId, view: 'summary' });
    const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId="machine-a" machineName="Laptop" />);
    const overviewReason = () => {
        // The one suggestions surface the block mounts; its list is the derivation's output.
        const list = screen.root.findAll((node) => node.type === Reflect.get(HubComposerSuggestionList, 'type'))[0];
        const suggestions = (list?.props.suggestions ?? []) as readonly Readonly<{ kind?: string; reason?: string }>[];
        return suggestions.find((suggestion) => suggestion.kind === 'overview')?.reason;
    };
    expect(overviewReason()).toBe(t('machineResources.askSuggestions.reasons.calm'));
    const placeholder = t('machineResources.ask.placeholder', { machine: 'Laptop' });
    expect(screen.root.findAll((node) => typeof node.type === 'string' && node.props?.placeholder === placeholder).length).toBeGreaterThan(0);
    // Canonical attention can require the person even when every metric stays calm.
    await act(async () => storage.getState().applyMachines([{ ...machine,
        daemonStateVersion: 2, daemonState: { resources: { v: 1, vitals: { state: 'reporting' },
            host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'needs_you', reasons: [] } } },
    }], true, { sourceServerId: serverId }));
    expect(overviewReason()).toBe(t('machineResources.askSuggestions.reasons.currentReport'));
    const scope = captureActiveServerAccountScopeLifetime()!.scope;
    const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
    // A target-unavailable transport result overrides the recent heartbeat through the real presence owner.
    await act(async () => recordMachineRequestFailed({ ...scope, machineId: machine.id }));
    const offlineList = screen.root.findAll(node => node.type === Reflect.get(HubComposerSuggestionList, 'type'))[0]!;
    expect(offlineList.props.suggestions.map((entry: { kind: string }) => entry.kind)).toEqual(['lastReport', 'notifyWhenBack']);
    const lastReport = offlineList.props.suggestions.find((entry: { kind: string }) => entry.kind === 'lastReport');
    await screen.pressByTestIdAsync(`hub-composer.suggestion.${lastReport.id}`);
    const route = routePush.mock.lastCall![0] as { params: { draftId: string } };
    expect(readNewSessionDraftFromRepository({ scope, draftId: route.params.draftId })?.input).toBe(lastReport.fill.text);
    expect(consoleErrors.mock.calls.filter((args) => args.some((arg) => typeof arg === 'string'
        && /Cannot update a component.*while rendering/.test(arg)))).toEqual([]);
    await screen.unmount();
});
