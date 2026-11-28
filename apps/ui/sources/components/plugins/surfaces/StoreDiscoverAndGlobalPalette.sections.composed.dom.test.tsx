/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeRequestSchema,
    PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionInputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema, PluginAvailabilityMaterializationsReadActionOutputV1Schema,
    PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { projectPluginStoreKindDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/storeKinds';
import { projectPluginRegistrySourceDeclarationV1 } from '@happier-dev/protocol/registries';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SESSION_CONSUMPTION_REPLACE_EVENT, SessionConsumptionReplaceAckV1Schema,
    SessionConsumptionReplaceV1Schema } from '@happier-dev/protocol/sessions/sessionConsumptionV1';
import { installBrowserStorageLockBoundary } from '@/dev/testkit';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { type AppShellPluginUiProjectionValue, AppShellPluginUiProjectionProvider, useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CommandPaletteProvider } from '@/components/appShell/commandPalette/CommandPaletteProvider';
import { useUniversalSearchRuntime, type UniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { CurrentRouteLocationProvider } from '@/components/appShell/workspace/currentRouteLocation';
import { AppShellColumnContext } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { StoreScreen } from '@/components/store/StoreScreen';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ModalProvider } from '@/modal';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { setPluginMachineExecutionOriginPreference } from '@/sync/domains/machines/administration/selectionPreferences';
import { clearDaemonMergedProjectionCacheForTests, readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});
// Use the actual web platform adapter so overlays, focus and navigation events have DOM hosts.
vi.mock('react-native', async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
const { storage } = await import('@/sync/domains/state/storage');
await import('@/components/appShell/search/UniversalSearchModal');

const accountId = 'cold-views-account';
const pluginId = 'acme.cold-views';
const actionKey = `${pluginId}/inspect`;
const storeKindKey = `${pluginId}/theme`;
const inputTypeKey = `${pluginId}/comparison`;
const resourceKey = `${pluginId}/status`;
const fieldTitle = (machineId: string) => `Inspection reason on ${machineId}`;

function machineExecutionOrigin(serverIdentityId: string, machineId: string) {
    return PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId, sourceRef: {
        machineId, pluginId, sourceCustody: { kind: 'development', registeredRootId: `root-${machineId}` },
    } });
}

function buildMachineProjection(serverIdentityId: string, machineId: string, digest: string) {
    const sourceCustody = { kind: 'development', registeredRootId: `root-${machineId}` } as const;
    const executionOrigin = machineExecutionOrigin(serverIdentityId, machineId);
    const occurrence = { executionOrigin, occurrenceId: `${pluginId}#1` };
    const widget = widgetProjectionEntry({ pluginId, localId: 'preview', target: 'app', ...occurrence });
    const storeKind = projectPluginStoreKindDeclarationV1({
        pluginId, pluginVersion: '1.0.0', definition: {
            id: 'theme', title: 'Fleet themes', viewId: 'preview',
            operations: { list: 'list', read: 'read', installed: 'installed', prepare: 'prepare', acquire: 'acquire', manage: 'manage' },
        },
    });
    const registrySource = projectPluginRegistrySourceDeclarationV1({
        pluginId, pluginVersion: '1.0.0', definition: {
            id: `catalog-${machineId}`, title: 'Fleet catalog', format: 'happier-catalog', kinds: ['app'],
            packageContent: { path: 'resources/catalog.json' },
        },
    });
    return buildDeferredDaemonProjectionSections({
        protocolVersion: 1, projectionDigest: digest,
        projection: PluginProjectionV2Schema.parse({
            v: 2, generation: 1,
            installedPackagesById: { [pluginId]: {
                ...occurrence, sourceCustody, id: pluginId, version: '1.0.0', displayName: 'Fleet preview',
                enabled: true, source: { kind: 'localPath', locator: `/src/${machineId}/preview` },
            } },
            actionsById: { [actionKey]: {
                ...occurrence, id: 'inspect', pluginId, title: 'Inspect fleet preview',
                execution: { target: 'daemon' }, scopes: ['global'], surfaces: ['ui'],
                placementBindings: ['commandPalette'], dangerLevel: 'safe', available: true,
                inputHints: { fields: [{ path: 'reason', title: fieldTitle(machineId), widget: 'text', required: true }] },
            } },
            resourcesById: { [resourceKey]: {
                ...occurrence, id: 'status', pluginId, resourceKind: 'config', scope: 'global', contentType: 'application/json',
            } },
            familiesById: {
                pluginUi: { family: 'pluginUi', entriesById: { [widget.id]: widget } },
                inputTypes: { family: 'inputTypes', entriesById: { [inputTypeKey]: {
                    ...occurrence, id: inputTypeKey, pluginId, pluginVersion: '1.0.0',
                    definition: { id: 'comparison', title: 'Pull request', semantic: 'scmPullRequestComparison', valueSchema: { type: 'object' } },
                } } },
                storeKinds: { family: 'storeKinds', entriesById: { [storeKindKey]: { ...storeKind, ...occurrence } } },
                registrySources: { family: 'registrySources', entriesById: { [registrySource.id]: { ...registrySource, ...occurrence } } },
                connectedAccounts: { family: 'connectedAccounts', entriesById: {} },
                backupDestinations: { family: 'backupDestinations', entriesById: {} },
                pluginBrowser: { family: 'pluginBrowser', entriesById: {} },
                subjectKinds: { family: 'subjectKinds', entriesById: {} },
                themes: { family: 'themes', entriesById: {} },
                voiceProviders: { family: 'voiceProviders', entriesById: {} },
            },
        }),
    });
}

function installProjectionBoundary(serverIdentityId: string, machines: readonly ReturnType<typeof createHydratedPlainMachineFixture>[]) {
    const outputs = new Map(machines.map((machine, index) => [machine.id, {
        projection: buildMachineProjection(serverIdentityId, machine.id, String(index + 1).repeat(64)), manifests: 0,
        demanded: [] as string[], delivered: [] as string[],
    }]));
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, packet) => {
            if (event === SESSION_CONSUMPTION_REPLACE_EVENT) return SessionConsumptionReplaceAckV1Schema.parse({
                ok: true, ...SessionConsumptionReplaceV1Schema.parse(packet),
            });
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet) || typeof packet.method !== 'string'
                || !('params' in packet)) throw new Error('Invalid fixture RPC');
            const { method } = packet;
            const machineId = machines.find(machine => method === `${machine.id}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)?.id;
            const output = machineId ? outputs.get(machineId) : undefined;
            if (!output) return { ok: false, error: 'Unexpected RPC', errorCode: 'RPC_METHOD_NOT_FOUND' };
            const content = { mode: 'plain' } as const;
            const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, method);
            const { sectionRead } = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(decoded.params);
            const { manifest, read } = output.projection;
            const result = sectionRead ? read(sectionRead.digest, sectionRead.offset, sectionRead.includeDigests) : manifest;
            if (!sectionRead) output.manifests++;
            else if (result && 'sectionBody' in result) {
                const requested = new Set([sectionRead.digest, ...(sectionRead.includeDigests ?? [])]);
                const returned = new Set([result.digest, ...(result.bodies?.map(body => body.digest) ?? [])]);
                for (const [section, digest] of Object.entries(manifest.sections)) {
                    if (section === 'base' || section === 'installedPackagesById') continue;
                    if (requested.has(digest)) output.demanded.push(section);
                    if (returned.has(digest)) output.delivered.push(section);
                }
            }
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        });
    });
    return outputs;
}

it.each(['desktop Store Discover', 'global command palette'] as const)('cold %s delivers only its own section bodies on each eligible Machine', async surface => {
    const restoreLocks = installBrowserStorageLockBoundary();
    const store = surface === 'desktop Store Discover';
    const homeKey = store ? 'store' : 'palette';
    const serverIdentityId = `srv_cold_views_${homeKey}`;
    const machines = ['studio', 'lab'].map(place => createHydratedPlainMachineFixture({
        id: `${homeKey}-${place}`, accountId, machine: { activeAt: Date.now() },
    }));
    const counted = installProjectionBoundary(serverIdentityId, machines);
    const rows = machines.map(machine => createPlainMachineRowFixture({ id: machine.id, accountId, machine }));
    const promptCatalog = createPromptLibraryCatalogBoundary();
    let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: `https://cold-${homeKey}.test`, serverIdentityId,
            accountId, accountMode: 'plain' }], route: async request => {
            if (request.path === '/v1/machines') return Response.json(rows);
            if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
                id => rows.find(row => row.id === id) ?? null);
            if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1,
                    snapshots: machines.map(({ id: machineId }) => ({ serverIdentityId, machineId, materializations: [
                        PluginMachineMaterializationV1Schema.parse({ serverIdentityId, machineId, materializationId: `materialized-${machineId}`,
                            pluginId, version: '1.0.0', sourceClass: 'localPath', portableRelease: false, uiArtifacts: [],
                            enabled: true, trustState: 'trusted', observedAt: 1 }),
                    ] })),
                }));
            }
            if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                const { knownPluginIds, pluginIds } = PluginAvailabilityIntentsListActionInputV1Schema.parse(request.body);
                return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds: [], failedPluginIds: [],
                    intentReads: (knownPluginIds ?? pluginIds ?? []).map(pluginId => ({ pluginId, response: {
                        availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release: null, packageAssets: [], uiArtifacts: [],
                    } })),
                }));
            }
            return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method, headers: request.headers })
                ?? await promptCatalog.handle(request.path, { method: request.method, body: JSON.stringify(request.body) })
                ?? undefined;
        } });
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        await sync.refreshPluginAccountAvailability();
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const availability = readPluginAccountAvailability(lifetime.scope);
        expect(availability.readInstalledPlugins()).toMatchObject({ kind: 'available' });
        expect(availability.readUiProjectionInputs()?.unavailableReasonCode).toBeUndefined();
        const selectedMachine = machines[1]!.id;
        const selectedOrigin = machineExecutionOrigin(serverIdentityId, selectedMachine);
        if (!store) {
            const { settings } = storage.getState();
            storage.setState({ settings: { ...settings, machineAdministrationTargetsLocalV1:
                setPluginMachineExecutionOriginPreference(settings.machineAdministrationTargetsLocalV1, pluginId, selectedOrigin) } });
        }

        let search: UniversalSearchRuntime;
        let projection: AppShellPluginUiProjectionValue;
        const push = vi.fn();
        const navigation = { push, pushRetainingCurrent: push, replace: vi.fn(), back: vi.fn(), setParams: vi.fn() };
        function ReadRuntime() {
            search = useUniversalSearchRuntime();
            return null;
        }
        function ReadProjection() {
            projection = useAppShellPluginUiProjection(value => value);
            return null;
        }
        function Presented({ open }: { open: boolean }) {
            return <CurrentRouteLocationProvider value={{ pathname: '/plugins', params: {} }}>
                <AppShellPluginUiProjectionProvider><ReadProjection /><InjectedAuthProvider credentials={null}>
                    <ModalProvider><AppPaneProvider>
                        {store ? <AppShellColumnContext.Provider value={{ present: true, columnVisible: false }}>
                            {open ? <DestinationInstanceHost tabId="cold-store" ref={{ kind: 'plugins', params: {} }}
                                pathname="/plugins" focused visible navigation={navigation}>
                                <StoreScreen />
                            </DestinationInstanceHost> : null}
                        </AppShellColumnContext.Provider> : <CommandPaletteProvider><ReadRuntime /></CommandPaletteProvider>}
                    </AppPaneProvider></ModalProvider>
                </InjectedAuthProvider></AppShellPluginUiProjectionProvider>
            </CurrentRouteLocationProvider>;
        }
        await act(async () => root.render(<Presented open={false} />));
        expect([...counted.values()].map(output => output.manifests)).toEqual([0, 0]);
        if (store) await act(async () => root.render(<Presented open />));
        else await act(async () => search!.open());

        const expected = store ? ['familiesById.pluginUi', 'familiesById.registrySources', 'familiesById.storeKinds', 'resourcesById']
            : ['actionsById', 'familiesById.inputTypes', 'familiesById.pluginUi', 'resourcesById'];
        await waitForHomeGovernance(() => {
            for (const machine of machines) {
                expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId, accountLifetime: lifetime,
                    sections: expected })?.kind).toBe('ready');
            }
        });
        const observed = [...counted].map(([machineId, { manifests, demanded, delivered }]) => ({
            machineId, manifests, demanded: [...demanded].sort(), delivered: [...delivered].sort(),
        }));
        console.info('COLD_SECTION_COUNTS', surface, JSON.stringify(observed));
        expect(observed).toEqual(machines.map(machine => ({ machineId: machine.id, manifests: 1, demanded: expected, delivered: expected })));

        if (store) {
            const destination = await waitForHomeGovernance(() => {
                const chip = container.querySelector<HTMLElement>(`[data-testid="store.discover.chips.kind.${storeKindKey}"]`);
                expect(chip?.textContent).toContain('Fleet themes');
                return chip!;
            });
            await act(async () => destination.click());
            expect(push.mock.calls[0]?.[0]).toContain('view=kind');
            expect(push.mock.calls[0]?.[0]).toContain(encodeURIComponent(storeKindKey));
        } else {
            await waitForHomeGovernance(() => {
                const fields = projection!.pluginUiProjection!;
                for (const entry of [fields.actionsById[actionKey], fields.inputTypesById[inputTypeKey], fields.resourcesById[resourceKey]]) {
                    expect(readPluginUiContributionOrigin(entry)).toMatchObject({
                        phase: 'current', interactionEnabled: true, machineId: selectedMachine, serverId, executionOrigin: selectedOrigin,
                    });
                }
            });
            const command = await waitForHomeGovernance(() => {
                const entry = search!.buildCommands(null).find(item => item.actionSpecId === actionKey);
                expect(entry).toMatchObject({ title: 'Inspect fleet preview' });
                return entry!;
            });
            await act(async () => command.action());
            await waitForHomeGovernance(() => expect(document.body.textContent).toContain(fieldTitle(selectedMachine)));
            expect(document.body.textContent).not.toContain(fieldTitle(machines[0]!.id));
            expect(projection!.registrySourcesPendingTargets?.map(target => target.machineId).sort()).toEqual(machines.map(machine => machine.id).sort());
        }
        expect(projection!.hasEstablishingMembers).toBe(true);
        for (const machine of machines) {
            expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId, accountLifetime: lifetime, sections: [] })
                ?.deferredProjection?.loadedSections).not.toContain('familiesById.connectedAccounts');
        }
    } finally {
        await act(async () => root.unmount());
        container.remove();
        await home?.dispose();
        restoreLocks();
        clearDaemonMergedProjectionCacheForTests();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        await serverScopedRpcSocketPool.stopAll();
        installDisconnectedServerSocketBoundary();
    }
});
