import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeRequestSchema,
    PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema, PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { projectPluginRegistrySourceDeclarationV1, REGISTRY_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { createMachineFixture, flushHookEffects } from '@/dev/testkit';
import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { AppShellPluginUiProjectionProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { clearDaemonMergedProjectionCacheForTests, readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { StoreRegistryItemPicker } from './StoreKindPage';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');

afterEach(async () => {
    clearDaemonMergedProjectionCacheForTests();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    installDisconnectedServerSocketBoundary();
});

it.each([false, true])('opens the cold database picker with bundled PostgreSQL and a scoped marketplace failure (full declaration: %s)', async fullDeclaration => {
    const accountId = 'picker-data-account';
    const serverIdentityId = 'srv_picker_data';
    const serverUrl = `https://picker-data-${fullDeclaration}.test`;
    const machine = createMachineFixture({ id: 'picker-data-machine', activeAt: 0, storageMode: 'plain' });
    const machineRow = createPlainMachineRowFixture({ id: machine.id, accountId, machine });
    const pluginId = 'happier.deployment.templates';
    const occurrenceId = `${pluginId}:32`;
    const entry = { ...projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '0.0.0', definition: {
        id: 'data-services', title: 'Data services', format: 'happier-catalog', kinds: ['app'],
        packageContent: { path: 'resources/registry/apps.json' },
    } }), occurrenceId };
    const sourceCustody = { kind: 'development', registeredRootId: 'deployment-templates' } as const;
    const executionOrigin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId, sourceCustody } };
    const materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId, machineId: machine.id,
        materializationId: `daemon-selected:${pluginId}`, pluginId, version: '0.0.0', sourceClass: 'bundledFirstParty',
        portableRelease: false, enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [],
        ...(fullDeclaration ? { declaredManifest: { schemaVersion: 2, id: pluginId, version: '0.0.0',
            displayName: 'Deployment templates', contributes: { registrySources: [entry.definition] } } } : {}),
    });
    const widget = widgetProjectionEntry({ pluginId, localId: 'unopened', target: 'app' });
    const deferred = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: 'a'.repeat(64),
        projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: {
            [pluginId]: { id: pluginId, displayName: 'Deployment templates', version: '0.0.0', enabled: true,
                source: { kind: 'bundled', locator: '@happier-dev/plugins-deployment-templates' }, occurrenceId,
                sourceCustody, executionOrigin },
        }, familiesById: {
            registrySources: { family: 'registrySources', entriesById: { [entry.id]: { ...entry, executionOrigin } } },
            pluginUi: { family: 'pluginUi', entriesById: { [widget.id]: { ...widget, occurrenceId, executionOrigin } } },
        } }) });
    const requests: ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>[] = [];
    // Only HTTP and Socket transports are substituted; the passive AppShell,
    // Store demand, deferred acquisition, source composition and picker are real.
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, packet) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet)
                || typeof packet.method !== 'string' || !('params' in packet)) throw new Error('Invalid fixture RPC');
            expect(packet.method).toBe(`${machine.id}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`);
            const content = { mode: 'plain' as const };
            const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(decoded.params);
            requests.push(request);
            const result = request.sectionRead ? deferred.read(request.sectionRead.digest, request.sectionRead.offset,
                request.sectionRead.includeDigests) : deferred.manifest;
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        });
    });
    const packagedReads: string[] = [];
    const external = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId,
        machineId: machine.id, tokenEpoch: 0, actionId: 'registries.items.list', requesterInvocation: 'none',
        execute: input => {
            const request = REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.items.list'].parse(input);
            expect(request.sourceIds).toEqual([entry.id]);
            packagedReads.push(entry.id);
            return { pages: [{ sourceId: entry.id, status: { state: 'ok', fetchedAt: 1 }, items: [{
                sourceId: entry.id, kind: 'app', itemId: 'postgresql', title: 'PostgreSQL', appMetadata: { category: 'database' },
            }], nextCursor: null }] };
        },
    });
    const catalog = createPromptLibraryCatalogBoundary();
    const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl, serverIdentityId, accountId, accountMode: 'plain', currentAccount: true }],
        route: async request => {
            if (request.path === '/v1/machines') return Response.json([machineRow]);
            if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
                id => id === machine.id ? machineRow : null);
            const init = { method: request.method, headers: request.headers,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) };
            const action = await external.handle(new URL(request.path, serverUrl), init);
            if (action) return action;
            const row = await catalog.handle(request.path, init);
            if (row) return row;
            if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'])
                return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1,
                    snapshots: [{ serverIdentityId, machineId: machine.id, materializations: [materialization] }] }));
            if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'])
                return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds: [],
                    intentReads: [{ pluginId, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                        hostingCapability: { enabled: false }, intent: null, release: null, packageAssets: [], uiArtifacts: [] }) }], failedPluginIds: [] }));
            return undefined;
        } });
    setRuntimeFetch(async (url, init) => {
        const address = String(url);
        // Other built-in app sources settle successfully; only the marketplace is unreachable.
        if (address === 'https://api.github.com/repos/coollabsio/coolify/commits/HEAD')
            return Response.json({ sha: 'b'.repeat(40) });
        if (address.endsWith('/templates/service-templates.json')) return Response.json({});
        if (address === 'https://templates.dokploy.com/meta.json') return Response.json([]);
        if (new URL(address).origin !== serverUrl) return new Response(null, { status: 503 });
        return home.fetch(url, init);
    });
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, [machine.id]);
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        expect(readPluginAccountAvailability(scope).readInstalledPlugins()).toMatchObject({ kind: 'available',
            plugins: [{ pluginId, installations: [{ contributorDeclaration: fullDeclaration ? expect.anything() : null }] }] });
        const body = (presented: boolean) => <AppShellPluginUiProjectionProvider>
            <StoreRegistryItemPicker presented={presented} initialFilters={{ category: { include: ['database'], exclude: [] } }}
                onSelect={() => { throw new Error('Listing must not add a database'); }} testID="database-picker" />
        </AppShellPluginUiProjectionProvider>;
        tree = await renderWithAppProviders(body(false));
        expect(requests).toEqual([]);
        expect(packagedReads).toEqual([]);
        expect(readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true })?.registrySourcesById[entry.id]?.occurrenceId).toBeUndefined();
        await tree.update(body(true));
        await waitForHomeGovernance(() => expect(readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true })?.registrySourcesById[entry.id])
            .toMatchObject({ occurrenceId }));
        await waitForHomeGovernance(() => expect(JSON.stringify(tree!.tree.toJSON())).toContain('PostgreSQL'));
        expect(JSON.stringify(tree.tree.toJSON())).toContain('Data services');
        expect(JSON.stringify(tree.tree.toJSON())).toContain('Happier catalog');
        expect(JSON.stringify(tree.tree.toJSON())).toContain('Retry');
        expect(tree.tree.root.findAllByProps({ testID: 'store.kind.app.failure-card' })).toHaveLength(0);
        expect(packagedReads).toHaveLength(1);
        const loaded = readCachedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId, sections: [] })?.deferredProjection?.loadedSections;
        expect(loaded?.filter(section => section.startsWith('familiesById.'))).toEqual(['familiesById.registrySources']);
        expect(requests.filter(request => !request.sectionRead)).toHaveLength(1);
        expect(new Set(requests.map(request => JSON.stringify(request.sectionRead ?? null))).size).toBe(requests.length);
        const settledReads = requests.length;
        await tree.update(body(false));
        await tree.update(body(true));
        await flushHookEffects();
        expect(requests).toHaveLength(settledReads);
        expect(packagedReads).toHaveLength(1);
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});
