import * as React from 'react';
import type { Socket } from 'socket.io-client';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonContributionRegistryProjectionDescribeResponseSchema,
    PluginProjectionV2Schema, buildDeferredDaemonProjectionSections, demandedDaemonProjectionSections } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createHash } from 'node:crypto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createMachineFixture, flushHookEffects, renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { clearDaemonMergedProjectionCacheForTests, readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { usePluginUiProjectionCurrentness, PLUGIN_UI_SECTIONS } = await import('./usePluginUiProjectionCurrentness');
const { resolveMachineReachability, withdrawMachinePresenceForScope } = await import('@/sync/domains/machines/reachability/machineReachability');

afterEach(async () => {
    vi.useRealTimers();
    clearDaemonMergedProjectionCacheForTests();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    installDisconnectedServerSocketBoundary();
});

function ProjectionReader(props: Readonly<{ machineId: string; serverId: string; reader: string; load?: boolean;
    phases: Map<string, string> }>) {
    const projection = usePluginUiProjectionCurrentness(props);
    React.useLayoutEffect(() => { props.phases.set(props.reader, projection.phase); });
    return null;
}

it('describes 172 Machines once across unchanged reconnect cycles and refreshes only real projection changes', async () => {
    const ids = Array.from({ length: 172 }, (_, index) => `idle2-machine-${index}`);
    const machines = ids.map(id => createMachineFixture({ id, activeAt: 0, storageMode: 'plain',
        daemonStateVersion: 1, daemonState: { contributionRegistryProjectionRevision: 1 } }));
    const rows = new Map(machines.map(machine => [machine.id,
        createPlainMachineRowFixture({ id: machine.id, accountId: 'idle2-account', machine })]));
    const peer = createMachineFixture({ id: 'idle2-other-home', activeAt: 0, storageMode: 'plain' });
    const peerRow = createPlainMachineRowFixture({ id: peer.id, accountId: 'idle2-peer-account', machine: peer });
    const sockets: Socket[] = [];
    const described: string[] = [];
    const payloads: { machineId: string; full: boolean; bytes: number }[] = [];
    const generations = new Map<string, number>();
    installDisconnectedServerSocketBoundary(socket => {
        sockets.push(socket);
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, packet) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet)
                || typeof packet.method !== 'string' || !('params' in packet)) throw new Error('Invalid RPC packet');
            const machineId = packet.method.slice(0, packet.method.indexOf(':'));
            expect(packet.method).toBe(`${machineId}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`);
            const content = { mode: 'plain' as const };
            const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
            described.push(machineId);
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(decoded.params);
            const projection = PluginProjectionV2Schema.parse({ v: 2, generation: generations.get(machineId) ?? 41 });
            const projectionDigest = createHash('sha256').update(JSON.stringify(projection)).digest('hex');
            const unchanged = request.selection === undefined && request.knownProjectionDigest === projectionDigest;
            const result = unchanged
                ? { protocolVersion: 1, unchanged: true, projectionDigest }
                : DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection, projectionDigest });
            payloads.push({ machineId, full: !unchanged, bytes: new TextEncoder().encode(JSON.stringify(result)).length });
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        });
    });
    const batches: string[][] = [];
    const home = await serveAccountHomes({ homes: [
        { key: 'peer', serverUrl: 'https://idle2-peer.test', accountId: 'idle2-peer-account', accountMode: 'plain' },
        { key: 'home', serverUrl: 'https://idle2-home.test',
        accountId: 'idle2-account', accountMode: 'plain' }], route: request => {
        if (request.path === '/v1/machines') return Response.json(request.home === 'peer' ? [peerRow] : [...rows.values()]);
        if (request.path !== '/v1/machines/read-batch') return undefined;
        const response = createMachineReadBatchResponseFixture(request.body,
            id => request.home === 'peer' ? id === peer.id ? peerRow : null : rows.get(id) ?? null);
        batches.push((request.body as { machineIds: string[] }).machineIds);
        return response;
    } });
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId: 'idle2-account' }, ids);
        await publishMachineInventoryForTest({ serverId: home.homes.peer!.id, accountId: 'idle2-peer-account' }, [peer]);
        const activeSocket = sockets[0]!;
        const phases = new Map<string, string>();
        tree = await renderWithAppProviders(<>{ids.flatMap(machineId => ['shell', 'detail'].map(reader =>
            <ProjectionReader key={`${machineId}:${reader}`} machineId={machineId} serverId={serverId}
                reader={`${machineId}:${reader}`} phases={phases} />))}
            <ProjectionReader machineId={peer.id} serverId={home.homes.peer!.id} reader="peer" phases={phases} /></>);
        await waitForHomeGovernance(() => {
            expect(phases.size).toBe(345);
            expect([...new Set(phases.values())]).toEqual(['current']);
        });
        expect(described).toHaveLength(173);
        expect(payloads.filter(reply => reply.full)).toHaveLength(173);
        batches.length = 0;
        described.length = 0;
        payloads.length = 0;

        vi.useFakeTimers();
        let retryInstalls = 0;
        let retryFires = 0;
        const originalTimeout = globalThis.setTimeout;
        const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
            const retry = /scheduleRetry/.test(new Error().stack ?? '');
            if (retry) retryInstalls += 1;
            return originalTimeout(() => {
                if (retry) retryFires += 1;
                callback(...args);
            }, delay);
        });
        await flushHookEffects({ cycles: 1, advanceTimersMs: 180_000 });
        expect(batches).toEqual([]);
        expect(described).toEqual([]);
        expect({ retryInstalls, retryFires }).toEqual({ retryInstalls: 0, retryFires: 0 });
        timers.mockRestore();
        vi.useRealTimers();

        // Real SDK events enter apiSocket and Sync's registered reconnect path.
        for (let cycle = 0; cycle < 3; cycle += 1) {
            await act(async () => {
                activeSocket.disconnect(); activeSocket.connect();
            });
            await waitForHomeGovernance(async () => {
                // The Account observation can settle after the socket event and
                // withdraw the old presence epoch. Model the daemon's next
                // fresh ingress through the presence owner, not an online flag.
                await act(async () => { observeMachinePresenceForTest({ serverId, accountId: 'idle2-account' }, ids); });
                expect([...new Set(phases.values())]).toEqual(['current']);
            });
            expect(described).toEqual([]);
            expect(payloads).toEqual([]);
            expect(batches).toEqual([]);
        }

        const unchanged = { ...machines[0]!, daemonStateVersion: 2 };
        await act(async () => { storage.getState().applyMachines([unchanged], false, { sourceServerId: serverId }); });
        await flushHookEffects();
        expect(described).toEqual([]);

        batches.length = 0;
        described.length = 0;
        payloads.length = 0;
        generations.set(machines[0]!.id, 42);
        const changed = { ...machines[0]!, daemonStateVersion: 3, daemonState: { contributionRegistryProjectionRevision: 2 } };
        rows.set(changed.id, createPlainMachineRowFixture({ id: changed.id, accountId: 'idle2-account', machine: changed }));
        await act(async () => { storage.getState().applyMachines([changed], true, { sourceServerId: serverId }); });
        await waitForHomeGovernance(() => expect(described).toEqual([changed.id]));
        expect(payloads.map(reply => [reply.machineId, reply.full])).toEqual([[changed.id, true]]);
    } finally {
        vi.useRealTimers();
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it.each(['observed', 'withdrawn-online', 'withdrawn-offline', 'header-refresh', 'module-swap', 'module-error-swap', 'unpinned-header-handoff', 'unpinned-close-pending', 'unpinned-target-withdrawal', 'unpinned-page-revalidation', 'unpinned-page-change-pending', 'unpinned-page-hidden-pending'] as const)('admits the exact presented Runs-on Machine without a Session (%s), and leaves closed and offline candidates passive', scenario => withPopoverWebGlobals(async () => {
    const unpinnedHandoff = scenario === 'unpinned-header-handoff' || scenario === 'unpinned-close-pending'
        || scenario === 'unpinned-target-withdrawal' || scenario === 'unpinned-page-revalidation'
        || scenario === 'unpinned-page-change-pending' || scenario === 'unpinned-page-hidden-pending';
    const deferredRead = scenario === 'header-refresh' || scenario === 'module-swap' || unpinnedHandoff;
    const machine = createMachineFixture({ id: `picker-demand-${scenario}-machine`, activeAt: 0, storageMode: 'plain',
        daemonStateVersion: 1, daemonState: { contributionRegistryProjectionRevision: 1 } });
    const offline = createMachineFixture({ id: `picker-offline-${scenario}-machine`, active: false, activeAt: 0, storageMode: 'plain' });
    const machines = [machine, offline];
    const rows = new Map(machines.map(value => [value.id,
        createPlainMachineRowFixture({ id: value.id, accountId: 'picker-demand-account', machine: value })]));
    const described: string[] = [];
    const batches: string[][] = [];
    let failReads = scenario === 'module-error-swap';
    const methods: string[] = [];
    let finishDescribe: (() => void) | undefined;
    const pendingDescribe = new Promise<void>(resolve => { finishDescribe = resolve; });
    let sectionReads = 0;
    const sectionQuestions: string[] = [];
    const deferred = buildDeferredDaemonProjectionSections(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1, projectionDigest: 'b'.repeat(64), projection: { v: 2, generation: 41, familiesById: { pluginUi: {
            family: 'pluginUi', entriesById: { 'translations:acme.picker': {
                id: 'translations:acme.picker', pluginId: 'acme.picker', occurrenceId: 'picker-occurrence',
                contributionKind: 'translations', locales: ['en'], bundles: { en: { title: 'Picker' } },
            } },
        } } },
    }));
    const initialSectionQuestions = demandedDaemonProjectionSections(deferred.manifest, PLUGIN_UI_SECTIONS)
        .map(section => JSON.stringify([machine.id, deferred.manifest.sections[section], 0])).sort();
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, packet) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet)
                || typeof packet.method !== 'string' || !('params' in packet)) throw new Error('Invalid RPC packet');
            const target = packet.method.slice(0, packet.method.indexOf(':'));
            methods.push(packet.method);
            // The real open picker separately demands its row's memory summary
            // when presence settles. This Machine doesn't implement vitals.
            if (packet.method === `${target}:machines.vitals.get`) return {
                ok: false, error: 'Vitals unavailable', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            };
            expect(packet.method).toBe(`${target}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`);
            const content = { mode: 'plain' as const };
            const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(decoded.params);
            if (deferredRead && request.sectionRead) {
                sectionQuestions.push(JSON.stringify([target, request.sectionRead.digest, request.sectionRead.offset]));
                sectionReads += 1;
                // Hold only the first page while the header/module changes.
                // Subsequent pages follow the serial loader after release.
                if (sectionReads === 1) await pendingDescribe;
                const result = deferred.read(request.sectionRead.digest, request.sectionRead.offset,
                    request.sectionRead.includeDigests);
                return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
            }
            described.push(target);
            if (scenario === 'withdrawn-offline') return { ok: false, error: 'Machine is not connected', errorCode: 'target_unavailable' };
            if (failReads) throw new Error('External transport unavailable');
            if (deferredRead) return {
                ok: true, result: await socketRpcCodec.encodeResponse(content, deferred.manifest, decoded.callId),
            };
            const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 41 });
            const projectionDigest = createHash('sha256').update(JSON.stringify(projection)).digest('hex');
            const result = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection, projectionDigest });
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        });
    });
    const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: `https://picker-demand-${scenario}.test`,
        ...(scenario === 'module-swap' ? { serverIdentityId: 'srv_deferpub_r5' } : {}),
        accountId: 'picker-demand-account', accountMode: 'plain' }], route: request => {
        if (request.path === '/v1/machines') return Response.json([...rows.values()]);
        if (request.path === '/v1/machines/read-batch') {
            batches.push((request.body as { machineIds: string[] }).machineIds);
            return createMachineReadBatchResponseFixture(request.body, id => rows.get(id) ?? null);
        }
        return undefined;
    } });
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let disposeHost: (() => void) | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId: 'picker-demand-account' }, [machine.id]);
        const scope = { serverId, accountId: 'picker-demand-account' };
        const readDemandEntry = () => readCachedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId,
            ...(deferredRead ? { sections: PLUGIN_UI_SECTIONS } : {}) });
        if (scenario === 'withdrawn-online' || scenario === 'withdrawn-offline') {
            withdrawMachinePresenceForScope(scope);
            // A sibling has fresh presence; only this Machine lacks the advancing edge.
            observeMachinePresenceForTest(scope, [offline.id]);
            expect(resolveMachineReachability(scope, machine)).toBe('unknown');
        }
        batches.length = 0;
        const { PluginMachineExecutionOriginSelectorView } = await import('@/components/settings/machines/PluginMachineExecutionOriginSelector');
        const candidates = machines.map(value => ({
            source: { origin: { serverIdentityId: serverId, sourceRef: { machineId: value.id, pluginId: 'acme.plugin',
                sourceCustody: { kind: 'development' as const, registeredRootId: 'picker-source' } } },
                version: '0.0.0', occurrenceId: 'picker-occurrence', serverId },
            releaseContent: 'matched' as const, validation: { kind: 'rejected' as const, reason: 'source_not_ready' as const },
        }));
        const selection = {
            candidates, state: { kind: 'selectionRequired' as const, candidates }, selectedOrigin: null,
            canExecute: false, loading: false,
            selectOrigin: async () => ({ status: 'applied' as const, value: undefined }),
            clearOrigin: async () => ({ status: 'applied' as const, value: undefined }),
            resolveExecutionOrigin: () => null,
        };
        const { usePluginSurfaceExecutionOrigin } = await import('@/components/plugins/surfaces/pluginSurfaceExecutionOrigin');
        const { setPluginMachineExecutionOriginPreference } = await import('@/sync/domains/machines/administration/selectionPreferences');
        const { PluginReactNativeSurface } = await import('@/components/plugins/reactNative/PluginReactNativeSurface');
        const { PluginSurfacePageHeaderContext } = await import('@/components/plugins/shared/pluginSurfaceInteractionAvailability');
        const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
        const { createCanonicalPluginReactNativeHostApiAdapter } = await import('@/components/plugins/reactNative/hostApi');
        const { PluginPageIdentityHeaderProvider } = await import('@/components/plugins/shared/PluginPageIdentityHeader');
        const { PluginPagePresentation } = await import('@/components/plugins/pages/PluginPagePresentation');
        const surface = createPluginSurfaceContextFixture();
        const host = createCanonicalPluginReactNativeHostApiAdapter({ surface,
            requestSurface: { pluginId: 'acme.plugin', contributionId: 'picker', surfaceId: 'picker', placement: 'appPage',
                platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] }, handleRequest: async () => ({}) });
        disposeHost = host.dispose;
        const selectedTarget = { serverIdentityId: serverId, machineId: machine.id };
        const realSelection = { ...selection, candidates: [], storedTarget: selectedTarget, loading: true };
        const module = { renderSurface: () => unpinnedHandoff ? <PageHeader title="Picker" />
            : scenario === 'module-error-swap' ? <><PageHeader title="Picker" />
            <PluginMachineExecutionOriginSelectorView pluginId="acme.other" selection={selection}
                presentation="chip" testIDPrefix="demand.other" /></>
            : <PluginMachineExecutionOriginSelectorView selection={realSelection} presentation="chip" testIDPrefix="demand.real" /> };
        let commitModule: (() => void) | undefined;
        const moduleAnswer = new Promise<typeof module>(resolve => { commitModule = () => resolve(module); });
        const loadModule = () => moduleAnswer;
        function SelectedTargetOwner({ children }: React.PropsWithChildren) {
            usePluginSurfaceExecutionOrigin({ pluginId: 'acme.plugin', projection: null, enabled: true });
            return <>{children}</>;
        }
        if (scenario === 'module-swap') await act(async () => storage.setState({ settings: { ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: setPluginMachineExecutionOriginPreference({}, 'acme.plugin', candidates[0]!.source.origin) } }));
        const phases = new Map<string, string>();
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        // A hosted destination always carries its tab's navigation owner (WorkspaceShell, Inbox detail).
        const navigation = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
        const { Stack } = await import('@/components/appShell/workspace/destinationRoute');
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        let changePresentedTargets: ((presented: boolean) => void) | undefined;
        function PresentedPicker() {
            const [presented, setPresented] = React.useState(true);
            changePresentedTargets = setPresented;
            return <PluginMachineExecutionOriginSelectorView pluginId="acme.plugin"
                selection={presented ? selection : { ...selection, candidates: [] }}
                presentation="chip" testIDPrefix="demand.execution" />;
        }
        const picker = scenario === 'unpinned-target-withdrawal' ? <PresentedPicker />
            : <PluginMachineExecutionOriginSelectorView pluginId="acme.plugin" selection={selection} presentation="chip" testIDPrefix="demand.execution" />;
        const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { restoreWorkspaceNavigationEntry } = await import('@/components/appShell/workspace/workspaceNavigationHistory');
        let workspace = createWorkspaceState({ id: 'picker-demand', target: { kind: 'settings', params: {} }, pinned: true, preview: false });
        const page = () => <DestinationInstanceHost tabId="picker-demand" ref={workspace.tabs['picker-demand']!.target}
            pathname="/settings" focused visible navigation={navigation}>
            <Stack.Screen options={{ headerRight: () => picker }} />
            <PageHeader title="Picker" />
            <ProjectionReader machineId={machine.id} serverId={serverId} load={false} reader="shell" phases={phases} />
        </DestinationInstanceHost>;
        const nativeSurface = <PluginReactNativeSurface surfaceId={`deferpub-r5-${scenario}`}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={loadModule} loadPolicy={{ source: 'installedArtifact' }} cacheKey={`deferpub-r5-module-${scenario}`}
            renderContext={{ plugin: { id: 'acme.plugin', version: '1.0.0' }, surface,
                hostApi: host.api, signal: new AbortController().signal }} />;
        let changePageAvailability: ((available: boolean) => void) | undefined;
        let changeAddressedPage: ((localId: string) => void) | undefined;
        let changePageVisibility: ((visible: boolean) => void) | undefined;
        let bodyMounts = 0;
        function BodyLifetime() {
            React.useEffect(() => { bodyMounts += 1; }, []);
            return null;
        }
        function RevalidatingPage() {
            const [available, setAvailable] = React.useState(true);
            const [localId, setLocalId] = React.useState('picker');
            const [visible, setVisible] = React.useState(true);
            changePageAvailability = setAvailable;
            changeAddressedPage = setLocalId;
            changePageVisibility = setVisible;
            return <PluginPagePresentation pluginId="acme.plugin" localId={localId} accountScope={scope} visible={visible} actions={picker}>
                {!visible ? null : available ? <PluginPageIdentityHeaderProvider pluginId="acme.plugin" title="Picker" headerStyle="toolbar">
                    <BodyLifetime />{nativeSurface}
                </PluginPageIdentityHeaderProvider> : <PageHeader title="Picker" />}
            </PluginPagePresentation>;
        }
        screen = await renderScreen(scenario === 'module-error-swap' || unpinnedHandoff ? <DestinationInstanceHost tabId="picker-demand"
            ref={workspace.tabs['picker-demand']!.target} pathname="/settings" focused visible navigation={navigation}>
            <Stack.Screen options={{ headerRight: () => picker }} />
            <ProjectionReader machineId={machine.id} serverId={serverId} load={false} reader="shell" phases={phases} />
            {scenario === 'unpinned-page-revalidation' || scenario === 'unpinned-page-change-pending'
                || scenario === 'unpinned-page-hidden-pending' ? <RevalidatingPage /> : <PluginPagePresentation
                pluginId="acme.plugin" localId="picker" accountScope={scope} actions={picker}>
            <PluginPageIdentityHeaderProvider pluginId="acme.plugin" title="Picker" headerStyle="toolbar">
                {nativeSurface}
            </PluginPageIdentityHeaderProvider></PluginPagePresentation>}
        </DestinationInstanceHost> : scenario === 'module-swap' ? <SelectedTargetOwner>
            <ProjectionReader machineId={machine.id} serverId={serverId} load={false} reader="shell" phases={phases} />
            <PluginSurfacePageHeaderContext.Provider value={{ header: picker, loadingFrame: 'column' }}>
                {nativeSurface}
            </PluginSurfacePageHeaderContext.Provider>
        </SelectedTargetOwner> : scenario === 'header-refresh' ? page() : <>
            <ProjectionReader machineId={machine.id} serverId={serverId} load={false} reader="shell" phases={phases} />
            <PluginMachineExecutionOriginSelectorView selection={selection} presentation="chip" testIDPrefix="demand.execution" />
        </>);
        if (scenario !== 'module-swap') {
            expect(described).toEqual([]);
            expect(batches).toEqual([]);
        }
        await screen.pressByTestIdAsync('demand.execution.chip');
        await waitForHomeGovernance(() => expect(batches.length).toBeGreaterThan(0));
        await waitForHomeGovernance(() => {
            const entry = readDemandEntry();
            expect({ described, kind: entry?.kind, reason: entry?.kind === 'error' ? entry.reason : undefined })
                .toMatchObject({ described: [machine.id] });
        });
        if (scenario === 'module-error-swap') {
            expect(screen.findByTestId('plugin-rn-ui-loading')).not.toBeNull();
            await waitForHomeGovernance(() => expect(readDemandEntry()).toMatchObject({ kind: 'error', reason: 'transport-error' }));
            expect(described).toEqual([machine.id]);
            failReads = false;
            await act(async () => commitModule?.());
            await waitForHomeGovernance(() => expect(screen!.findByTestId('plugin-rn-ui-loading')).toBeNull());
            await waitForHomeGovernance(() => expect(screen!.findByTestId('demand.execution.picker-list')).not.toBeNull());
            expect(screen.findByTestId('demand.other.picker-list')).toBeNull();
            await waitForHomeGovernance(() => expect(readDemandEntry()?.kind).toBe('ready'));
            expect(described).toEqual([machine.id, machine.id]);
            await screen.pressByTestIdAsync('demand.execution.chip');
            await waitForHomeGovernance(() => expect(screen!.findByTestId('demand.execution.picker-list')).toBeNull());
            const settledReads = { admissions: batches.length, rpc: methods.length };
            vi.useFakeTimers();
            await flushHookEffects({ cycles: 1, advanceTimersMs: 180_000 });
            expect(described).toEqual([machine.id, machine.id]);
            expect({ admissions: batches.length, rpc: methods.length }).toEqual(settledReads);
            return;
        } else if (unpinnedHandoff) {
            await waitForHomeGovernance(() => expect(sectionQuestions).toHaveLength(1));
            expect(readDemandEntry()).toBeNull();
            expect(screen.findByTestId('plugin-rn-ui-loading')).not.toBeNull();
            if (scenario === 'unpinned-page-change-pending' || scenario === 'unpinned-page-hidden-pending') {
                await act(async () => {
                    if (scenario === 'unpinned-page-change-pending') changeAddressedPage?.('another-page');
                    else changePageVisibility?.(false);
                });
                await flushHookEffects();
                expect(screen.findByTestId('demand.execution.picker-list')).toBeNull();
                await act(async () => finishDescribe?.());
                await flushHookEffects();
                expect(readDemandEntry()).toBeNull();
                expect(described).toEqual([machine.id]);
                expect(sectionQuestions).toHaveLength(1);
                return;
            }
            if (scenario === 'unpinned-target-withdrawal') {
                await act(async () => changePresentedTargets?.(false));
                await flushHookEffects();
                // The page/body stays mounted: only the current candidate set
                // was withdrawn during catalog establishment, not open intent.
                expect(screen.findByTestId('plugin-rn-ui-loading')).not.toBeNull();
                await act(async () => changePresentedTargets?.(true));
                await flushHookEffects();
                expect(described).toEqual([machine.id]);
                expect(sectionQuestions).toHaveLength(1);
            }
            if (scenario === 'unpinned-page-revalidation') {
                expect(bodyMounts).toBe(1);
                await act(async () => changePageAvailability?.(false));
                expect(screen.findByTestId('plugin-rn-ui-loading')).toBeNull();
                await act(async () => changePageAvailability?.(true));
                await flushHookEffects();
                expect(bodyMounts).toBe(2);
                expect(described).toEqual([machine.id]);
                expect(sectionQuestions).toHaveLength(1);
            }
            // No remembered target owns this read: the open picker must carry
            // its presented demand from the fallback toolbar to the real header.
            await act(async () => commitModule?.());
            await waitForHomeGovernance(() => expect(screen!.findByTestId('plugin-rn-ui-loading')).toBeNull());
            await waitForHomeGovernance(() => expect(screen!.findByTestId('demand.execution.picker-list')).not.toBeNull());
            expect(described).toEqual([machine.id]);
            expect(sectionQuestions).toHaveLength(1);
            expect(readDemandEntry()).toBeNull();
            if (scenario === 'unpinned-close-pending') {
                await screen.pressByTestIdAsync('demand.execution.chip');
                await waitForHomeGovernance(() => expect(screen!.findByTestId('demand.execution.picker-list')).toBeNull());
                await act(async () => finishDescribe?.());
                await flushHookEffects();
                // Actual closure, unlike physical header replacement, retires
                // the final reader: late bytes must not publish or resume work.
                expect(readDemandEntry()).toBeNull();
                expect(sectionQuestions).toHaveLength(1);
                const settledReads = { admissions: batches.length, rpc: methods.length };
                vi.useFakeTimers();
                await flushHookEffects({ cycles: 1, advanceTimersMs: 180_000 });
                expect(described).toEqual([machine.id]);
                expect({ admissions: batches.length, rpc: methods.length }).toEqual(settledReads);
                return;
            }
            await act(async () => finishDescribe?.());
        } else if (scenario === 'module-swap') {
            await waitForHomeGovernance(() => expect(sectionQuestions).toHaveLength(1));
            expect(initialSectionQuestions).toContain(sectionQuestions[0]);
            expect(readDemandEntry()).toBeNull();
            await act(async () => commitModule?.());
            await waitForHomeGovernance(() => expect(screen!.findByTestId('demand.real.chip')).not.toBeNull());
            expect(screen.findByTestId('demand.execution.chip')).toBeNull();
            expect(screen.findByTestId('demand.real.picker-list')).toBeNull();
            expect(sectionQuestions).toHaveLength(1);
            expect(described).toEqual([machine.id]);
            expect(readDemandEntry()).toBeNull();
            await act(async () => finishDescribe?.());
        } else if (scenario === 'header-refresh') {
            // Changing a header callback must not replace its open picker.
            await waitForHomeGovernance(() => expect(sectionQuestions).toHaveLength(1));
            expect(initialSectionQuestions).toContain(sectionQuestions[0]);
            expect(readDemandEntry()).toBeNull();
            await screen.update(page());
            expect(screen.findByTestId('demand.execution.picker-list')).not.toBeNull();
            // Re-adopting the same browser entry is not a new destination.
            workspace = restoreWorkspaceNavigationEntry(workspace, { tabId: 'picker-demand', groupId: 'group:1',
                target: { kind: 'settings', params: {} } });
            await screen.update(page());
            expect(screen.findByTestId('demand.execution.picker-list')).not.toBeNull();
            expect(sectionQuestions).toHaveLength(1);
            expect(described).toEqual([machine.id]);
            expect(readDemandEntry()).toBeNull();
            await act(async () => finishDescribe?.());
        }
        if (scenario === 'withdrawn-offline') {
            await waitForHomeGovernance(() => expect(resolveMachineReachability(scope, storage.getState().machines[machine.id]!)).toBe('unreachable'));
            expect(described).toEqual([machine.id]);
            vi.useFakeTimers();
            await flushHookEffects({ cycles: 1, advanceTimersMs: 180_000 });
            expect(batches).toEqual([[machine.id]]);
            expect(described).toEqual([machine.id]);
            return;
        }
        await waitForHomeGovernance(() => expect(phases.get('shell')).toBe('current'));
        expect(readDemandEntry()).toMatchObject({ kind: 'ready' });
        expect(resolveMachineReachability(scope, storage.getState().machines[machine.id]!)).toBe('reachable');
        expect(described).toEqual([machine.id]);
        if (deferredRead) {
            // machineProjectionSections.ts admits included peer bodies and
            // reuses them before issuing another section RPC. Assert complete
            // hydration, including its content, rather than one RPC per index.
            const entry = readDemandEntry();
            if (entry?.kind !== 'ready') throw new Error('Expected hydrated projection demand');
            expect(entry.deferredProjection?.loadedSections).toEqual(expect.arrayContaining(
                demandedDaemonProjectionSections(deferred.manifest, PLUGIN_UI_SECTIONS),
            ));
            expect(entry.inputs.pluginProjectionV2?.familiesById.pluginUi).toMatchObject({
                entriesById: { 'translations:acme.picker': { bundles: { en: { title: 'Picker' } } } },
            });
        }
        // Neither header nor module replacement duplicates a physical byte read.
        expect(new Set(sectionQuestions).size).toBe(sectionQuestions.length);
        const vitalsReads = methods.filter(method => method === `${machine.id}:machines.vitals.get`).length;
        // This fixture refuses memory summaries. Each renewed visible demand
        // may therefore read once: candidate withdrawal/restoration adds one;
        // body unavailable/restored plus module handoff adds three. Projection
        // custody must still keep its manifest/section acquisition unique.
        const summaryDemands = scenario === 'unpinned-target-withdrawal' ? 3
            : scenario === 'unpinned-page-revalidation' ? 4 : unpinnedHandoff ? 2 : 1;
        expect(vitalsReads).toBeLessThanOrEqual(summaryDemands);
        // Serial section reads retain exact-target admission and cannot exceed
        // the logical read demand.
        expect(batches.length).toBeGreaterThan(0);
        expect(batches.every(batch => batch.length === 1 && batch[0] === machine.id)).toBe(true);
        expect(batches.length).toBeLessThanOrEqual(1 + sectionReads + vitalsReads);

        failReads = true;
        const changed = { ...machine, daemonStateVersion: 2, daemonState: { contributionRegistryProjectionRevision: 2 } };
        rows.set(changed.id, createPlainMachineRowFixture({ id: changed.id, accountId: 'picker-demand-account', machine: changed }));
        await act(async () => { storage.getState().applyMachines([changed, offline], true, { sourceServerId: serverId }); });
        await waitForHomeGovernance(() => expect(readDemandEntry()?.kind).toBe('error'));
        expect(described).toEqual([machine.id, machine.id]);

        const settledReads = { admissions: batches.length, rpc: methods.length };
        vi.useFakeTimers();
        await flushHookEffects({ cycles: 1, advanceTimersMs: 180_000 });
        expect(described).toEqual([machine.id, machine.id]);
        expect({ admissions: batches.length, rpc: methods.length }).toEqual(settledReads);
        if (scenario === 'observed') {
            vi.useRealTimers();
            failReads = false;
            // The daemon's existing push fact, not elapsed time or reopening the picker,
            // renews exact-Machine demand after a settled transport failure.
            const recovered = { ...changed, daemonStateVersion: 3,
                daemonState: { contributionRegistryProjectionRevision: 3 } };
            rows.set(machine.id, createPlainMachineRowFixture({ id: machine.id, accountId: 'picker-demand-account', machine: recovered }));
            await act(async () => storage.getState().applyMachines([recovered, offline], true, { sourceServerId: serverId }));
            await waitForHomeGovernance(() => expect(readDemandEntry()).toMatchObject({ kind: 'ready' }));
            await waitForHomeGovernance(() => expect(phases.get('shell')).toBe('current'));
            expect(described).toEqual([machine.id, machine.id, machine.id]);
            // Equal registry facts and unrelated daemon state are not new read demand.
            const unrelated = { ...recovered, daemonStateVersion: 4 };
            rows.set(machine.id, createPlainMachineRowFixture({ id: machine.id, accountId: 'picker-demand-account', machine: unrelated }));
            await act(async () => storage.getState().applyMachines([unrelated, offline], true, { sourceServerId: serverId }));
            vi.useFakeTimers();
            await flushHookEffects({ cycles: 1, advanceTimersMs: 180_000 });
            expect(described).toEqual([machine.id, machine.id, machine.id]);
        }
        if (scenario === 'header-refresh') {
            const reads = methods.length;
            await screen.update(page());
            expect(screen.findByTestId('demand.execution.picker-list')).not.toBeNull();
            expect(methods).toHaveLength(reads);
            // A genuinely different destination still retires the old control.
            workspace = restoreWorkspaceNavigationEntry(workspace, { tabId: 'picker-demand', groupId: 'group:1',
                target: { kind: 'settings', params: { pageId: 'language' } } });
            await screen.update(page());
            expect(screen.findByTestId('demand.execution.picker-list')).toBeNull();
            expect(methods).toHaveLength(reads);
        }
    } finally {
        finishDescribe?.();
        vi.useRealTimers();
        await screen?.unmount();
        disposeHost?.();
        await home.dispose();
    }
}));
