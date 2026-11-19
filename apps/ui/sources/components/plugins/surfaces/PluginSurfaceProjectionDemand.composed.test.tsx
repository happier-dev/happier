import * as React from 'react';
import { readFileSync } from 'node:fs';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createRegistryHostV1, createPluginRegistrySourceDescriptorV1, projectPluginRegistrySourceDeclarationV1, RegistryFetchRequestV1Schema } from '@happier-dev/protocol/registries';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/deployment-templates/src/manifest';
import { CHANNELS_UI, PLUGIN_MANIFEST as CHANNELS_MANIFEST } from '../../../../../../packages/plugins/channels/src/manifest';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { NewAppScreen } from '@/components/projects/starters/NewAppScreen';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SESSION_CONSUMPTION_REPLACE_EVENT, SessionConsumptionReplaceV1Schema,
    SessionConsumptionReplaceAckV1Schema } from '@happier-dev/protocol/sessions/sessionConsumptionV1';
import { buildDeferredDaemonProjectionSections, demandedDaemonProjectionSections,
    DaemonContributionRegistryProjectionDescribeRequestSchema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionInputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema,
    PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE, PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createMachineFixture, createSessionFixture, flushHookEffects } from '@/dev/testkit';
import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { PluginPagePresentation } from '@/components/plugins/pages/PluginPagePresentation';
import { AppShellPluginUiProjectionProvider, AppShellPluginUiProjectionValueProvider, useAppShellPluginUiProjection,
    useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useConnectedServicesAgents } from '@/components/settings/connectedServices/model/useConnectedServicesAgents';
import PluginStoreKindSurface from '@/components/store/StorePluginKindSurface';
import { StoreDiscover } from '@/components/store/StoreDiscover';
import { listStoreKindContributions } from '@/components/store/catalog/storeKindContributions';
import { projectPluginStoreKindDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/storeKinds';
import { PluginSurfaceProjectionDemand } from './PluginSurfaceProjectionDemand';
import { MountedPluginActionControls } from './MountedPluginActionControls';
import { createPluginSurfaceActionControls } from './pluginSurfaceActionControls';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import { usePluginSurfaceExecutionOrigin } from './pluginSurfaceExecutionOrigin';
import { PluginMachineExecutionOriginSelectorView } from '@/components/settings/machines/PluginMachineExecutionOriginSelector';
import { SettingsCatalogOverviewGroup } from '@/components/settings/SettingsCatalogOverviewGroup';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { t } from '@/text';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useHappierInputPickerPort, type HappierInputPickerPort } from '@happier-dev/plugin-ui/presentation';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { ModalProvider } from '@/modal';
import { PluginPresentedExecutionOriginProjectionDemand } from '@/sync/domains/machines/administration/usePluginExecutionOriginProjectionDemand';
import { isPluginMachineExecutionOriginCandidateSelectable } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { readCurrentAppShellPluginUiExecutionOriginCandidates, readCurrentAppShellPluginUiProjection, subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { usePluginUiProjectionCurrentness, PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { pluginUiSections, REGISTRY_SOURCE_PROJECTION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry,
    readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');

afterEach(async () => {
    vi.useRealTimers();
    clearDaemonMergedProjectionCacheForTests();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    installDisconnectedServerSocketBoundary();
});

it.each(['page', 'widget', 'store', 'store-directory', 'store-declared-directory', 'starter', 'starter-warm'] as const)('shows Machine-installed contributions for a presented %s, with no closed or settled reads', async surface => {
    const accountId = 'presented-demand-account';
    const serverIdentityId = `srv_presented_demand_${surface}`;
    const starterSurface = surface === 'starter' || surface === 'starter-warm';
    const machine = createMachineFixture({ id: 'presented-machine', activeAt: starterSurface ? Date.now() : 0, storageMode: 'plain' });
    const row = createPlainMachineRowFixture({ id: machine.id, accountId, machine });
    const shippedManifest = PluginManifestV2Schema.parse(PLUGIN_MANIFEST);
    const pluginId = starterSurface ? shippedManifest.id : 'acme.preview';
    const pluginVersion = starterSurface ? shippedManifest.version : '1.0.0';
    const registrySources = starterSurface ? (shippedManifest.contributes.registrySources ?? []).map(definition => ({
        ...projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: shippedManifest.version,
            definition }),
        occurrenceId: `${pluginId}#1`,
    })) : [];
    const registryHost = createRegistryHostV1({ host: 'node',
        http: { getJson: async () => { throw new Error('Packaged catalog must not use HTTP'); },
            getText: async () => { throw new Error('Packaged catalog must not use HTTP'); },
            getBytes: async () => { throw new Error('Packaged catalog must not use HTTP'); } },
        readSources: async () => registrySources.map((entry: ReturnType<typeof projectPluginRegistrySourceDeclarationV1> & { occurrenceId: string }) =>
            createPluginRegistrySourceDescriptorV1({ ...entry, suppliers: [machine.id] })),
        packageContent: { read: async source => ({ text: readFileSync(new URL(
            `../../../../../../packages/plugins/deployment-templates/${source.packageContent.path}`, import.meta.url), 'utf8'), fetchedAt: 1 }) },
    });
    let materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId, machineId: machine.id,
        materializationId: 'preview-install', pluginId, version: pluginVersion, sourceClass: 'localPath',
        portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 });
    const widget = widgetProjectionEntry({ pluginId, localId: 'conversations', target: 'app' });
    // A Machine-local installation reports its runtime occurrence: Administration selects it from these facts.
    const { PluginMachineExecutionOriginV1Schema } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
    const sourceCustody = { kind: 'development', registeredRootId: 'preview-root' } as const;
    const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
        sourceRef: { machineId: machine.id, pluginId, sourceCustody } });
    const storeKind = projectPluginStoreKindDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
        id: 'theme', title: 'Themes', viewId: 'store', operations: {
            list: 'list', read: 'read', installed: 'installed', prepare: 'prepare', acquire: 'acquire', manage: 'manage',
        },
    } });
    const declaredDirectory = surface === 'store-declared-directory';
    if (declaredDirectory) materialization = PluginMachineMaterializationV1Schema.parse({ ...materialization,
        // Directory metadata does not depend on acquiring renderer declarations.
        declaredManifest: {
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Preview', engines: { happier: '^1.0.0' },
            contributes: { ui: { renderers: [{ id: 'body', kind: 'reactNative', artifact: 'body' }],
                views: [{ id: 'store', container: 'appPage', target: { kind: 'app' }, renderer: 'body', title: 'Store' }] },
            storeKinds: [storeKind.definition], actions: Object.values(storeKind.definition.operations).map(id => ({
                id, title: id, scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                execution: { target: 'daemon' },
            })) },
        },
    });
    // The cold Add census saw four Machines with 76/62/58/33 contributions.
    // Store discovery acquires live occurrences for packaged catalog reads,
    // including installations whose directory declarations are already known.
    const fleet = declaredDirectory ? [machine, ...Array.from({ length: 3 }, (_, index) =>
        createMachineFixture({ id: `directory-machine-${index}`, activeAt: 0, storageMode: 'plain' }))] : [machine];
    const rows = fleet.map(entry => entry.id === machine.id ? row
        : createPlainMachineRowFixture({ id: entry.id, accountId, machine: entry }));
    const counts = [76, 62, 58, 33];
    const fleetMaterializations = fleet.map((entry, machineIndex) => Array.from({ length: declaredDirectory ? counts[machineIndex]! : 1 }, (_, index) => {
        if (machineIndex === 0 && index === 0) return materialization;
        const id = `acme.directory-${machineIndex}-${index}`;
        return PluginMachineMaterializationV1Schema.parse({ ...materialization, machineId: entry.id,
            pluginId: id, materializationId: `install-${machineIndex}-${index}`,
            declaredManifest: { schemaVersion: 2, id, version: '1.0.0', displayName: id,
                engines: { happier: '^1.0.0' }, contributes: {} } });
    }));
    const deferred = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: 'e'.repeat(64),
        projection: PluginProjectionV2Schema.parse({ v: 2, generation: 41,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Preview', version: pluginVersion,
                enabled: true, source: { kind: 'localPath', locator: 'preview-install' }, occurrenceId: widget.occurrenceId,
                executionOrigin, sourceCustody } },
            familiesById: {
                ...(starterSurface ? { registrySources: { family: 'registrySources', entriesById: Object.fromEntries(registrySources.map((entry: { id: string }) => [entry.id, { ...entry, executionOrigin }])) } } : {}),
                storeKinds: { family: 'storeKinds', entriesById: { [storeKind.id]: storeKind } },
                pluginUi: { family: 'pluginUi', entriesById: { [widget.id]: widget } },
                skills: { family: 'skills', entriesById: { 'acme.unopened/unopened': {
                    id: 'acme.unopened/unopened', pluginId: 'acme.unopened', pluginVersion: '1.0.0',
                    definition: { id: 'unopened', directory: 'skills/unopened' },
                } } },
            },
        }) });
    const requests: ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>[] = [];
    // Only the Socket transport is substituted. Admission, cache, section
    // hydration, Account publication, currentness and mounted consumers are real.
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, packet) => {
            if (event === SESSION_CONSUMPTION_REPLACE_EVENT) return SessionConsumptionReplaceAckV1Schema.parse({
                ok: true, ...SessionConsumptionReplaceV1Schema.parse(packet),
            });
            if (event !== 'rpc-call') throw new Error(`Unexpected fixture Socket event: ${event}`);
            if (!packet || typeof packet !== 'object' || !('method' in packet)
                || typeof packet.method !== 'string' || !('params' in packet)) throw new Error('Invalid fixture RPC');
            const content = { mode: 'plain' as const };
            const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
            if (packet.method === `${machine.id}:daemon.registries.fetch`) {
                const result = await registryHost.fetchRequest(RegistryFetchRequestV1Schema.parse(decoded.params));
                return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
            }
            expect(fleet.some(entry => packet.method === `${entry.id}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)).toBe(true);
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(decoded.params);
            requests.push(request);
            const result = request.sectionRead ? deferred.read(request.sectionRead.digest, request.sectionRead.offset,
                request.sectionRead.includeDigests) : deferred.manifest;
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        });
    });
    const promptCatalog = createPromptLibraryCatalogBoundary();
    let availabilityCursor = 1;
    const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: `https://presented-${surface}.test`,
        serverIdentityId, accountId, accountMode: 'plain', currentAccount: starterSurface }], route: async request => {
        if (starterSurface && request.path.startsWith('/v1/actions/')) {
            // The Home HTTP boundary keeps the real Action envelope and registry host.
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.body);
            const actionId = request.path.split('/')[3];
            if (actionId !== 'registries.items.list' && actionId !== 'registries.items.read') throw new Error('Unexpected starter Action');
            return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                execution: { ok: true, result: await registryHost.execute(actionId, envelope.input) } }));
        }
        const promptResponse = await promptCatalog.handle(request.path, { method: request.method });
        if (promptResponse) return promptResponse;
        if (request.path === '/v1/machines') return Response.json(rows);
        if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
            id => rows.find(entry => entry.id === id) ?? null);
        if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'])
            return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor,
                snapshots: fleet.map((entry, index) => ({ serverIdentityId, machineId: entry.id,
                    materializations: index === 0 ? [materialization, ...fleetMaterializations[index]!.slice(1)] : fleetMaterializations[index]! })) }));
        if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
            const input = PluginAvailabilityIntentsListActionInputV1Schema.parse(request.body);
            const known = input.knownPluginIds ?? [];
            const page = known.slice(0, PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE);
            return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor, pluginIds: [],
                ...(known.length > page.length ? { nextCursor: page.at(-1) } : {}),
                intentReads: page.map(id => ({ pluginId: id, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor,
                    hostingCapability: { enabled: false }, intent: null, release: null, packageAssets: [], uiArtifacts: [] }) })), failedPluginIds: [] }));
        }
        return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method, headers: request.headers }) ?? undefined;
    } });
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(fleet, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, fleet.map(entry => entry.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const installedDirectory = readPluginAccountAvailability(lifetime.scope).readInstalledPlugins();
        if (declaredDirectory) {
            expect(installedDirectory.kind).toBe('available');
            if (installedDirectory.kind !== 'available') throw new Error('Expected directory declarations');
            expect(installedDirectory.plugins).toHaveLength(229);
            expect(installedDirectory.plugins.find(entry => entry.pluginId === pluginId)).toMatchObject({
            pluginId, installations: [{ declarationState: 'known',
                contributorDeclaration: { contributes: { storeKinds: [storeKind.definition] } },
                uiModel: { storeKindsById: { [storeKind.id]: { id: storeKind.id } } } }],
            });
        }
        const target = { machineId: machine.id, serverId, accountLifetime: lifetime };
        const partial = declaredDirectory ? null : await loadDaemonMergedProjectionCacheEntry({ ...target, sections: [] });
        if (!declaredDirectory) expect(partial).toMatchObject({ kind: 'ready' });
        if (surface === 'starter-warm') {
            // A prior process admitted this Machine's whole UI; only its presentation snapshot (installed packages and
            // plugin UI, never registry sources) survives the reload. Starters must not wait on the rest of the catalogue.
            const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
            await prepareWarmCacheEncryptionKey();
            expect(await loadDaemonMergedProjectionCacheEntry({ ...target, sections: PLUGIN_UI_SECTIONS })).toMatchObject({ kind: 'ready' });
            const { readPluginUiProjectionAdmissionSnapshot, pluginUiProjectionAdmissionTargetKey } = await import('@/sync/domains/plugins/ui/projectionWarmCache');
            const restored = readPluginUiProjectionAdmissionSnapshot({ scope: lifetime.scope, machineId: target.machineId,
                targetKey: pluginUiProjectionAdmissionTargetKey(target) });
            expect(Object.keys(restored?.surfacePlacementsById ?? {})).not.toEqual([]);
            expect(restored?.registrySourcesById).toEqual({});
            clearDaemonMergedProjectionCacheForTests();
            expect(await loadDaemonMergedProjectionCacheEntry({ ...target, sections: [] })).toMatchObject({ kind: 'ready' });
        }
        requests.length = 0;
        let current: ReturnType<typeof usePluginUiProjectionCurrentness> | undefined;
        function DeclaredDirectoryKinds() {
            const projection = useAppShellPluginUiProjection();
            return <>{listStoreKindContributions(projection.pluginUiProjection).filter(kind => kind.key === storeKind.id)
                .map(kind => React.createElement('StoreKind', { key: kind.key, testID: kind.key }))}</>;
        }
        const definition = { kind: 'installed', surface: { pluginId, localId: 'conversations' } } as const;
        function Presented({ visible }: Readonly<{ visible: boolean }>) {
            current = usePluginUiProjectionCurrentness({ ...target, load: false });
            if (starterSurface) return <AppShellPluginUiProjectionProvider>{visible ? <NewAppScreen onClose={() => {}} /> : null}</AppShellPluginUiProjectionProvider>;
            if (declaredDirectory) return <AppShellPluginUiProjectionProvider>
                <StoreDiscover demand={{ presented: visible }} project={null}>
                    {() => <DeclaredDirectoryKinds />}
                </StoreDiscover>
            </AppShellPluginUiProjectionProvider>;
            if (surface === 'store' || surface === 'store-directory') return <AppShellPluginUiProjectionValueProvider
                value={{ ...current, reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
                    reloadClientExecutables: () => {} }}>
                {surface === 'store' ? <PluginStoreKindSurface kind={storeKind.id}
                    input={{ mode: 'browse', presented: visible }} />
                    : <PluginSurfaceProjectionDemand accountScope={lifetime.scope} enabled={visible} />}
                {listStoreKindContributions(current.pluginUiProjection).filter(kind => kind.key === storeKind.id)
                    .map(kind => React.createElement('StoreKind', { key: kind.key, testID: kind.key }))}
            </AppShellPluginUiProjectionValueProvider>;
            // A presented page or widget shows one Administration-selected origin; the app shell owns that selection.
            return <AppShellPluginUiProjectionProvider>{surface === 'page' ? <PluginPagePresentation pluginId={pluginId} localId="channels"
                accountScope={lifetime.scope} visible={visible} demandProjection actions={null} /> : <WidgetSurface
                scope={{ ...lifetime.scope, owner: { kind: 'home' } }}
                instance={{ v: 1, id: 'cold-widget', definition, bindings: {} }}
                descriptor={readWidgetDescriptor(current.pluginUiProjection, definition)} appRuntime={current}
                providedContext={{}} enabled={visible} recordRevision="cold:1" presentation="content" testID="cold-widget"
                reference={React.createElement('ReadyWidgetReference', { testID: 'cold-widget-ready' })} />}</AppShellPluginUiProjectionProvider>;
        }
        tree = await renderWithAppProviders(<Presented visible={false} />);
        expect(current?.phase).toBe('establishing');
        expect(requests).toEqual([]);
        if (surface === 'store' || surface === 'store-directory') expect(tree.tree.root.findAllByProps({ testID: storeKind.id })).toHaveLength(0);
        await tree.update(<Presented visible />);
        if (declaredDirectory) {
            await waitForHomeGovernance(() => expect(tree!.tree.root.findAllByProps({ testID: storeKind.id })).toHaveLength(1));
            await waitForHomeGovernance(() => expect(current?.phase).toBe('current'));
            await flushHookEffects();
            // StoreDiscover intentionally requests allInstallations (35e95d33bdc).
            expect(requests.length).toBeGreaterThan(0);
            const settledReads = requests.length;
            await tree.update(<Presented visible={false} />);
            await tree.update(<Presented visible />);
            await flushHookEffects();
            expect(requests).toHaveLength(settledReads);
            // Losing directory declarations must retain the acquired live kind.
            materialization = PluginMachineMaterializationV1Schema.parse({ ...materialization,
                declaredManifest: undefined, declaredUiEntries: undefined, observedAt: 2 });
            availabilityCursor += 1;
            await act(async () => { await sync.refreshPluginAccountAvailability(); });
            await waitForHomeGovernance(() => expect(current?.phase).toBe('current'));
            expect(requests.length).toBeGreaterThan(0);
            expect(tree.tree.root.findAllByProps({ testID: storeKind.id })).toHaveLength(1);
            return;
        }
        if (starterSurface) {
            await waitForHomeGovernance(() => expect(tree!.tree.root.findAllByProps({ testID: 'newApp.starter:static-website' }).length).toBeGreaterThan(0));
            const starterIds = new Set(tree.tree.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('newApp.starter:')).map(node => node.props.testID));
            // Whole-repository starters replaced subdirectory examples (3dbb310bf51); Coder's Docker workspace joined (7640717bce9).
            expect(starterIds).toEqual(new Set(['newApp.starter:static-website', 'newApp.starter:expo-blank', 'newApp.starter:coder-docker']));
            await act(async () => { tree!.tree.root.findAllByProps({ testID: 'newApp.starter:static-website' })[0]!.props.onPress(); });
            const continueButton = tree.tree.root.findAllByProps({ testID: 'newApp.continue' })[0]!;
            expect(continueButton.props.disabled).toBeFalsy();
            await act(async () => { continueButton.props.onPress(); });
            expect(tree.tree.root.findAllByProps({ testID: 'newApp.description' }).length).toBeGreaterThan(0);
            // Deploy an app presents starter sources, not every plugin's UI: a cold open read the whole
            // catalogue in ~75 serial describe frames before its first starter (PFC-BUILD-1113, 2026-11-15).
            // The starters path issues zero describe frames for any other section.
            const unrelated = new Set(Object.entries(deferred.manifest.sections)
                .filter(([section]) => !['base', 'installedPackagesById', ...REGISTRY_SOURCE_PROJECTION_SECTIONS].includes(section))
                .map(([, digest]) => digest));
            expect(requests.length).toBeGreaterThan(0);
            expect(requests.filter(request => unrelated.has(request.sectionRead?.digest ?? ''))).toEqual([]);
            const loaded = readCachedDaemonMergedProjectionCacheEntry({ ...target, sections: REGISTRY_SOURCE_PROJECTION_SECTIONS })
                ?.deferredProjection?.loadedSections ?? [];
            expect(loaded).toContain('familiesById.registrySources');
            for (const unpresented of PLUGIN_UI_SECTIONS.filter(section => section !== 'familiesById.registrySources'))
                expect(loaded.filter(section => section.split('#')[0] === unpresented)).toEqual([]);
            const settledReads = requests.length;
            if (surface === 'starter-warm') {
                // The restored presentation stays published beside the starters (its plugin UI placements).
                expect(Object.keys(readCurrentAppShellPluginUiProjection({ scope: lifetime.scope, declarationsOnly: true })
                    ?.surfacePlacementsById ?? {})).not.toEqual([]);
            }
            await tree.update(<Presented visible={false} />);
            await flushHookEffects();
            expect(requests).toHaveLength(settledReads);
            return;
        }
        await waitForHomeGovernance(() => expect(current?.phase).toBe('current'));
        expect(requests.length).toBeGreaterThan(0);
        // The ready target manifest is reused. Framing remains the section
        // owner's concern; every needed digest/page is acquired at most once.
        expect(requests.every(request => request.sectionRead !== undefined)).toBe(true);
        expect(new Set(requests.map(request => JSON.stringify([request.sectionRead?.digest, request.sectionRead?.offset]))).size)
            .toBe(requests.length);
        const complete = readCachedDaemonMergedProjectionCacheEntry({ ...target, sections: PLUGIN_UI_SECTIONS });
        expect(complete).toMatchObject({ kind: 'ready' });
        expect(complete?.deferredProjection?.loadedSections).toEqual(expect.arrayContaining([
            ...(partial?.deferredProjection?.loadedSections ?? []), ...demandedDaemonProjectionSections(deferred.manifest, PLUGIN_UI_SECTIONS),
        ]));
        expect(complete?.deferredProjection?.loadedSections).not.toContain('familiesById.skills');
        if (surface === 'widget') expect(tree.tree.root.findAllByProps({ testID: 'cold-widget-ready' })).toHaveLength(1);
        if (surface === 'store' || surface === 'store-directory') expect(tree.tree.root.findAllByProps({ testID: storeKind.id })).toHaveLength(1);
        const settledReads = requests.length;
        await tree.update(<Presented visible />);
        await tree.update(<Presented visible={false} />);
        vi.useFakeTimers();
        await flushHookEffects({ cycles: 1, advanceTimersMs: 180_000 });
        expect(requests).toHaveLength(settledReads);
    } finally {
        vi.useRealTimers();
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

/** The measured 20-Machine cold fleet; only the Socket and HTTP transports are substituted. */
async function serveSourceFleet(options: Readonly<{ refuseProjection?: boolean; machineOnly?: boolean;
    channels?: boolean; writeAction?: boolean; inventoryGate?: Promise<void>; projectionGate?: Promise<void> }> = {}) {
    const { PluginMachineExecutionOriginV1Schema } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
    const accountId = 'source-fleet-account';
    const serverIdentityId = 'srv_source_fleet';
    const pluginId = options.channels ? CHANNELS_MANIFEST.id : 'acme.triage';
    const pluginVersion = options.channels ? CHANNELS_MANIFEST.version : '1.0.0';
    const channelUiEntries = options.channels
        ? projectPluginPortableUiDeclarationsV1(PluginManifestV2Schema.parse(CHANNELS_MANIFEST)) : {};
    const machines = Array.from({ length: 20 }, (_, index) => createMachineFixture({ id: `fleet-${String(index).padStart(2, '0')}`,
        activeAt: options.channels ? Date.now() : 0, storageMode: 'plain' }));
    const rows = machines.map(machine => createPlainMachineRowFixture({ id: machine.id, accountId, machine }));
    // The Channels keeper consumes the shipped declaration, through the same
    // canonical fixture projector as every installed widget host test.
    const channelWidget = CHANNELS_UI.views.find(view => view.container === 'widget' && view.target.kind === 'app')!;
    const widget = widgetProjectionEntry(options.channels ? { pluginId, localId: channelWidget.id, target: 'app',
        title: channelWidget.title.fallback, resources: channelWidget.resources, sizeDeclaration: channelWidget.sizeDeclaration,
        homeDefault: 'available' } : { pluginId, localId: 'inbox', target: 'app' });
    const projectionsByMachineId = new Map<string, ReturnType<typeof PluginProjectionV2Schema.parse>>();
    const rememberProjection = (id: string, projection: ReturnType<typeof PluginProjectionV2Schema.parse>) => {
        projectionsByMachineId.set(id, projection);
        return projection;
    };
    // Each Machine runs its own source checkout, so its section bodies are its own (no shared digests).
    const deferredByMachineId = new Map(machines.map(machine => {
        const sourceCustody = { kind: 'development', registeredRootId: `root-${machine.id}` } as const;
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
            sourceRef: { machineId: machine.id, pluginId, sourceCustody } });
        return [machine.id, buildDeferredDaemonProjectionSections({ protocolVersion: 1,
            projectionDigest: machine.id.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a'),
            projection: rememberProjection(machine.id, PluginProjectionV2Schema.parse({ v: 2, generation: 7,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: options.channels ? CHANNELS_MANIFEST.displayName : `Triage on ${machine.id}`, version: pluginVersion,
                    enabled: true, source: { kind: 'localPath', locator: `/src/${machine.id}/triage` }, occurrenceId: widget.occurrenceId, executionOrigin, sourceCustody } },
                ...(options.writeAction ? { actionsById: { [`${pluginId}/write`]: { id: 'write', pluginId, title: 'Write',
                    executionOrigin, occurrenceId: widget.occurrenceId, execution: { target: 'daemon' },
                    scopes: ['global'], surfaces: ['ui'], dangerLevel: 'writesRemote', confirmation: { title: 'Review write' }, available: true } } } : {}),
                familiesById: options.channels ? { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(
                    Object.entries(channelUiEntries).map(([id, entry]) => [id, { ...entry, occurrenceId: widget.occurrenceId, executionOrigin }]),
                ) } } : { ...(options.machineOnly ? { connectedAccounts: { family: 'connectedAccounts', entriesById: {
                    [`${pluginId}/source`]: { id: 'source', serviceId: 'source', pluginId,
                        title: 'Machine-only source', provenance: 'external', sourceKind: 'installed',
                        authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', title: 'Source credentials',
                            outcomeReconciliation: 'none', fields: [] }] }, capabilities: [],
                        availability: { state: 'available', reason: 'resolved' }, diagnostics: [] },
                } } } : {}), pluginUi: { family: 'pluginUi', entriesById: { [widget.id]: { ...widget, executionOrigin,
                    title: options.channels ? channelWidget.title.fallback : `Inbox on ${machine.id}` } } }, inputTypes: { family: 'inputTypes', entriesById: {
                    [`${pluginId}/comparison`]: { id: `${pluginId}/comparison`, pluginId, pluginVersion: '1.0.0',
                        occurrenceId: widget.occurrenceId, executionOrigin,
                        definition: { id: 'comparison', title: 'Pull request', semantic: 'scmPullRequestComparison',
                            valueSchema: { type: 'object' }, picker: 'browse' },
                        pickerSurface: { contribution: { pluginId, localId: 'comparison' }, occurrenceId: widget.occurrenceId,
                            projectionGeneration: 7, rendererChain: [{ pluginId, localId: 'browse' }],
                            selectedRenderer: { identity: { pluginId, localId: 'browse' },
                                renderer: { kind: 'declarative', contributionId: 'browse' },
                                availability: { state: 'available', reason: 'available', diagnostics: [] } },
                            executionOrigin, resourceCapability: { readable: false, dynamic: false },
                            contributorTargetedContributions: { target: { pluginId, occurrenceId: widget.occurrenceId, sourceCustody }, points: [] } },
                    },
                } } },
            })) })] as const;
    }));
    const sectionReadsByMachineId = new Map<string, string[]>();
    const requestsByMachineId = new Map<string, number>();
    const manifestReadsByMachineId = new Map<string, number>();
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, packet) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet)
                || typeof packet.method !== 'string' || !('params' in packet)) throw new Error('Invalid fixture RPC');
            const [machineId, method] = packet.method.split(/:(.*)/s);
            const deferred = deferredByMachineId.get(machineId!);
            if (!deferred || method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Daemon method unavailable', errorCode: 'RPC_METHOD_NOT_FOUND' };
            }
            requestsByMachineId.set(machineId!, (requestsByMachineId.get(machineId!) ?? 0) + 1);
            if (options.refuseProjection) return { ok: false, error: 'Daemon method unavailable', errorCode: 'RPC_METHOD_NOT_FOUND' };
            await options.projectionGate;
            const content = { mode: 'plain' as const };
            const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(decoded.params);
            if (!request.sectionRead) manifestReadsByMachineId.set(machineId!, (manifestReadsByMachineId.get(machineId!) ?? 0) + 1);
            if (request.sectionRead) {
                const reads = sectionReadsByMachineId.get(machineId!) ?? [];
                reads.push(request.sectionRead.digest);
                sectionReadsByMachineId.set(machineId!, reads);
            }
            const result = request.sectionRead ? deferred.read(request.sectionRead.digest, request.sectionRead.offset,
                request.sectionRead.includeDigests) : deferred.manifest;
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        });
    });
    const materializations = machines.map(machine => PluginMachineMaterializationV1Schema.parse({ serverIdentityId, machineId: machine.id,
        materializationId: `triage-${machine.id}`, pluginId, version: pluginVersion, sourceClass: 'localPath',
        portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 }));
    const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://source-fleet.test',
        serverIdentityId, accountId, accountMode: 'plain' }], route: async request => {
        if (request.path === '/v1/machines' || request.path === '/v1/machines/read-batch') {
            await options.inventoryGate;
            return request.path === '/v1/machines' ? Response.json(rows)
                : createMachineReadBatchResponseFixture(request.body, id => rows.find(row => row.id === id) ?? null);
        }
        if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'])
            return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1,
                snapshots: (options.machineOnly ? [] : materializations).map(materialization => ({ serverIdentityId, machineId: materialization.machineId,
                    materializations: [materialization] })) }));
        if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'])
            return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds: [],
                intentReads: [{ pluginId, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                    hostingCapability: { enabled: false }, intent: null, release: null, packageAssets: [], uiArtifacts: [] }) }], failedPluginIds: [] }));
        return undefined;
    } });
    return { accountId, pluginId, machines, home, sectionReadsByMachineId, requestsByMachineId, manifestReadsByMachineId,
        projectionsByMachineId, deferredByMachineId, widget };
}

it('discovers a Machine-only source from the presented Connect target with no Account installation census', async () => {
    const { accountId, pluginId, machines, home, requestsByMachineId, manifestReadsByMachineId } = await serveSourceFleet({ machineOnly: true });
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        expect(readPluginAccountAvailability(captureActiveServerAccountScopeLifetime()!.scope)?.readInstalledPlugins())
            .toMatchObject({ kind: 'available', plugins: [] });
        const target = { serverIdentityId: 'srv_source_fleet', machineId: machines[0]!.id };
        let current: ReturnType<typeof useAppShellPluginUiProjection> | undefined;
        let registry: ReturnType<typeof useProjectedConnectedServicesRegistry> | undefined;
        function PresentedConnect() {
            useConnectedServicesAgents({ agents: 'load', initialMachineTarget: target });
            current = useAppShellPluginUiProjection();
            registry = useProjectedConnectedServicesRegistry();
            return null;
        }
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><PresentedConnect /></AppShellPluginUiProjectionProvider>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: target.machineId, serverId, sections: [] })
                ?.deferredProjection?.loadedSections).toContain('familiesById.connectedAccounts');
        });
        expect([...requestsByMachineId.keys()]).toEqual([target.machineId]);
        expect(manifestReadsByMachineId.get(target.machineId)).toBe(1);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(registry?.entries).toContainEqual(expect.objectContaining({ service: { pluginId, localId: 'source' } }));
            expect(readWidgetDescriptor(current?.pluginUiProjection, { pluginId, localId: 'inbox' })).not.toBeNull();
            expect(current?.pluginUiProjection?.inputTypesById[`${pluginId}/comparison`]).toBeDefined();
        });
        expect([...requestsByMachineId.keys()]).toEqual([target.machineId]);
        expect(manifestReadsByMachineId.get(target.machineId)).toBe(1);
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it.each(['surface', 'Action control'] as const)('asks only the presented %s origin for packages and UI in a cold 20-Machine source fleet', async presentation => {
    const { accountId, pluginId, machines, home, sectionReadsByMachineId, requestsByMachineId } = await serveSourceFleet({ writeAction: true });
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    const controlLifetime = new AbortController();
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const uiSectionsLoaded = () => machines.filter(machine => readCachedDaemonMergedProjectionCacheEntry({
            machineId: machine.id, serverId, sections: pluginUiSections(pluginId) })?.kind === 'ready');
        const packagesLoaded = () => machines.filter(machine => readCachedDaemonMergedProjectionCacheEntry({
            machineId: machine.id, serverId, sections: [] })?.deferredProjection?.loadedSections.includes('installedPackagesById'));
        const surface: PluginUiSurfaceContextV1 = {
            pluginId: 'acme.target-host', contributionId: 'detail', surfaceId: 'detail', placement: 'appSurface',
            platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [],
        };
        const controls = createPluginSurfaceActionControls({
            pluginId: surface.pluginId, surfaceId: surface.surfaceId,
            projectionScope: lifetime.scope,
            hostAction: { execute: async () => ({ ok: false, errorCode: 'unavailable', error: 'unavailable' }) },
            signal: controlLifetime.signal, isCurrent: lifetime.isCurrent, captureCurrentBinding: () => lifetime.isCurrent,
        });
        // An embedded control can call another contributor whose catalogue the parent never presented.
        // While preparing a press, the plugin disables the presented control but still needs its Action.
        await controls.handleRequest({ version: 1, requestId: 'bind-write', surface, method: 'actionControl',
            payload: { kind: 'bind', subscriptionId: 'write', action: { pluginId, localId: 'write' },
                presentation: { title: 'Write', disabled: true } },
        }, { actionControlSubscription: { retain() {}, publish() {} } });
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider>
            {presentation === 'Action control' ? <MountedPluginActionControls controls={controls} />
                : <PluginSurfaceProjectionDemand pluginId={pluginId} accountScope={lifetime.scope} />}
        </AppShellPluginUiProjectionProvider>);
        // Account descriptors rank placement intent before exact runtime admission.
        // Unopened alternative origins do not acquire Machine projections.
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            const projection = readCurrentAppShellPluginUiProjection({ scope: lifetime.scope, declarationsOnly: true });
            expect(readPluginUiContributionOrigin(projection?.actionsById[`${pluginId}/write`]))
                .toMatchObject({ phase: 'current', interactionEnabled: true });
        });
        await flushHookEffects({ cycles: 3 });
        expect(packagesLoaded()).toHaveLength(1);
        const selected = uiSectionsLoaded().map(machine => machine.id);
        const reads = [...sectionReadsByMachineId].map(([id, digests]) => [id, digests.length] as const);
        expect({ selected: selected.length, reads: Object.fromEntries(reads) }).toMatchObject({ selected: 1 });
        // Non-selected installations remain entirely cold.
        for (const machine of machines) if (machine.id !== selected[0]) {
            expect(sectionReadsByMachineId.get(machine.id)?.length ?? 0).toBe(0);
            expect(requestsByMachineId.get(machine.id) ?? 0).toBe(0);
        }
    } finally {
        if (tree) await act(async () => tree.unmount());
        controlLifetime.abort();
        await home.dispose();
    }
});

it('repopulates the shipped Channels Settings catalog from a restored stale origin after a cold reload', async () => {
    const { accountId, pluginId, machines, home, requestsByMachineId, manifestReadsByMachineId } = await serveSourceFleet({ machineOnly: true, channels: true });
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const target = { machineId: machines[0]!.id, serverId, accountLifetime: lifetime };
        const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
        await prepareWarmCacheEncryptionKey();
        // A prior process admitted this exact source. Only its presentation
        // snapshot survives reload; live loader authority must be acquired again.
        expect(await loadDaemonMergedProjectionCacheEntry({ ...target, sections: PLUGIN_UI_SECTIONS })).toMatchObject({ kind: 'ready' });
        const { readPluginUiProjectionAdmissionSnapshot, pluginUiProjectionAdmissionTargetKey } = await import('@/sync/domains/plugins/ui/projectionWarmCache');
        expect(readPluginUiProjectionAdmissionSnapshot({ scope: lifetime.scope, machineId: target.machineId,
            targetKey: pluginUiProjectionAdmissionTargetKey(target) })?.installedPackagesById[pluginId]).toBeDefined();
        clearDaemonMergedProjectionCacheForTests();
        requestsByMachineId.clear();
        manifestReadsByMachineId.clear();
        let facts: ReturnType<typeof readCurrentAppShellPluginUiExecutionOriginCandidates> | undefined;
        let current: ReturnType<typeof useAppShellPluginUiProjection> | undefined;
        function PublishedSource() {
            const read = React.useCallback(() => readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId), []);
            facts = React.useSyncExternalStore(subscribeCommittedAppShellPluginUiProjection, read, read);
            current = useAppShellPluginUiProjection();
            const router = useRouter();
            return <SettingsCatalogOverviewGroup groupId="groupSessionsBehavior" router={router} />;
        }
        function Presented({ visible }: Readonly<{ visible: boolean }>) {
            return <AppShellPluginUiProjectionProvider>
                <PublishedSource />
                <PluginSurfaceProjectionDemand pluginId={pluginId} accountScope={lifetime.scope} enabled={visible} />
            </AppShellPluginUiProjectionProvider>;
        }
        tree = await renderWithAppProviders(<Presented visible={false} />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(facts?.sourceCandidates).toHaveLength(1);
            expect(facts?.sourceCandidates[0]).toMatchObject({
                source: { origin: { sourceRef: { machineId: target.machineId, pluginId } } },
                validation: { kind: 'rejected', reason: 'stale' },
            });
        });
        expect(requestsByMachineId.size).toBe(0);
        await tree.update(<Presented visible />);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(facts?.sourceCandidates[0]?.validation).toEqual({ kind: 'admitted' });
            expect(readCachedDaemonMergedProjectionCacheEntry({ ...target, sections: [] })
                ?.deferredProjection?.loadedSections).toContain('familiesById.pluginUi');
            expect(tree!.tree.root.findAll(node => typeof node.props.testID === 'string'
                && node.props.testID.startsWith('settings-plugin-page-item.') && node.props.title === 'Channels').length)
                .toBeGreaterThan(0);
            expect(Object.values(current?.pluginUiProjection?.settingsPagesById ?? {}))
                .toContainEqual(expect.objectContaining({ pluginId }));
        });
        await flushHookEffects({ cycles: 3 });
        expect([...requestsByMachineId.keys()]).toEqual([target.machineId]);
        expect(manifestReadsByMachineId.get(target.machineId)).toBe(1);
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('keeps Channels pending through held inventory HTTP until named origins populate the catalog', async () => {
    let releaseInventory!: () => void;
    const inventoryGate = new Promise<void>(resolve => { releaseInventory = resolve; });
    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>(resolve => { releaseProjection = resolve; });
    const { accountId, pluginId, machines, home, requestsByMachineId } = await serveSourceFleet({ channels: true,
        inventoryGate, projectionGate });
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    let execution: ReturnType<typeof usePluginSurfaceExecutionOrigin> | undefined;
    try {
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        function PresentedChannels() {
            const projection = useAppShellPluginUiProjection();
            execution = usePluginSurfaceExecutionOrigin({ pluginId, projection: projection.pluginUiProjection,
                enabled: true, includeMachineCandidates: true });
            const router = useRouter();
            return <>
                <PluginMachineExecutionOriginSelectorView pluginId={pluginId} selection={execution.selection}
                    machineCandidates={execution.selection.machineCandidates} testIDPrefix="channels-cold-origin" />
                <SettingsCatalogOverviewGroup groupId="groupSessionsBehavior" router={router} />
            </>;
        }
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider>
            <PluginSurfaceProjectionDemand pluginId={pluginId} accountScope={lifetime.scope} enabled />
            <PresentedChannels />
        </AppShellPluginUiProjectionProvider>);
        await flushHookEffects({ cycles: 3 });
        const originRow = () => tree!.tree.root.findAllByProps({ testID: 'channels-cold-origin.current' })[0]!;
        await waitForHomeGovernance(() => expect(home.httpRequests).toContainEqual(expect.objectContaining({ path: '/v1/machines' })));
        expect(originRow().props.title).toBe(t('common.loading'));
        expect(execution?.loading).toBe(true);
        releaseInventory();
        await waitForHomeGovernance(() => expect(storage.getState().machineListByServerId[home.homes.home!.id]).toHaveLength(machines.length));
        observeMachinePresenceForTest({ serverId: home.homes.home!.id, accountId }, machines.map(machine => machine.id));
        await waitForHomeGovernance(() => expect(requestsByMachineId.size).toBeGreaterThan(0));
        await flushHookEffects({ cycles: 3 });
        expect(originRow().props.title).toBe(t('common.loading'));
        expect(execution?.loading).toBe(true);
        releaseProjection();
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(execution?.loading).toBe(false);
            expect(execution?.selection.state.kind).toBe('selected');
            expect(originRow().props.title).toContain('tester.local');
            expect(tree!.tree.root.findAll(node => typeof node.props.testID === 'string'
                && node.props.testID.startsWith('settings-plugin-page-item.') && node.props.title === 'Channels').length)
                .toBeGreaterThan(0);
        });
    } finally {
        releaseInventory();
        releaseProjection();
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it.each(['picker', 'captured-session'] as const)('keeps a closed %s comparison picker cold and discovers its current contributed picker when opened', async surface => {
    const { accountId, machines, home, requestsByMachineId, manifestReadsByMachineId } = await serveSourceFleet();
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const machineId = machines[0]!.id;
        const picker = <InputTypePickerHostProvider enabled requiresPluginTypes={false}
            machineId={machineId} serverId={serverId}>
            <ScmComparisonScopePicker current={{ kind: 'workingTree' }} currentLabel="Working tree" fileCount={null}
                options={[{ comparison: null, sourceKind: 'pullRequest', group: 'explainOnly', label: 'Pull request',
                    subtitle: 'Select source evidence', fileCount: null }]} onSelect={() => {}} />
        </InputTypePickerHostProvider>;
        const { SessionScmReviewDetailsView } = await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const session = createSessionFixture({ id: 'captured-picker-session', serverId, active: true,
            metadata: { path: '/repo', machineId, host: 'source-fleet', flavor: 'codex' } });
        storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session } });
        tree = await renderWithAppProviders(surface === 'picker' ? picker
            : <AppPaneProvider><SessionScmReviewDetailsView sessionId={session.id} serverId={serverId}
                scopeId={`session:${session.id}`} target={{ comparison: { kind: 'session' }, view: 'files' }} /></AppPaneProvider>);
        await flushHookEffects({ cycles: 3 });
        expect([...requestsByMachineId.values()]).toHaveLength(0);
        const menu = () => tree!.tree.root.find(node => node.type === Reflect.get(ScmComparisonScopePicker, 'type')).findByType(DropdownMenu);
        await act(async () => menu().props.onOpenChange(true));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(menu().props.items).toContainEqual(expect.objectContaining({ id: 'pullRequest' }));
        });
        expect(requestsByMachineId.get(machineId)).toBeGreaterThan(0);
        expect(manifestReadsByMachineId.get(machineId)).toBe(1);
        expect(requestsByMachineId.size).toBe(1);
        await act(async () => menu().props.onOpenChange(false));
        await flushHookEffects({ cycles: 3 });
        expect(menu().props.items).toContainEqual(expect.objectContaining({ id: 'pullRequest' }));
        const settled = requestsByMachineId.get(machineId);
        await flushHookEffects({ cycles: 3 });
        expect(requestsByMachineId.get(machineId)).toBe(settled);
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('describes a supplied cold picker and opens its exact producer with current data', async () => {
    const { accountId, pluginId, machines, home, projectionsByMachineId, deferredByMachineId, requestsByMachineId } = await serveSourceFleet();
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    const controller = new AbortController();
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const machineId = machines[0]!.id;
        const supplied = normalizePluginUiProjection(projectionsByMachineId.get(machineId)!);
        let port: HappierInputPickerPort | null = null;
        function PickerProbe() { port = useHappierInputPickerPort(); return null; }
        const field = { path: 'comparison', title: 'Pull request', inputType: { pluginId, localId: 'comparison' } };
        tree = await renderWithAppProviders(<ModalProvider><InputTypePickerHostProvider enabled
            machineId={machineId} serverId={serverId} pluginUiProjection={supplied} pluginUiMachineId={machineId}>
            <PickerProbe />
        </InputTypePickerHostProvider></ModalProvider>);
        expect(port!.describe(field)).not.toBeNull();
        expect(requestsByMachineId.size).toBe(0);
        const old = projectionsByMachineId.get(machineId)!;
        const oldType = old.familiesById.inputTypes!.entriesById[`${pluginId}/comparison`]!;
        const fresh = PluginProjectionV2Schema.parse({ ...old, generation: 8, familiesById: { ...old.familiesById,
            inputTypes: { family: 'inputTypes', entriesById: { [oldType.id]: { ...oldType,
                pickerSurface: { ...oldType.pickerSurface!, projectionGeneration: 8 } } } } } });
        deferredByMachineId.set(machineId, buildDeferredDaemonProjectionSections({ protocolVersion: 1,
            projectionDigest: 'b'.repeat(64), projection: fresh }));
        const result = port!.pick({ field, value: undefined, signal: controller.signal });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(tree!.tree.root.findAll(node => node.props.surface?.projectionGeneration === 8
                && typeof node.props.onSettle === 'function')).toHaveLength(1);
        });
        expect(requestsByMachineId.size).toBe(1);
        const modal = tree.tree.root.find(node => node.props.surface?.projectionGeneration === 8
            && typeof node.props.onSettle === 'function');
        await act(async () => modal.props.onSettle({ kind: 'completed', input: { pullRequest: 17 } }));
        await expect(result).resolves.toEqual({ status: 'selected', value: { pullRequest: 17 } });
    } finally {
        controller.abort();
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('keeps a refused target visible in a cold 20-Machine fleet without discovering unopened origins', async () => {
    const { accountId, pluginId, machines, home, requestsByMachineId } = await serveSourceFleet({ refuseProjection: true });
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        let current: ReturnType<typeof usePluginSurfaceExecutionOrigin> | undefined;
        function PresentedSource() {
            current = usePluginSurfaceExecutionOrigin({ pluginId, projection: null, enabled: true, includeMachineCandidates: false });
            return null;
        }
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><PresentedSource /></AppShellPluginUiProjectionProvider>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(requestsByMachineId.size).toBe(1);
            expect(current?.selection.state).toMatchObject({ kind: 'unavailable', reasons: expect.arrayContaining(['daemon_unsupported']) });
        });
        await flushHookEffects({ cycles: 3 });
        expect(requestsByMachineId.size).toBe(1);
        expect(current?.selection.selectedOrigin).toBeNull();
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('admits opened origin rows in a cold 20-Machine fleet without acquiring their unopened UI families', async () => {
    const { accountId, pluginId, machines, home, requestsByMachineId } = await serveSourceFleet();
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        let facts: ReturnType<typeof readCurrentAppShellPluginUiExecutionOriginCandidates> | undefined;
        function PublishedCandidates() {
            const read = React.useCallback(() => readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId), []);
            facts = React.useSyncExternalStore(subscribeCommittedAppShellPluginUiProjection, read, read);
            return null;
        }
        const targets = machines.slice(0, 2).map(machine => ({ serverIdentityId: 'srv_source_fleet', machineId: machine.id }));
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider>
            <PublishedCandidates />
            <PluginPresentedExecutionOriginProjectionDemand targets={targets} />
        </AppShellPluginUiProjectionProvider>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(facts?.sourceCandidates.filter(isPluginMachineExecutionOriginCandidateSelectable)).toHaveLength(targets.length);
        });
        expect(requestsByMachineId.size).toBe(targets.length);
        for (const target of targets) {
            const cached = readCachedDaemonMergedProjectionCacheEntry({ machineId: target.machineId, serverId, sections: [] });
            expect(cached?.deferredProjection?.loadedSections).toContain('installedPackagesById');
            expect(cached?.deferredProjection?.loadedSections).not.toContain('familiesById.pluginUi');
            expect(cached?.deferredProjection?.loadedSections).not.toContain('familiesById.inputTypes');
        }
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('wakes no per-Machine demand while its acquisition settles', async () => {
    const { accountId, machines, home } = await serveSourceFleet();
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const loaded = () => machines.filter(machine => readCachedDaemonMergedProjectionCacheEntry({
            machineId: machine.id, serverId, sections: [] })?.deferredProjection?.loadedSections.includes('familiesById.pluginUi'));
        let updates = 0;
        tree = await renderWithAppProviders(<React.Profiler id="demand" onRender={(_id, phase) => { if (phase === 'update') updates += 1; }}>
            <PluginSurfaceProjectionDemand accountScope={lifetime.scope} enabled />
        </React.Profiler>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(loaded()).toHaveLength(machines.length);
        });
        await flushHookEffects({ cycles: 3 });
        // Machine facts the demand does not gate on (a renamed Machine) wake nothing; losing a Machine does.
        updates = 0;
        await act(async () => { storage.getState().applyMachines(machines.map(machine => ({ ...machine, metadataVersion: machine.metadataVersion + 1,
            metadata: { ...machine.metadata!, displayName: `Renamed ${machine.id}` } })), false, { sourceServerId: serverId }); });
        await flushHookEffects({ cycles: 2 });
        expect(updates).toBe(0);
        await act(async () => { storage.getState().applyMachines([{ ...machines[0]!, metadataVersion: machines[0]!.metadataVersion + 2,
            revokedAt: Date.now() }], false, { sourceServerId: serverId }); });
        await flushHookEffects({ cycles: 2 });
        expect(updates).toBeGreaterThan(0);
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it.each(['automatic', 'pinned'] as const)('advances the selected Machine to current or a settled refusal through every candidate transition (%s selection)', async choice => {
    const { PluginMachineExecutionOriginV1Schema } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
    const { setPluginMachineExecutionOriginPreference } = await import('@/sync/domains/machines/administration/selectionPreferences');
    const { usePluginSurfaceExecutionOrigin } = await import('./pluginSurfaceExecutionOrigin');
    const { readCurrentAppShellPluginUiProjection, subscribeCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
    const { getPluginMachineExecutionOriginRef } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
    const accountId = `seam-avail-${choice}`;
    const serverIdentityId = `srv_seam_avail_${choice}`;
    const pluginId = 'acme.triage';
    const machines = ['seam-a', 'seam-b'].map(id => createMachineFixture({ id, activeAt: 0, storageMode: 'plain' }));
    const rows = machines.map(machine => createPlainMachineRowFixture({ id: machine.id, accountId, machine }));
    const widget = widgetProjectionEntry({ pluginId, localId: 'inbox', target: 'app' });
    const originsByMachineId = new Map(machines.map(machine => [machine.id, PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
        sourceRef: { machineId: machine.id, pluginId, sourceCustody: { kind: 'development', registeredRootId: `root-${machine.id}` } } })]));
    const deferredByMachineId = new Map(machines.map(machine => {
        const sourceCustody = { kind: 'development', registeredRootId: `root-${machine.id}` } as const;
        const executionOrigin = originsByMachineId.get(machine.id)!;
        return [machine.id, buildDeferredDaemonProjectionSections({ protocolVersion: 1,
            projectionDigest: machine.id.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'b'),
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: `Triage on ${machine.id}`, version: '1.0.0',
                    enabled: true, source: { kind: 'localPath', locator: `/src/${machine.id}/triage` }, occurrenceId: widget.occurrenceId, executionOrigin, sourceCustody } },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [widget.id]: { ...widget, executionOrigin,
                    title: `Inbox on ${machine.id}` } } } },
            }) })] as const;
    }));
    // Socket boundary only. A Machine's daemon can be held (answer ordering) or refuse (invalid answer).
    const gates = new Map<string, Promise<void>>();
    const releases = new Map<string, () => void>();
    const hold = (machineId: string) => { gates.set(machineId, new Promise(resolve => releases.set(machineId, resolve))); };
    const release = (machineId: string) => { releases.get(machineId)?.(); gates.delete(machineId); };
    const refusing = new Set<string>();
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, packet) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet)
                || typeof packet.method !== 'string' || !('params' in packet)) throw new Error('Invalid fixture RPC');
            const [machineId, method] = packet.method.split(/:(.*)/s);
            const deferred = deferredByMachineId.get(machineId!);
            if (!deferred || method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Daemon method unavailable', errorCode: 'RPC_METHOD_NOT_FOUND' };
            }
            await gates.get(machineId!);
            const content = { mode: 'plain' as const };
            const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(decoded.params);
            const result = refusing.has(machineId!) ? { unexpected: true } : request.sectionRead
                ? deferred.read(request.sectionRead.digest, request.sectionRead.offset, request.sectionRead.includeDigests) : deferred.manifest;
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        });
    });
    const materializations = machines.map(machine => PluginMachineMaterializationV1Schema.parse({ serverIdentityId, machineId: machine.id,
        materializationId: `triage-${machine.id}`, pluginId, version: '1.0.0', sourceClass: 'localPath',
        portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 }));
    const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: `https://seam-avail-${choice}.test`,
        serverIdentityId, accountId, accountMode: 'plain' }], route: request => {
        if (request.path === '/v1/machines') return Response.json(rows);
        if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
            id => rows.find(row => row.id === id) ?? null);
        if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'])
            return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1,
                snapshots: materializations.map(materialization => ({ serverIdentityId, machineId: materialization.machineId,
                    materializations: [materialization] })) }));
        if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'])
            return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds: [],
                intentReads: [{ pluginId, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                    hostingCapability: { enabled: false }, intent: null, release: null, packageAssets: [], uiArtifacts: [] }) }], failedPluginIds: [] }));
        return undefined;
    } });
    const priorTargets = storage.getState().settings.machineAdministrationTargetsLocalV1;
    const pin = (machineId: string) => storage.setState({ settings: { ...storage.getState().settings,
        machineAdministrationTargetsLocalV1: setPluginMachineExecutionOriginPreference(priorTargets, pluginId, originsByMachineId.get(machineId)!) } });
    type Observed = Readonly<{ state: string; reasons: string; loading: boolean; machine: string | null; supply: string | null; supplyReason: string | null }>;
    let observed: Observed | undefined;
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        // Pinned: the selection is known before the Machine's candidate-only answer arrives.
        if (choice === 'pinned') { pin('seam-b'); hold('seam-b'); }
        function SelectedSurface() {
            const read = React.useCallback(() => readCurrentAppShellPluginUiProjection({ scope: lifetime.scope, declarationsOnly: true }), []);
            const projection = React.useSyncExternalStore(subscribeCommittedAppShellPluginUiProjection, read, read);
            const entry = projection?.surfacePlacementsById[widget.id] ?? null;
            const execution = usePluginSurfaceExecutionOrigin({ pluginId, projection, entry, enabled: true });
            const state = execution.selection.state;
            observed = { state: state.kind, reasons: state.kind === 'unavailable' || state.kind === 'conflict' ? state.reasons.join(',') : '',
                loading: execution.loading,
                machine: execution.selection.selectedOrigin ? getPluginMachineExecutionOriginRef(execution.selection.selectedOrigin).machineId : null,
                supply: execution.selectedSupply?.phase ?? null, supplyReason: execution.selectedSupply?.unavailableReasonCode ?? null };
            return null;
        }
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider>
            <PluginSurfaceProjectionDemand pluginId={pluginId} accountScope={lifetime.scope} enabled />
            <SelectedSurface />
        </AppShellPluginUiProjectionProvider>);
        // Presentation always advances: to the selected Machine's current supply, or a settled typed refusal.
        const settles = async (step: string, expected: (value: Observed) => boolean) => {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                const actual = { step, ...observed, ok: observed !== undefined && !observed.loading && expected(observed) };
                expect(actual).toEqual({ ...actual, ok: true });
            });
        };
        const currentOn = (machineId?: string) => (value: Observed) => value.state === 'selected' && value.supply === 'current'
            && (machineId === undefined || value.machine === machineId);
        if (choice === 'pinned') {
            await flushHookEffects({ cycles: 3 });
            release('seam-b');
        }
        await settles('initial', currentOn(choice === 'pinned' ? 'seam-b' : undefined));
        let selected = observed!.machine!;
        let other = machines.map(machine => machine.id).find(id => id !== selected)!;
        // A same-authority refresh re-reads while the supply stays current.
        publishMachineContributionRegistryProjectionInvalidation({ machineId: selected, serverId }, 'refresh');
        await settles('refresh', currentOn(selected));
        // An authority invalidation re-establishes, then becomes current again.
        // Auto may re-rank to another current installation while the incumbent re-establishes.
        publishMachineContributionRegistryProjectionInvalidation({ machineId: selected, serverId }, 'authority');
        await settles('authority', currentOn(choice === 'pinned' ? selected : undefined));
        selected = observed!.machine!;
        other = machines.map(machine => machine.id).find(id => id !== selected)!;
        // The selected Machine changes: the new selection hydrates its UI sections and becomes current.
        pin(other);
        await settles('reselect', currentOn(other));
        // The selected candidate becomes invalid: its daemon now refuses the projection.
        refusing.add(other);
        publishMachineContributionRegistryProjectionInvalidation({ machineId: other, serverId }, 'authority');
        // A failed re-read settles (the held answer or a typed refusal); it never stays establishing.
        await settles('refusal', () => true);
        // Inventory ineligibility: the pinned Machine leaves the Home's Machine inventory.
        refusing.delete(other);
        storage.getState().applyMachines(machines.filter(machine => machine.id === selected), true, { sourceServerId: serverId });
        await settles('ineligible', value => !(value.machine === other && value.supply === 'current'));
        // Unpinned again, Auto falls back to the remaining eligible Machine and it becomes current.
        storage.setState({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: priorTargets } });
        await settles('fallback', currentOn(selected));
    } finally {
        storage.setState({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: priorTargets } });
        for (const id of releases.keys()) release(id);
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});
