import type { AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskResourceV1Schema, TaskResourcesListResponseV1Schema } from '@happier-dev/protocol/actions/internalTaskActions';
import {
    normalizePluginAccountCollectionContractsV1,
    PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1,
    PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
    PluginCollectionContractReadRequestV1Schema,
    PluginCollectionQueryRequestV1Schema,
    PluginCollectionQueryResultV1Schema,
} from '@happier-dev/protocol/plugins/data/collectionsV1';
import { buildTodoSessionLinkKeyV1 } from '@happier-dev/protocol/todos/todoSessionLinkV1';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { answerSourceDeclaredAccountPluginForHome } from '@/dev/testkit/harness/portableAccountPlugin';
import { createDeferred, createMachineFixture, createSessionFixture, renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';

const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));
const daemon = vi.hoisted(() => ({ projection: null as PluginProjectionV2 | null }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async ({ method }) => {
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            return { protocolVersion: 1, projection: daemon.projection };
        }
        throw new Error(`Unexpected Triage fixture RPC: ${method}`);
    });
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { OS: 'web' },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: packaged.artifacts,
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: packaged.declarations,
    BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({
    localUri: `https://app-assets.test/${asset}`, downloadAsync: async () => {},
}) } }));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
afterEach(async () => { await standardCleanup(); await homes.reset(); });

it.each([false, true])('exposes the linked Task on the direct Session route (different Machine version: %s)', async (versionSkew) => {
    const { prepareAuthenticationInventory } = await import('@/dev/testkit/fixtures/connectedAccountAuthentication');
    const { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } =
        await import('../../../../../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs');
    const { PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    const workItems = PLUGIN_MANIFEST.contributes.workItems[0]!;
    const accountAction = PLUGIN_MANIFEST.contributes.actions.find(action => action.execution.target === 'account')!;
    if (accountAction.execution.target !== 'account') throw new Error('Expected Triage Account runtime');
    const projectPath = 'packages/plugins/triage';
    const packageName = '@happier-dev/plugins-triage';
    await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST, target: workItems.client,
        projectPath, entryPath: `${projectPath}/src/ui/list/entryDragDrop.ts`, packageName,
        additionalArtifacts: [{ target: accountAction.execution.account, entryPath: `${projectPath}/src/accountRuntime.ts` }] });
    const graphs = packaged.artifacts.map(value => PluginUiArtifactsManifestEntryV2Schema.parse(
        (value as { artifactGraph: unknown }).artifactGraph));
    const declaration = await projectBundledPluginUiDeclaration({ packageName, packageVersion: PLUGIN_MANIFEST.version,
        manifest: PLUGIN_MANIFEST, artifactGraphs: graphs });
    if (!declaration) throw new Error('Expected Triage package declaration');
    const firstPaint = await projectBundledPluginUiFirstPaintDeclaration(declaration);
    const { readBundledPluginUiDeclarationAsset } =
        await import('@/sync/domains/plugins/availability/bundledPluginUiArtifactAssetReader');
    const declarationAsset = packaged.files.size + 1;
    packaged.files.set(declarationAsset, new TextEncoder().encode(JSON.stringify(declaration)));
    packaged.declarations.splice(0, 1, { ...firstPaint, loadDeclaration: () => readBundledPluginUiDeclarationAsset(declarationAsset) });

    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { AppShellPluginUiProjectionProvider, useAppShellPluginUiProjection } =
        await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { SessionSurfacePresenceProvider } = await import('../sessionSurfacePresence');
    const { SessionViewLiveStatusPaneHeader } = await import('./SessionViewLiveStatusPaneHeader');
    const { resolveSessionViewHeaderProps } = await import('./resolveSessionViewHeaderProps');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { resolvePluginUiClientWorkItemsRegistration } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    const { usePluginUiProjectionCurrentness } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');

    await loadSyncSingletonForTests();
    const disposeLoader = await installRealActionExecutorModuleLoader();
    const restorePopover = withPopoverWebGlobals();
    const serverUrl = 'https://header-task.test';
    const accountId = 'header-account';
    const sessionId = 'wait-question-session';
    const taskId = 'linked-task';
    const title = 'Check the linked task';
    const serverIdentityId = 'srv_header_task';
    const serverId = await homes.addHome({ name: 'Header Home', serverUrl, accountId, currentAccount: true, serverIdentityId });
    const machineId = 'linked-session-machine';
    const machineVersion = '2.0.0';
    const sourceCustody = { kind: 'development', registeredRootId: '/fixture/triage' } as const;
    const machine = versionSkew ? createMachineFixture({
        id: machineId, active: true, activeAt: Date.now(), daemonStateVersion: 1,
    }) : null;
    const sourceId = `${PLUGIN_MANIFEST.id}/${workItems.id}`;
    daemon.projection = machine ? PluginProjectionV2Schema.parse({ v: 2, generation: 1,
        installedPackagesById: { [PLUGIN_MANIFEST.id]: { id: PLUGIN_MANIFEST.id, displayName: 'Triage',
            version: machineVersion, enabled: true, occurrenceId: 'triage-machine', sourceCustody,
            source: { kind: 'localPath', locator: '/fixture/triage' },
            executionOrigin: { serverIdentityId, sourceRef: { machineId, pluginId: PLUGIN_MANIFEST.id, sourceCustody } },
        } }, familiesById: { workItems: { family: 'workItems', entriesById: { [sourceId]: {
            id: sourceId, pluginId: PLUGIN_MANIFEST.id, pluginVersion: machineVersion,
            occurrenceId: 'triage-machine', definition: workItems,
        } } } },
    }) : null;
    if (machine) homes.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: machineId, accountId, machine })] });
    const intentsReady = createDeferred<void>();
    const intentsRoute = `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']}`;
    answerSourceDeclaredAccountPluginForHome({
        answer(id, route, response) {
            if (!machine || route !== intentsRoute) {
                homes.answer(id, route, response);
                return;
            }
            homes.answer(id, route, { ...response, async select(input, request) {
                // A retained Machine catalog can be available before the Account's release read.
                await intentsReady.promise;
                return response.select?.(input, request);
            } });
        },
    }, serverId, PLUGIN_MANIFEST.id);
    // The fixture Home has no imported corpus rows. The real Triage reader still
    // lists native Tasks and their links through the host's Account Actions.
    const contracts = normalizePluginAccountCollectionContractsV1({
        pluginId: PLUGIN_MANIFEST.id, contributions: PLUGIN_MANIFEST.contributes.accountCollections,
    });
    homes.answer(serverId, `POST ${PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1}`, {
        select(input) {
            const { ref } = PluginCollectionContractReadRequestV1Schema.parse(input);
            const contract = contracts.find(candidate => candidate.collectionId === ref.collectionId
                && candidate.contractDigest === ref.contractDigest && candidate.schemaVersion === ref.schemaVersion);
            return contract && ref.pluginId === PLUGIN_MANIFEST.id
                ? { body: { access: 'writable', contract } } : { status: 404 };
        },
    });
    homes.answer(serverId, `POST ${PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1}`, {
        select(input) {
            PluginCollectionQueryRequestV1Schema.parse(input);
            return { body: PluginCollectionQueryResultV1Schema.parse({ rows: [], changeCursor: 0 }) };
        },
    });
    const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId } }, features: {
        machines: { enabled: true },
        plugins: { enabled: true, ui: { enabled: true, hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } } },
    } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const fetchHome = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== 'app-assets.test') return fetchHome(input, init);
        const bytes = packaged.files.get(Number(url.pathname.slice(1)));
        packaged.reads += 1;
        return Promise.resolve(bytes ? new Response(Uint8Array.from(bytes)) : new Response(null, { status: 404 }));
    });
    try {
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
        if (!credentials) throw new Error('Expected fixture Home credentials');
        await restoreConnectionToActiveServer(credentials);
        const refreshAvailability = getSyncSingleton().refreshPluginAccountAvailability();
        if (!machine) await refreshAvailability;
        const account = captureActiveServerAccountScopeLifetime();
        if (!account) throw new Error('Expected active fixture Account');
        if (machine) {
            const { storage } = await import('@/sync/domains/state/storageStore');
            storage.setState({ endpointStatus: 'online' });
            await publishMachineInventoryForTest(account.scope, [machine]);
            let catalog: ReturnType<typeof usePluginUiProjectionCurrentness> | undefined;
            function LoadMachineCatalog() { catalog = usePluginUiProjectionCurrentness({ machineId, serverId }); return null; }
            const warm = await renderScreen(<LoadMachineCatalog />);
            try {
                await vi.waitFor(() => {
                    expect(catalog?.phase, catalog?.unavailableReasonCode).toBe('current');
                    expect(catalog?.pluginUiProjection?.installedPackagesById[PLUGIN_MANIFEST.id]?.version).toBe(machineVersion);
                });
            } finally { await warm.unmount(); }
        }
        const destination = { ...account.scope, sessionId };
        const task = { id: taskId, title, done: false, createdAt: 1, updatedAt: 1,
            linkedSessions: { [buildTodoSessionLinkKeyV1(destination)]: { title, linkedAt: 1, session: destination } } };
        homes.answer(serverId, 'GET /v1/tasks', { body: TaskResourcesListResponseV1Schema.parse({ tasks: [TaskResourceV1Schema.parse({
            ownerAccountId: accountId, taskId, access: 'owner', encryptionMode: 'plain', encryptedDataKey: null,
            version: 1, content: { t: 'plain', v: task },
        })] }) });
        homes.answer(serverId, 'POST /v1/kv/bulk', { body: { values: [] } });

        const session = createSessionFixture({ id: sessionId, serverId, active: true, metadata: { path: '/fixture', host: 'test-host' } });
        const header = resolveSessionViewHeaderProps({
            isDataReady: true, session, sessionId, paneScopeId: 'pane-1', windowWidth: 1440,
            taskSession: { sessionId, scope: account.scope },
            sessionInfoHref: `/session/${sessionId}/info`, sessionRunsHref: `/session/${sessionId}/runs`,
            sessionAutomationsHref: `/session/${sessionId}/automations`, sessionAutomationsEnabledCount: 0,
            sessionExecutionRunsSupported: false, showAutomations: false, shouldShowSubagentsButton: false,
            workSummary: { outstanding: 1, needsYou: 1, stalled: 0, sessions: 1, runs: 0 },
            navigateWithBlurOnWeb: action => action(), handleHeaderExtraItemSelect: () => false,
            router: { push: () => {}, navigate: () => {} }, actionIconColor: '#000', headerTintColor: '#000',
            statusErrorColor: '#f00', externalSessionRuntime: null,
        });
        let projection: AppShellPluginUiProjectionValue | undefined;
        function ProjectionProbe() { projection = useAppShellPluginUiProjection(value => value); return null; }
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <AppShellPluginUiProjectionProvider>
                <ProjectionProbe />
                <SessionSurfacePresenceProvider sessionId={sessionId} focusedOverride visibleOverride sceneActive
                    routeAnchorOverride={null} presentedWhileVisible>
                    <SessionViewLiveStatusPaneHeader {...header} />
                </SessionSurfacePresenceProvider>
            </AppShellPluginUiProjectionProvider>
        </InjectedAuthProvider>);
        const waitForTaskChip = () => vi.waitFor(() => {
            const chips = screen.findAll(node => node.props.accessibilityLabel === title && node.props.accessibilityRole === 'link');
            expect(chips.length).toBeGreaterThan(0);
        });
        try {
            if (machine) {
                await vi.waitFor(() => expect(projection?.pluginUiProjection?.installedPackagesById[PLUGIN_MANIFEST.id]?.version)
                    .toBe(machineVersion));
                await act(async () => {
                    intentsReady.resolve();
                    await refreshAvailability;
                });
            }
            await vi.waitFor(() => {
                const source = projection?.pluginUiProjection?.workItemsById[sourceId];
                expect(source, JSON.stringify({ phase: projection?.phase, enabled: projection?.interactionEnabled,
                    activation: projection?.clientExecutableActivation?.status, assetReads: packaged.reads })).toBeDefined();
                expect(projection?.interactionEnabled).toBe(true);
                expect(source?.pluginVersion).toBe(PLUGIN_MANIFEST.version);
                expect(projection?.pluginUiProjection?.installedPackagesById[PLUGIN_MANIFEST.id]?.version)
                    .toBe(machine ? machineVersion : PLUGIN_MANIFEST.version);
                expect(projection?.clientExecutableActivation?.status).toBe('ready');
            });
            try {
                await waitForTaskChip();
            } catch (error) {
                // The mounted Board treats failed reads as incomplete. Use the same live owner to expose a typed cause.
                const source = projection?.pluginUiProjection?.workItemsById[sourceId];
                const reader = source && resolvePluginUiClientWorkItemsRegistration({ source, platform: 'web' });
                const { createBoardTaskActionContext } = await import('@/components/boards/model/boardTaskActionContext');
                let result: unknown;
                if (source && reader?.runtime.findLinked) {
                    const owner = createBoardTaskActionContext({ source, registration: reader.registration,
                        signal: new AbortController().signal, accountLifetime: account });
                    try {
                        const discovery = await reader.runtime.findLinked({ serverId, sessionIds: [sessionId] }, owner.context);
                        const resolved = await reader.runtime.resolve({ serverId, itemIds: discovery.itemIds }, owner.context);
                        result = { complete: discovery.complete, discovered: discovery.itemIds.length, resolved: Object.keys(resolved).length,
                            withPage: Object.values(resolved).filter(item => item?.page).length };
                    } catch (failure) {
                        result = failure instanceof Error && 'code' in failure ? { code: failure.code } : { name: (failure as Error).name };
                    } finally { owner.dispose(); }
                }
                const paths = [...new Set(homes.requests.map(request => request.path))];
                throw new Error(JSON.stringify({ result, paths, assetReads: packaged.reads,
                    activation: projection?.clientExecutableActivation }), { cause: error });
            }
            const layout = async (testId: string, width: number) => {
                await act(async () => {
                    for (const node of screen.findAllByTestId(testId)) node.props.onLayout?.({
                        nativeEvent: { layout: { x: 0, y: 0, width, height: 20 } },
                    });
                });
            };
            await layout('session-header-task-links', 246);
            await layout('session-header-title-row', 545);
            await waitForTaskChip();
            await layout('session-header-title-row', 192);
            expect(screen.findAllByTestId('session-header-task-links')).toHaveLength(0);
            await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
            await vi.waitFor(() => expect(screen.findByType(DropdownMenu).props.items).toContainEqual(
                expect.objectContaining({ id: expect.stringMatching(/^header\.task:/), title: expect.stringContaining(title) })));
        } finally { await screen.unmount(); }
    } finally {
        intentsReady.resolve();
        disposeLoader();
        restorePopover();
        vi.unstubAllGlobals();
    }
});
