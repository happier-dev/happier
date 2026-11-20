import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit';
import { t } from '@/text';
import { ConnectedServiceSetupPanel } from '../setup/ConnectedServiceSetupPanel';
import { ConnectSheetContent } from '../setup/ConnectSheetContent';
import type { ConnectSheetAccountRequest } from '../setup/ConnectedServiceSetupModal';
import type { CustomModalChromeConfig } from '@/modal/types';
import { mergeChromeConfig } from '@/modal/components/customModalChrome';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture, createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialHealthPatchV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { ConnectedAccountAttemptTransactionRecord } from '@happier-dev/cli-common/connectedAccounts';
import { SharedSavedSecretPromoteInputV1Schema, SharedSavedSecretPromoteOutputV1Schema, SharedSavedSecretUpdateInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ManagedListInputV1Schema, ManagedListOutputV1Schema, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

const managedListPath = managedMachineActionEndpointPathV1('machines.managed.list');

const route = vi.hoisted(() => ({ params: {} as Record<string, string>, push: vi.fn() }));
const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));
// Native HTTP is a platform boundary. Home/vendor HTTP below uses the installed
// fixture transport; host classification must not issue an Expo request.
vi.mock('expo/fetch', () => ({ fetch: () => { throw new Error('Unexpected native HTTP request'); } }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { get OS() { return 'web'; } },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => route.params, router: { push: route.push } }).module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    get BUNDLED_PLUGIN_UI_APP_ARTIFACTS() { return packaged.artifacts; },
    get BUNDLED_PLUGIN_UI_APP_DECLARATIONS() { return packaged.declarations; },
    BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({
    localUri: `file:///public-auth-fixture/${asset}`, downloadAsync: async () => {},
}) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private readonly uri: string) {}
    async bytes() {
        packaged.reads += 1;
        const bytes = packaged.files.get(Number(this.uri.split('/').at(-1)));
        if (!bytes) throw new Error('Missing packaged authentication fixture asset');
        return bytes;
    }
} }));
vi.mock('expo-crypto', async original => ({ ...await original<typeof import('expo-crypto')>(),
    randomUUID: (await import('node:crypto')).randomUUID }));
// This journey renders no Markdown; retain the same external-package boundary as the controller suite.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown in authentication setup'); },
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const [{ preparePublicAuthorInventory, prepareAuthenticationInventory, answerAttemptTransaction }, { ConnectedAccountServiceView, ConnectedAccountSetupController },
    { useMachineAdministrationTargetSelection }, { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 },
    { InjectedAuthProvider }, { AppShellPluginUiProjectionProvider },
    { PluginAccountAvailabilityMaterializationsReadResponseV1Schema, PluginAccountAvailabilityIntentsListResponseV1Schema,
        PluginAvailabilityActionHttpPathsV1, PluginPortableReleaseManifestV1Schema }] = await Promise.all([
    import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
    import('./ConnectedAccountServiceView'),
    import('@/sync/domains/machines/administration/useTargetSelection'),
    import('@/sync/domains/machines/administration/selectionPreferences'),
    import('@/auth/context/AuthContext'),
    import('@/components/appShell/plugins/AppShellPluginUiProjection'),
    import('@happier-dev/protocol/plugins/availability'),
]);
const service = await preparePublicAuthorInventory(packaged);

const { PLUGIN_MANIFEST: VERCEL_MANIFEST } = await import('../../../../../../../packages/plugins/machine-vercel/src/manifest');
const PLUGIN_MANIFEST = PluginPortableReleaseManifestV1Schema.parse(VERCEL_MANIFEST);
const vercel = { pluginId: 'happier.machine.vercel', localId: 'vercel-account' };
const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(row => row.id === vercel.localId);
if (!descriptor?.authentication.account) throw new Error('Vercel Account authentication declaration missing');
await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST,
    target: descriptor.authentication.account,
    projectPath: 'packages/plugins/machine-vercel', entryPath: 'packages/plugins/machine-vercel/src/account.ts',
    packageName: '@happier-dev/plugins-machine-vercel' });
const declaration = packaged.declarations.at(-1);
if (!declaration || typeof declaration !== 'object' || !('artifactGraphs' in declaration)
    || !Array.isArray(declaration.artifactGraphs)) throw new Error('Missing actual Vercel compiled declaration');
const { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } = await import('../../../../../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs');
const compiledDeclaration = await projectBundledPluginUiDeclaration({ packageName: '@happier-dev/plugins-machine-vercel',
    packageVersion: PLUGIN_MANIFEST.version, manifest: PLUGIN_MANIFEST,
    artifactGraphs: declaration.artifactGraphs.map(graph => PluginUiArtifactsManifestEntryV2Schema.parse(graph)),
});
packaged.declarations[packaged.declarations.length - 1] = {
    ...await projectBundledPluginUiFirstPaintDeclaration(compiledDeclaration), loadDeclaration: async () => declaration,
};
const { PLUGIN_MANIFEST: CLOUDFLARE_MANIFEST_SOURCE } = await import('../../../../../../../packages/plugins/deploy-cloudflare/src/manifest');
const CLOUDFLARE_MANIFEST = PluginPortableReleaseManifestV1Schema.parse(CLOUDFLARE_MANIFEST_SOURCE);
const cloudflare = { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' };
const cloudflareDescriptor = CLOUDFLARE_MANIFEST.contributes.connectedAccountDescriptors?.find(row => row.id === cloudflare.localId);
if (!cloudflareDescriptor?.authentication.account) throw new Error('Cloudflare Account authentication declaration missing');
await prepareAuthenticationInventory(packaged, { manifest: CLOUDFLARE_MANIFEST,
    target: cloudflareDescriptor.authentication.account,
    projectPath: 'packages/plugins/deploy-cloudflare',
    entryPath: 'packages/plugins/deploy-cloudflare/src/connectedAccounts/portableAuthentication.ts',
    packageName: '@happier-dev/plugins-deploy-cloudflare' });
const { PLUGIN_MANIFEST: CLAUDE_MANIFEST_SOURCE } = await import('../../../../../../../packages/plugins/claude/src/manifest');
const CLAUDE_MANIFEST = PluginPortableReleaseManifestV1Schema.parse(CLAUDE_MANIFEST_SOURCE);
const claude = { pluginId: CLAUDE_MANIFEST.id, localId: 'claude-subscription' };
const claudeDescriptor = CLAUDE_MANIFEST.contributes.connectedAccountDescriptors?.find(row => row.id === claude.localId);
if (!claudeDescriptor?.authentication.account) throw new Error('Claude Account authentication declaration missing');
await prepareAuthenticationInventory(packaged, { manifest: CLAUDE_MANIFEST,
    target: claudeDescriptor.authentication.account,
    projectPath: 'packages/plugins/claude', entryPath: 'packages/plugins/claude/src/connectedAccounts/account.ts',
    packageName: '@happier-dev/plugins-claude' });
const claudeFixtureDeclaration = packaged.declarations.at(-1);
if (!claudeFixtureDeclaration || typeof claudeFixtureDeclaration !== 'object' || !('artifactGraphs' in claudeFixtureDeclaration)
    || !Array.isArray(claudeFixtureDeclaration.artifactGraphs)) throw new Error('Missing compiled Claude declaration');
const claudeDeclaration = await projectBundledPluginUiDeclaration({ packageName: '@happier-dev/plugins-claude',
    packageVersion: CLAUDE_MANIFEST.version, manifest: CLAUDE_MANIFEST,
    artifactGraphs: claudeFixtureDeclaration.artifactGraphs.map(graph => PluginUiArtifactsManifestEntryV2Schema.parse(graph)),
});
packaged.declarations[packaged.declarations.length - 1] = {
    ...await projectBundledPluginUiFirstPaintDeclaration(claudeDeclaration), loadDeclaration: async () => claudeDeclaration,
};
const { PLUGIN_MANIFEST: CODER_MANIFEST } = await import('../../../../../../../packages/plugins/machine-coder/src/manifest');
const coder = { pluginId: CODER_MANIFEST.id, localId: 'coder-account' };
const coderDescriptor = PluginPortableReleaseManifestV1Schema.parse(CODER_MANIFEST).contributes.connectedAccountDescriptors?.find(row => row.id === coder.localId);
if (!coderDescriptor?.authentication.account) throw new Error('Missing Coder Account authentication declaration');
await prepareAuthenticationInventory(packaged, { manifest: CODER_MANIFEST, target: coderDescriptor.authentication.account,
    projectPath: 'packages/plugins/machine-coder', entryPath: 'packages/plugins/machine-coder/src/account.ts',
    packageName: '@happier-dev/plugins-machine-coder' });
const { plugin: vercelDeploymentPlugin } = await import('../../../../../../../packages/plugins/deploy-vercel/src/manifest');
await prepareAuthenticationInventory(packaged, { manifest: vercelDeploymentPlugin.manifest,
    target: { artifactId: 'account-runtime', exportName: 'activateAccount' },
    projectPath: 'packages/plugins/deploy-vercel', entryPath: 'packages/plugins/deploy-vercel/src/account.ts',
    packageName: '@happier-dev/plugins-deploy-vercel' });

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
// react-native aliases this module; bypass the renderer's module mock to reach
// the platform object captured by vitestSetup's earlier runtimeFetch import.
const { Platform: runtimePlatform } = await vi.importActual<typeof import('@/dev/reactNativeStub')>('@/dev/reactNativeStub');
const runtimePlatformOsDescriptor = Object.getOwnPropertyDescriptor(runtimePlatform, 'OS')!;


afterEach(async () => {
    route.params = {};
    route.push.mockClear();
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    await getInstalledPluginUiClientExecutableComposition().unload();
    await connection?.dispose();
    await homes.reset();
    vi.restoreAllMocks();
    Object.defineProperty(runtimePlatform, 'OS', runtimePlatformOsDescriptor);
});

function PortableSetup(props: Readonly<{ credentials: NonNullable<Awaited<ReturnType<typeof restoreServerAccountForTest>>['credentials']>;
    onCancel: () => void; onConnected?: () => void; controllerKey?: number; controllerMounted?: boolean; service?: typeof service; modeId?: string; sheet?: boolean; registry?: ConnectedServiceRegistrySnapshot;
    initialTarget?: Readonly<{ serverIdentityId: string; machineId: string }> | null; reconnectAccountId?: string; connectSheet?: boolean }>) {
    const [machineRequired, setMachineRequired] = React.useState(false);
    const selection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts,
        { enabled: machineRequired, ...(props.initialTarget !== undefined ? { initialTarget: props.initialTarget } : {}) });
    const selectedService = props.service ?? service;
    const serviceKey = `${selectedService.pluginId}/${selectedService.localId}`;
    // Render the real sheet's chrome actions at the modal presentation boundary.
    const [chrome, setChromeState] = React.useState<CustomModalChromeConfig | null>(null);
    const setChrome = React.useCallback((next: CustomModalChromeConfig | null) =>
        setChromeState(current => mergeChromeConfig(current, next)), []);
    const onSheetResult = React.useCallback(() => {}, []);
    const sheetRequest = React.useMemo<ConnectSheetAccountRequest>(() => ({ service: selectedService,
        intent: props.reconnectAccountId ? 'reconnect' : 'add',
        ...(props.reconnectAccountId ? { account: { service: selectedService, accountId: props.reconnectAccountId } } : {}),
        ...(props.initialTarget !== undefined ? { initialMachineTarget: props.initialTarget } : {}),
    }), [selectedService, props.reconnectAccountId, props.initialTarget]);
    return <InjectedAuthProvider credentials={props.credentials}>
        <AppShellPluginUiProjectionProvider>
        {props.controllerMounted === false ? null : props.connectSheet ? <>
            <View testID="portable-connect-sheet-header">{chrome?.kind === 'card' ? chrome.actions : null}</View>
            <ConnectSheetContent request={sheetRequest} onClose={props.onCancel} onResult={onSheetResult} setChrome={setChrome} />
        </> : props.sheet ? <ConnectedServiceSetupPanel chrome="sheet" target={props.reconnectAccountId
            ? { kind: 'reconnect', serviceKey, accountId: props.reconnectAccountId } : { kind: 'service', serviceKey }}
            catalog={[{ serviceKey, service: selectedService, entry: null, legacyServiceId: null, label: 'Vercel',
                usedBy: [], usedByAgentIds: [], connectedCount: 0, section: 'tools', canAdd: true }]}
            targetSelection={selection} onTargetChange={() => {}} onClose={props.onCancel} onConnected={props.onConnected}
            onMachineRequirementChange={setMachineRequired} registry={props.registry} /> : <ConnectedAccountSetupController key={props.controllerKey} service={props.service ?? service} targetSelection={selection}
            panel={{ intent: props.reconnectAccountId ? { kind: 'reconnect', accountId: props.reconnectAccountId } : { kind: 'add' }, modeId: props.modeId, onConnected: props.onConnected ?? (() => {}), onCancel: props.onCancel,
                onMachineRequirementChange: setMachineRequired }} />}
        </AppShellPluginUiProjectionProvider>
    </InjectedAuthProvider>;
}

async function restorePortableFixture(requestedService = service, homeClient = false, vendorResponseReady?: Promise<void>, machinePresence: boolean | 'online' | 'legacy' | 'guests' | 'mixed' = false, offlineMachineId?: string, vendorStatus = 503,
    accountsReady?: Promise<void>, rejectVercelToken?: string) {
    const accountId = 'portable-controller';
    const credentials = { token: createAccountTokenForTests(accountId) };
    const serverUrl = 'https://portable-controller.test';
    const serverIdentityId = 'srv_portable_controller';
    const serverId = await homes.addHome({ name: 'Portable controller', serverUrl, serverIdentityId, accountId, credentials,
        accountEncryptionMode: 'plain' });
    const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId }, connectedServices: {
        ...createRootLayoutFeaturesResponse().capabilities.connectedServices,
        // Match the current Home API exercised by these authentication flows.
        qualifiedAccounts: { protocolVersion: 4 },
        ...(homeClient ? { publicOAuthClients: [{ service: requestedService, clientId: 'home-cloudflare-client',
            scopesByMode: { oauth: ['account:read'] } }] } : {}),
    } }, features: {
        plugins: { enabled: true, ui: { enabled: true, hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } } },
    } });
    homes.answer(serverId, '/v4/connect/qualified/accounts', { body: { service: requestedService, accounts: [] } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    homes.answer(serverId, '/v1/account/encryption/currentness', {
        body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials),
    });
    homes.answer(serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
        body: PluginAccountAvailabilityMaterializationsReadResponseV1Schema.parse({
            availabilityCursor: 1, snapshots: [], inventoryComplete: true, releases: [],
        }),
    });
    homes.answer(serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
        body: PluginAccountAvailabilityIntentsListResponseV1Schema.parse({
            availabilityCursor: 1, pluginIds: [], intentReads: [], failedPluginIds: [],
        }),
    });
    const transactions = new Map<string, ConnectedAccountAttemptTransactionRecord>();
    const promotions: Array<ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>> = [];
    let creates = 0;
    let forgetDiscoveredAttempt = false;
    let machineReads = 0;
    let machineRpcs = 0;
    const machineRpcMethods: string[] = [];
    const paths: string[] = [];
    const vendorRequests: string[] = [];
    const vendorCredentialMatches: boolean[] = [];
    let finishBootstrap!: () => void;
    const bootstrapped = new Promise<void>(resolve => { finishBootstrap = resolve; });
    const machines = typeof machinePresence === 'string' ? ['online-controller-a', 'online-controller-b'].map((id, index) =>
        createPlainMachineRowFixture({ id, accountId, machine: createMachineFixture({ id, active: id !== offlineMachineId, activeAt: id === offlineMachineId ? 0 : Date.now(),
            operationProtocolCapabilitiesRevision: 111,
            ...(machinePresence !== 'legacy' ? { operationProtocolCapabilities: { connectedAccountAuthentication: { protocolVersions: [1] } } }
                : { metadata: { ...createMachineFixture().metadata!, host: 'legacy-controller', happyCliVersion: '0.2.10' } }),
            ...(machinePresence === 'guests' || machinePresence === 'mixed' && index === 1 ? {
                access: { custodian: { accountId: 'other-custodian', displayName: 'Other custodian' },
                    role: index === 0 ? 'use' : 'manage', resourceMode: 'plain', accessState: 'ready' },
            } : {}),
        }) }))
        : machinePresence ? [createPlainMachineRowFixture({ id: 'offline-controller', accountId,
            machine: createMachineFixture({ id: 'offline-controller', active: false, activeAt: 0 }) })] : [];
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId, credentials,
        additionalRequestOrigins: ['https://dash.cloudflare.com', 'https://api.cloudflare.com', 'https://console.neon.tech', 'https://api.supabase.com', 'https://api.vercel.com'],
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
                if (event.includes('rpc')) {
                    machineRpcs += 1;
                    machineRpcMethods.push(payload.method);
                    // The existing selector acquires the selected Machine's Agent/plugin catalog.
                    if (payload.method.endsWith(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)) {
                        DaemonContributionRegistryProjectionDescribeRequestSchema.parse(payload.params);
                        return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                            protocolVersion: 1, projection: { v: 2, generation: 1 },
                        }) };
                    }
                    throw new Error('Account setup must not invoke Machine RPC');
                }
                return { ok: true };
            });
        },
        request: async (input, init) => {
            const request = new URL(String(input));
            if (request.origin !== serverUrl) {
                vendorRequests.push(request.href);
                vendorCredentialMatches.push(new Headers(init?.headers).get('authorization') === 'Bearer portable-cloudflare-token-fixture');
                if (request.origin === 'https://api.vercel.com') {
                    if (rejectVercelToken && new Headers(init?.headers).get('authorization') === `Bearer ${rejectVercelToken}`) {
                        return Response.json({ error: { code: 'invalid_token' } }, { status: 401 });
                    }
                    if (request.pathname === '/v2/teams') return Response.json({
                        teams: [{ id: 'team_fixture', name: 'Fixture team' }], pagination: { next: null },
                    });
                    expect(request.pathname).toBe('/v2/teams/team_fixture');
                    return Response.json({ id: 'team_fixture', name: 'Fixture team' });
                }
                await vendorResponseReady;
                return new Response(null, { status: vendorStatus });
            }
            paths.push(request.pathname);
            if (request.pathname.startsWith('/v1/machines')) {
                // The selector's shared managed-resource inventory is a Home read,
                // separate from native Machine lookup or authentication placement.
                if (request.pathname === managedListPath) {
                    expect(ManagedListInputV1Schema.parse(await new Response(init?.body).json()).homeId).toBe(serverIdentityId);
                    return Response.json(ManagedListOutputV1Schema.parse({ machines: [] }));
                }
                machineReads += 1;
                finishBootstrap();
                if (request.pathname === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
                    id => machines.find(machine => machine.id === id) ?? null);
                if (request.pathname === '/v1/machines') return Response.json(machines);
                const machine = machines.find(row => row.id === decodeURIComponent(request.pathname.split('/').at(-1) ?? ''));
                return machine ? Response.json({ machine }) : Response.json({ error: 'machine_not_found' }, { status: 404 });
            }
            if (request.pathname.startsWith('/v2/connect/connected-account-attempt-transactions/') && init?.method === 'POST') creates += 1;
            const transaction = await answerAttemptTransaction(request, init, transactions);
            if (transaction) {
                // Model a real expiry/removal after discovery, before the addressed read.
                if (forgetDiscoveredAttempt && request.pathname.endsWith('/pending') && transactions.size > 0) {
                    transactions.clear();
                    forgetDiscoveredAttempt = false;
                }
                return transaction;
            }
            if (request.pathname === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote']) {
                const promotion = SharedSavedSecretPromoteInputV1Schema.parse(await new Response(init?.body).json());
                promotions.push(promotion);
                return Response.json(SharedSavedSecretPromoteOutputV1Schema.parse({ resourceId: promotion.resourceId, settingsVersion: 0,
                    connectedAccountCredential: { credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: 'configured-account-1' } }));
            }
            if (request.pathname === '/v4/connect/qualified/accounts') await accountsReady;
            return homes.request(input, init);
        },
    });
    await bootstrapped;
    // Complete the real app inventory owner before measuring authentication demand.
    await (await import('@/sync/sync')).sync.refreshMachines();
    // addHome primes its ordinary capabilities; consume this fixture's current
    // HTTP response through the same client the authentication host reads.
    const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const snapshot = await getServerFeaturesSnapshot({ serverId, force: true });
    expect(snapshot.status).toBe('ready');
    if (homeClient && snapshot.status === 'ready') {
        expect(snapshot.features.capabilities.connectedServices.publicOAuthClients).toEqual(features.capabilities.connectedServices.publicOAuthClients);
    }
    machineReads = 0;
    return { credentials, serverId, serverIdentityId, transactions, paths, promotions, vendorRequests, vendorCredentialMatches, machineRpcMethods, forgetOnNextDiscovery() { forgetDiscoveredAttempt = true; },
        get creates() { return creates; },
        get machineReads() { return machineReads; }, get machineRpcs() { return machineRpcs; } };
}

it.each([false, true])('explains Claude browser OAuth needs an available Machine (retained offline selection: %s)', async retainedSelection => {
    const fixture = await restorePortableFixture(claude, false, undefined, true);
    const { storage } = await import('@/sync/domains/state/storageStore');
    await vi.waitFor(() => expect(storage.getState().machineListByServerId[fixture.serverIdentityId]
        ?.map(machine => ({ id: machine.id, active: machine.active })))
        .toEqual([{ id: 'offline-controller', active: false }]));
    const { getServerProfileById, resolveServerProfileScopeId } = await import('@/sync/domains/server/serverProfiles');
    const profile = getServerProfileById(fixture.serverId);
    if (!profile) throw new Error('Missing fixture Home');
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={claude} sheet
        {...(retainedSelection ? { initialTarget: { serverIdentityId: resolveServerProfileScopeId(profile), machineId: 'offline-controller' } } : {})}
        onCancel={() => {}} />);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-setup:method:oauth')).not.toBeNull());
        await screen.pressByTestIdAsync('connected-service-setup:method:oauth');
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId('connected-account-browser-machine-unavailable')).not.toBeNull();
        }, { timeout: 10_000 });
        expect(screen.getTextContent()).toContain(t('connectedServices.errors.browserSignInMachineUnavailable'));
        expect(screen.findHostByTestId('connected-service-setup:method-continue')).toBeNull();
        expect(screen.findHostByTestId('connected-account-oauth:open')).toBeNull();
        expect(fixture.transactions.size).toBe(0);
        expect(fixture.machineReads).toBe(0);
        expect(fixture.machineRpcs).toBe(0);
        expect(fixture.vendorRequests.length).toBe(0);
    } finally { await screen.unmount(); }
});

async function restoreClaudeBrowserMachineFixture(machinePresence: 'online' | 'legacy' | 'guests' | 'mixed', intent: 'add' | 'reconnect') {
    const offlineMachineId = machinePresence === 'guests' && intent === 'reconnect' ? 'online-controller-b' : undefined;
    const fixture = await restorePortableFixture(claude, false, undefined, machinePresence, offlineMachineId);
    const { storage } = await import('@/sync/domains/state/storageStore');
    await vi.waitFor(() => expect(storage.getState().machineListByServerId[fixture.serverIdentityId]
        ?.map(machine => ({ id: machine.id, active: machine.active })))
        .toEqual([{ id: 'online-controller-a', active: true }, { id: 'online-controller-b', active: offlineMachineId === undefined }]));
    if (intent === 'reconnect') storage.getState().applyProfile({ ...storage.getState().profile,
        connectedAccountsV4: [QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service: claude, accountId: 'existing-controller-account' },
            status: 'needs_reauth', authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true, configurationRevision: null })] });
    return fixture;
}

function withPortableSheetBrowser(run: () => Promise<void>) {
    return withPopoverWebGlobals(run, { window: {
        location: new URL('https://portable-ui.test/settings/connected-services'),
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
    } });
}

it('clears the Connect sheet Machine chip when the selected mode is Account placed', () => withPortableSheetBrowser(async () => {
    const fixture = await restoreClaudeBrowserMachineFixture('online', 'add');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createUiConnectedAccountAuthenticationHost } = await import('@/sync/ops/connectedAccounts/connectedAccountAuthenticationHost');
    const host = createUiConnectedAccountAuthenticationHost(await captureLazyActionAccountContext(fixture.serverId));
    const placement = await host.readAccountAuthenticationModes(claude);
    expect(placement.status).toBe('available');
    if (placement.status !== 'available') throw new Error(placement.code);
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={claude} connectSheet initialTarget={null} onCancel={() => {}} />);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-setup:method:oauth')).not.toBeNull());
        // Start with a Machine mode so omission of a later actions patch cannot pass.
        const modeIds = [...(placement.machineRequiredModeIds ?? []), ...placement.modeIds, ...(placement.machineRequiredModeIds ?? [])];
        for (const modeId of modeIds) {
            await screen.pressByTestIdAsync(`connected-service-setup:method:${modeId}`);
            await vi.waitFor(() => {
                const chip = screen.findHostByTestId('connected-service-setup-target.chip');
                expect(chip !== null).toBe(!placement.modeIds.includes(modeId));
                // LABPARITY-ACCEPT-F fix 4: a method with no chip holds no empty place for one, so its
                // subtitle takes the band's width instead of wrapping beside a hidden chip.
                expect(screen.findHostByTestId('connected-service-setup-target-reserved.chip')).toBeNull();
            });
        }
    } finally { await screen.unmount(); }
}));

it.each(['add', 'reconnect'] as const)('invites choosing an online Machine before Claude browser %s', intent => withPortableSheetBrowser(async () => {
    const fixture = await restoreClaudeBrowserMachineFixture('online', intent);
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={claude} connectSheet initialTarget={null}
        {...(intent === 'reconnect' ? { reconnectAccountId: 'existing-controller-account' } : {})} onCancel={() => {}} />);
    try {
        await flushHookEffects({ cycles: 10 });
        if (intent === 'add') {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-setup:method:oauth')).not.toBeNull());
            await screen.pressByTestIdAsync('connected-service-setup:method:oauth');
            expect(screen.findHostByTestId('connected-service-setup:method:oauth')?.props.accessibilityState?.checked).toBe(true);
        }
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.getTextContent()).toContain(t('connectedServicesSettings.setupChooseMachine'));
        }, { timeout: 10_000 });
        expect(screen.findHostByTestId('connected-account-browser-machine-unavailable')).not.toBeNull();
        expect(screen.findHostByTestId('connected-service-setup-target.chip')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain(t('connectedServices.errors.browserSignInMachineUnavailable'));
        expect(screen.findHostByTestId('connected-service-setup:method-continue')).toBeNull();
        expect(screen.findHostByTestId('connected-account-oauth:open')).toBeNull();
        expect(fixture.transactions.size).toBe(0);
        expect(fixture.creates).toBe(0);
        expect(fixture.machineReads).toBe(0);
        expect(fixture.machineRpcMethods).toEqual([]);
        expect(fixture.machineRpcs).toBe(0);
        expect(fixture.vendorRequests.length).toBe(0);
        await screen.pressByTestIdAsync('connected-service-setup-target.chip');
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
        for (const id of ['online-controller-a', 'online-controller-b']) {
            const option = screen.findHostByTestId(`connected-service-setup-target.picker-option:${id}`);
            expect(option).not.toBeNull();
            expect(option?.props.disabled ?? option?.props.accessibilityState?.disabled ?? option?.props['aria-disabled']).not.toBe(true);
        }
    } finally { await screen.unmount(); }
}));

it.each([
    { intent: 'add', selected: false }, { intent: 'reconnect', selected: false },
    { intent: 'add', selected: true }, { intent: 'reconnect', selected: true },
] as const)('explains Machine update before Claude browser $intent (selected: $selected)', ({ intent, selected }) => withPortableSheetBrowser(async () => {
    const fixture = await restoreClaudeBrowserMachineFixture('legacy', intent);
    const { getServerProfileById, resolveServerProfileScopeId } = await import('@/sync/domains/server/serverProfiles');
    const profile = getServerProfileById(fixture.serverId);
    if (!profile) throw new Error('Missing fixture Home');
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={claude} connectSheet
        initialTarget={selected ? { serverIdentityId: resolveServerProfileScopeId(profile), machineId: 'online-controller-a' } : null}
        {...(intent === 'reconnect' ? { reconnectAccountId: 'existing-controller-account' } : {})} onCancel={() => {}} />);
    try {
        await flushHookEffects({ cycles: 10 });
        if (intent === 'add') {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-setup:method:oauth')).not.toBeNull());
            await screen.pressByTestIdAsync('connected-service-setup:method:oauth');
            expect(screen.findHostByTestId('connected-service-setup:method:oauth')?.props.accessibilityState?.checked).toBe(true);
        }
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.getTextContent()).toContain(t('connectedServices.errors.browserSignInMachineUpdateRequired'));
        }, { timeout: 10_000 });
        expect(screen.findHostByTestId('connected-service-setup-target.chip')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain(t('connectedServices.errors.browserSignInMachineUnavailable'));
        expect(screen.findHostByTestId('connected-service-setup:method-continue')).toBeNull();
        expect(screen.findHostByTestId('connected-account-oauth:open')).toBeNull();
        expect(fixture.transactions.size).toBe(0);
        expect(fixture.creates).toBe(0);
        expect(fixture.machineReads).toBe(0);
        expect(fixture.machineRpcMethods.filter(method => method.endsWith(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD)
            || method.endsWith(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD))).toEqual([]);
        if (!selected) expect(fixture.machineRpcs).toBe(0);
        expect(fixture.vendorRequests.length).toBe(0);
        await screen.pressByTestIdAsync('connected-service-setup-target.chip');
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
        await vi.waitFor(() => {
            for (const id of ['online-controller-a', 'online-controller-b']) {
                const option = screen.findHostByTestId(`connected-service-setup-target.picker-option:${id}`);
                expect(option).not.toBeNull();
                expect(option?.props.disabled ?? option?.props.accessibilityState?.disabled ?? option?.props['aria-disabled']).toBe(true);
            }
        });
        expect(screen.getTextContent()).toContain(t('sessionInfo.cliVersionOutdated'));
    } finally { await screen.unmount(); }
}));

it.each([
    { intent: 'add', supply: 'guests' }, { intent: 'reconnect', supply: 'guests' },
    { intent: 'add', supply: 'mixed' }, { intent: 'reconnect', supply: 'mixed' },
] as const)('requires an own Machine for Claude browser $intent ($supply)', ({ intent, supply }) => withPortableSheetBrowser(async () => {
    const fixture = await restoreClaudeBrowserMachineFixture(supply, intent);
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={claude} connectSheet
        initialTarget={supply === 'guests' ? { serverIdentityId: fixture.serverIdentityId,
            machineId: intent === 'add' ? 'online-controller-a' : 'online-controller-b' } : null}
        {...(intent === 'reconnect' ? { reconnectAccountId: 'existing-controller-account' } : {})} onCancel={() => {}} />);
    try {
        if (intent === 'add') {
            await vi.waitFor(() => expect(screen.findHostByTestId('connected-service-setup:method:oauth')).not.toBeNull());
            await screen.pressByTestIdAsync('connected-service-setup:method:oauth');
        }
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId('connected-service-setup-target.chip')).not.toBeNull();
            expect(screen.getTextContent()).toContain(t(supply === 'guests'
                ? 'connectedServices.errors.browserSignInMachineUnavailable' : 'connectedServicesSettings.setupChooseMachine'));
        }, { timeout: 10_000 });
        expect(screen.findHostByTestId('connected-service-setup:method-continue')).toBeNull();
        expect(screen.findHostByTestId('connected-account-oauth:open')).toBeNull();
        expect(fixture.transactions.size).toBe(0);
        expect(fixture.creates).toBe(0);
        expect(fixture.machineReads).toBe(0);
        expect(fixture.machineRpcMethods.filter(method => method.endsWith(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD)
            || method.endsWith(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD))).toEqual([]);
        expect(fixture.vendorRequests.length).toBe(0);
        if (supply === 'mixed') {
            await screen.pressByTestIdAsync('connected-service-setup-target.chip');
            await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
        }
        await vi.waitFor(() => {
            for (const id of supply === 'guests' ? ['online-controller-a', 'online-controller-b'] : ['online-controller-b']) {
                const option = screen.findHostByTestId(`connected-service-setup-target.picker-option:${id}`);
                expect(option).toBeNull();
            }
        });
        expect(screen.getTextContent()).not.toContain(t('machines.destinations.shared', { team: 'Other custodian' }));
        expect(screen.getTextContent()).toContain(t(supply === 'guests'
            ? 'connectedServices.errors.browserSignInMachineUnavailable' : 'connectedServicesSettings.setupChooseMachine'));
        expect(screen.getTextContent()).not.toContain(t('connectedServices.errors.browserSignInMachineUpdateRequired'));
        if (supply === 'mixed') {
            const own = screen.findHostByTestId('connected-service-setup-target.picker-option:online-controller-a');
            expect(own).not.toBeNull();
            expect(own?.props.disabled ?? own?.props.accessibilityState?.disabled ?? own?.props['aria-disabled']).not.toBe(true);
        }
    } finally { await screen.unmount(); }
}));

it('opens and restores an actual Account manual attempt without a Machine or a second begin', async () => {
    const fixture = await restorePortableFixture();
    const { credentials, transactions } = fixture;
    const onCancel = vi.fn();
    const screen = await renderScreen(<PortableSetup credentials={credentials} onCancel={onCancel} controllerMounted={false} />);
    try {
        await flushHookEffects({ cycles: 10 });
        const { runConnectedAccountAuthenticationAction } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
        const started = await runConnectedAccountAuthenticationAction({ serverId: fixture.serverId,
            expectedAccountId: 'portable-controller', command: { operation: 'beginConnect', service, modeId: 'manual' } });
        expect(started.status).toBe('awaitingManual');
        await screen.update(<PortableSetup credentials={credentials} modeId="manual" onCancel={onCancel} controllerKey={0} />);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        expect(fixture.creates).toBe(1);
        expect([...transactions.values()]).toMatchObject([{ kind: 'manual', scope: { phase: 'awaitingManual' } }]);
        const attemptIds = [...transactions.keys()];
        const artifactReads = packaged.reads;
        expect(artifactReads).toBeGreaterThan(0);
        // Retire only the controller, not the AppShell/registration lifetime that owns its runtime.
        await screen.update(<PortableSetup credentials={credentials} modeId="manual" onCancel={onCancel} controllerKey={1} />);
        expect(fixture.machineRpcs).toBe(0);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        expect(fixture.creates).toBe(1);
        expect([...transactions.keys()]).toEqual(attemptIds);
        await screen.pressByTestIdAsync('connected-account-setup:cancel');
        expect(onCancel).toHaveBeenCalledOnce();
        // The containing panel closes on Cancel; the retained test controller
        // may show a fresh local form, but cannot restart the abandoned attempt.
        expect(fixture.creates).toBe(1);
        expect(fixture.machineReads).toBe(0);
        expect(fixture.machineRpcs).toBe(0);
        expect(packaged.reads).toBe(artifactReads);
    } finally { await screen.unmount(); }
});

it.each(['typed', 'Saved Secret'] as const)('retries a restored manual attempt removed before submission with a fresh editable form (%s)', async inputKind => {
    const fixture = await restorePortableFixture();
    const [{ ModalProvider }, { SavedSecretCatalogEntryV1Schema }, { formatSharedSavedSecretRefV1 }] = await Promise.all([
        import('@/modal'), import('@happier-dev/protocol/account/settings/savedSecretCatalogV1'),
        import('@happier-dev/protocol/account/settings/savedSecretReferenceV1'),
    ]);
    const ref = formatSharedSavedSecretRefV1('missing-attempt-recovery');
    homes.answer(fixture.serverId, '/v1/account/saved-secrets/resources', { body: { resources: [SavedSecretCatalogEntryV1Schema.parse({
        ref, source: 'shared_resource', relationship: 'owner', name: 'Recovery fixture', kind: 'apiKey',
        encryptionMode: 'plain', ownerAccountId: 'portable-controller', revision: 1, materialStatus: 'ready',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
        audience: { accounts: [], teams: [], groups: [] },
    })] } });
    const setup = (mounted: boolean) => <ModalProvider><PortableSetup credentials={fixture.credentials} modeId="manual"
        onCancel={() => {}} controllerMounted={mounted} /></ModalProvider>;
    const screen = await renderScreen(setup(false));
    try {
        await flushHookEffects({ cycles: 10 });
        const { runConnectedAccountAuthenticationAction } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
        const started = await runConnectedAccountAuthenticationAction({ serverId: fixture.serverId,
            expectedAccountId: 'portable-controller', command: { operation: 'beginConnect', service, modeId: 'manual' } });
        expect(started.status).toBe('awaitingManual');
        const originalAttemptIds = [...fixture.transactions.keys()];
        await screen.update(setup(true));
        await vi.waitFor(() => expect(fixture.paths).toContain(`/v2/connect/connected-account-attempt-transactions/${originalAttemptIds[0]}`));
        await flushHookEffects({ cycles: 10 });
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull());
        if (inputKind === 'Saved Secret') {
            const [{ captureActiveServerAccountScopeLifetime }, { refreshSavedSecretCatalog }] = await Promise.all([
                import('@/sync/domains/scope/activeServerAccountScope'), import('@/sync/engine/settings/savedSecretCatalogEngine'),
            ]);
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('Expected active recovery fixture Account');
            await act(async () => { await refreshSavedSecretCatalog(lifetime.scope, { includeMaterial: false }); });
            await screen.pressByTestIdAsync('connected-account-manual:mode:saved');
            await screen.pressByTestIdAsync('connected-account-manual:token:choose');
            await vi.waitFor(() => expect(screen.findAllByTestId(`saved-secret-picker:saved:${ref}`)
                .find(node => typeof node.props.title === 'string')?.props.disabled).toBe(false));
            await screen.pressByTestIdAsync(`saved-secret-picker:saved:${ref}`);
        } else {
            await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'synthetic-recovery-input'));
        }
        // Only the persistence boundary is withdrawn; the view and authentication owner stay real.
        fixture.transactions.clear();
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry'), screen.getTextContent()).not.toBeNull());
        await screen.pressByTestIdAsync('connected-account:error:retry');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error'), screen.getTextContent()).toBeNull());
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.value).toBe('');
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.editable).not.toBe(false);
        expect([...fixture.transactions.keys()]).not.toEqual(originalAttemptIds);
        expect([...fixture.transactions.values()]).toMatchObject([{ kind: 'manual', scope: { phase: 'awaitingManual' } }]);
        expect(fixture.machineReads).toBe(0);
        expect(fixture.machineRpcs).toBe(0);
    } finally { await screen.unmount(); }
});

it('leaves a native-addressed attempt alone when choosing an Account method', async () => {
    const fixture = await restorePortableFixture();
    const [{ captureLazyActionAccountContext }, { createNativeAttemptAddressBoundary }, { apiSocket },
        { ConnectedAccountAuthenticationCommandRequestSchema, ConnectedAccountAttemptResponseSchema,
            CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD }] = await Promise.all([
        import('@/sync/ops/actions/actionAccountContext'),
        import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
        import('@/sync/api/session/apiSocket'),
        import('@happier-dev/protocol/connect/connectedAccountDaemonRpcV1'),
    ]);
    const captured = await captureLazyActionAccountContext(fixture.serverId);
    const nativeMachineId = 'earlier-native-host';
    const attemptId = 'earlier-native-attempt';
    const nativeReads: Array<Readonly<{ machineId: string; operation: string; attemptId: string }>> = [];
    const address = await createNativeAttemptAddressBoundary(captured, nativeMachineId);
    await address.acknowledge({ attemptId, kind: 'manual', phase: 'awaitingManual', createdAtMs: Date.now(),
        intent: 'connect', service, modeId: 'manual' });
    expect([...fixture.transactions.values()]).toMatchObject([{ kind: 'manual', scope: {
        machineId: nativeMachineId, service, modeId: 'manual', phase: 'awaitingManual',
    } }]);
    vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async <R, A>(machineId: string, method: string, payload: A): Promise<R> => {
        expect(method).toBe(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD);
        const request = ConnectedAccountAuthenticationCommandRequestSchema.parse(payload);
        if (request.command.operation !== 'read') throw new Error('Only the addressed native read is expected');
        nativeReads.push({ machineId, operation: request.command.operation, attemptId: request.command.attemptId });
        // Native RPC is the external boundary; the real caller parses this response.
        return ConnectedAccountAttemptResponseSchema.parse({ status: 'awaitingManual', attemptId }) as R;
    });
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} onCancel={() => {}} />);
    try {
        await flushHookEffects({ cycles: 10 });
        expect(nativeReads).toEqual([]);
        expect(fixture.paths).not.toContain('/v2/connect/connected-account-attempt-transactions/pending');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', 'portable-fixture-token'));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(fixture.creates).toBe(2));
        expect(nativeReads).toEqual([]);
        expect(fixture.creates).toBe(2);
        expect(fixture.transactions.get(attemptId)?.scope).toMatchObject({ machineId: nativeMachineId, phase: 'awaitingManual' });
        expect(fixture.machineReads).toBe(0);
    } finally { await screen.unmount(); captured.dispose(); }
});


async function useNativeAccountHttpHost() {
    // vitestSetup preloads runtimeFetch against this canonical platform stub;
    // the renderer keeps its web mock while HTTP uses the real native branch.
    Object.defineProperty(runtimePlatform, 'OS', { configurable: true, enumerable: true, get: () => 'ios' });
    expect(await (await import('@/utils/system/runtimeFetch')).readRuntimeFetchHost('https://portable-controller.test')).toBe('native');
}

it('explains the typed Cloudflare web placement refusal after describing a fresh Account without a Machine', async () => {
    Object.defineProperty(runtimePlatform, 'OS', { configurable: true, enumerable: true, get: () => 'web' });
    expect(await (await import('@/utils/system/runtimeFetch')).readRuntimeFetchHost('https://portable-controller.test')).toBe('browser');
    const fixture = await restorePortableFixture(cloudflare);
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={cloudflare} onCancel={() => {}} />);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-browser-machine-unavailable'), screen.getTextContent()).not.toBeNull());
        expect(fixture.paths).toContain('/v4/connect/qualified/accounts');
        expect(screen.getTextContent()).toContain(t('connectedServices.errors.browserSignInMachineUnavailable'));
        const { runConnectedAccountAuthenticationAction } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
        const refused = await runConnectedAccountAuthenticationAction({ serverId: fixture.serverId,
            expectedAccountId: 'portable-controller', command: { operation: 'beginConnect', service: cloudflare, modeId: 'oauth' } });
        expect(refused).toMatchObject({ status: 'unavailable', code: 'connected_account_browser_sign_in_machine_unavailable' });
        expect(screen.findHostByTestId('connected-account-configuration:save')).toBeNull();
        expect(screen.findHostByTestId('connected-account-oauth:open')).toBeNull();
        expect(fixture.transactions.size).toBe(0);
        expect(fixture.creates).toBe(0);
        expect(fixture.machineReads).toBe(0);
        expect(fixture.machineRpcs).toBe(0);
        expect(fixture.vendorRequests).toEqual([]);
    } finally { await screen.unmount(); }
});

it('opens a browser-restricted account detail without a React state-update warning', () => withPortableSheetBrowser(async () => {
    const fixture = await restorePortableFixture(cloudflare);
    const ref = { service: cloudflare, accountId: 'browser-restricted-cloudflare' };
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({
        ref, authenticationModeId: 'oauth', revisionSemantics: 'revisioned', status: 'connected',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true, configurationRevision: null,
    });
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().applyProfile({ ...storage.getState().profile, connectedAccountsV4: [profile] });
    homes.answer(fixture.serverId, '/v4/connect/qualified/accounts', { body: { service: cloudflare, accounts: [profile] } });
    route.params = { ...cloudflare, accountId: ref.accountId };
    const consoleError = vi.spyOn(console, 'error');
    const screen = await renderScreen(<InjectedAuthProvider credentials={fixture.credentials}>
        <AppShellPluginUiProjectionProvider><ConnectedAccountServiceView /></AppShellPluginUiProjectionProvider>
    </InjectedAuthProvider>);
    try {
        await vi.waitFor(() => expect(fixture.paths).toContain('/v4/connect/qualified/accounts'));
        await flushHookEffects();
        expect(screen.findHostByTestId('qualified-account-detail')).not.toBeNull();
        expect(consoleError.mock.calls.flat()).not.toContainEqual(expect.stringContaining('second callback argument'));
    } finally { await screen.unmount(); consoleError.mockRestore(); }
}));

it.each([false, true])('configures Cloudflare browser OAuth on a native HTTP host before continuing without a Machine (Home client: %s)', async homeClient => {
    // Cloudflare declares browserReachability: unreachable; native HTTP keeps this flow Account-local.
    await useNativeAccountHttpHost();
    const fixture = await restorePortableFixture(cloudflare, homeClient);
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={cloudflare} onCancel={() => {}} />);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:save')).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-configuration:clientId') === null).toBe(homeClient);
        if (homeClient) {
            await screen.pressByTestIdAsync('connected-account-advanced:header');
            expect(screen.findHostByTestId('connected-account-configuration:clientId')).not.toBeNull();
        }
        expect(screen.findHostByTestId('connected-account-browser-machine-unavailable')).toBeNull();
        expect(screen.findHostByTestId('connected-account-oauth:open')).toBeNull();
        expect([...fixture.transactions.values()].map(value => value.scope.phase)).toEqual(['configurationRequired']);
        expect(fixture.machineReads).toBe(0);
        expect(fixture.machineRpcs).toBe(0);
        expect(fixture.vendorRequests).toEqual([]);
    } finally { await screen.unmount(); }
});

it('collects Cloudflare token, Account configuration and guide in one draft and preserves it after a configuration validation error', async () => {
    await useNativeAccountHttpHost();
    let releaseVendorResponse!: () => void;
    const vendorResponseReady = new Promise<void>(resolve => { releaseVendorResponse = resolve; });
    const fixture = await restorePortableFixture(cloudflare, false, vendorResponseReady);
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={cloudflare}
        modeId="token" onCancel={() => {}} />);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:accountId'), screen.getTextContent()).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-configuration:tokenOwner')).not.toBeNull();
        expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull();
        expect(screen.findHostByTestId('connected-account-manual:guide')).not.toBeNull();
        expect(screen.findHostByTestId('connected-account-configuration:save')).toBeNull();
        expect(fixture.transactions.size).toBe(0);
        expect(fixture.vendorRequests).toEqual([]);
        await act(async () => {
            screen.changeTextByTestId('connected-account-configuration:accountId', '');
            screen.changeTextByTestId('connected-account-manual:token', 'portable-cloudflare-token-fixture');
            screen.changeTextByTestId('connected-account-manual:name', 'Deploy account');
        });
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        expect(screen.findHostByTestId('connected-account-configuration:accountId.error')!.props.accessibilityRole).toBe('alert');
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.value).toBe('portable-cloudflare-token-fixture');
        expect(screen.findHostByTestId('connected-account-manual:name')!.props.value).toBe('Deploy account');
        expect(fixture.vendorRequests).toEqual([]);
        await act(async () => screen.changeTextByTestId('connected-account-configuration:accountId', 'a'.repeat(32)));
        expect(screen.findHostByTestId('connected-account-configuration:accountId')!.props.value).toBe('a'.repeat(32));
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.value).toBe('portable-cloudflare-token-fixture');
        expect(screen.findHostByTestId('connected-account-manual:name')!.props.value).toBe('Deploy account');
        expect(screen.findHostByTestId('connected-account-manual:guide')).not.toBeNull();
        expect(fixture.vendorRequests).toEqual([]);
        const { getActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
        const guard = getActiveUnsavedChangesGuard();
        expect(guard?.isDirtyRef.current).toBe(true);
        let mayLeave: boolean | undefined;
        await act(async () => { mayLeave = await guard?.onSave?.(); });
        // Beginning the submitted draft has not saved its credential yet.
        // Keep navigation here while the real completion owner finishes it.
        expect(mayLeave).toBe(false);
        expect(guard?.isDirtyRef.current).toBe(true);
        await vi.waitFor(() => expect(fixture.vendorRequests).toEqual(['https://api.cloudflare.com/client/v4/user/tokens/verify']));
        expect(fixture.vendorCredentialMatches).toEqual([true]);
        expect(screen.findHostByTestId('connected-account-manual:name')!.props.value).toBe('Deploy account');
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.value).toBe('portable-cloudflare-token-fixture');
        expect(fixture.machineReads).toBe(0);
        expect(fixture.machineRpcs).toBe(0);
    } finally { releaseVendorResponse(); await screen.unmount(); }
});

it('retries a draft removed after discovery with the chosen Cloudflare token form', async () => {
    await useNativeAccountHttpHost();
    const fixture = await restorePortableFixture(cloudflare);
    // The containing setup panel passes the person's chosen method into restored setup.
    const setup = (controllerMounted: boolean) => <PortableSetup credentials={fixture.credentials} service={cloudflare}
        modeId="token" onCancel={() => {}} controllerMounted={controllerMounted} />;
    const screen = await renderScreen(setup(false));
    try {
        await flushHookEffects({ cycles: 10 });
        const { runConnectedAccountAuthenticationAction } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
        const started = await runConnectedAccountAuthenticationAction({ serverId: fixture.serverId,
            expectedAccountId: 'portable-controller', command: { operation: 'beginConnect', service: cloudflare, modeId: 'token' } });
        expect(started.status).toBe('configurationRequired');
        expect([...fixture.transactions.values()]).toMatchObject([{ kind: 'manual', scope: {
            service: cloudflare, intent: 'connect', modeId: 'token', phase: 'configurationRequired',
        } }]);
        const originalAttemptIds = [...fixture.transactions.keys()];
        fixture.forgetOnNextDiscovery();
        await screen.update(setup(true));
        // The record disappears after the owner has listed its live draft.
        // This concurrent withdrawal uses the existing visible recovery action.
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry'), screen.getTextContent()).not.toBeNull());
        await screen.pressByTestIdAsync('connected-account:error:retry');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:accountId'), screen.getTextContent()).not.toBeNull());
        expect([...fixture.transactions.keys()]).not.toEqual(originalAttemptIds);
        expect([...fixture.transactions.values()]).toMatchObject([{ kind: 'manual', scope: {
            service: cloudflare, intent: 'connect', modeId: 'token', phase: 'configurationRequired',
        } }]);
        expect(screen.findHostByTestId('connected-account-manual:guide')).not.toBeNull();
        expect(screen.findHostByTestId('connected-account-manual:token')).not.toBeNull();
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.secureTextEntry).toBe(true);
        expect(fixture.machineRpcs).toBe(0);
        expect(fixture.machineReads).toBe(0);
    } finally { await screen.unmount(); }
});

it.each(['configurationRequired', 'awaitingManual'] as const)('recovers Vercel fields after a previous browser left a %s attempt', async phase => {
    const fixture = await restorePortableFixture(vercel);
    const setup = (controllerMounted: boolean) => <PortableSetup credentials={fixture.credentials} service={vercel}
        modeId="token" controllerMounted={controllerMounted} onCancel={() => {}} />;
    const previousBrowser = await renderScreen(setup(false));
    await flushHookEffects({ cycles: 10 });
    const { runConnectedAccountAuthenticationAction } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
    const started = await runConnectedAccountAuthenticationAction({ serverId: fixture.serverId,
        expectedAccountId: 'portable-controller', command: { operation: 'beginConnect', service: vercel, modeId: 'token' } });
    expect(started.status).toBe('configurationRequired');
    if (phase === 'awaitingManual') {
        if (started.status !== 'configurationRequired' || !started.attemptId) throw new Error('Missing Vercel draft');
        const [{ createDefaultActionExecutor }, { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 }] = await Promise.all([
            import('@/sync/ops/actions/defaultActionExecutor'), import('@happier-dev/protocol/connect/configurationActionsV1'),
        ]);
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            serverId: fixture.serverId, expectedAccountId: 'portable-controller' };
        const target = { kind: 'attempt' as const, attemptId: started.attemptId };
        const read = await executor.execute('connectedServices.configuration.get', { target }, context);
        if (!read.ok) throw new Error('Vercel draft cannot be read');
        const configuration = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.get'].parse(read.result);
        const replacement = await executor.execute('connectedServices.configuration.replace', { target,
            expectedRevision: configuration.configuration.revision, values: { teamId: 'team_fixture' }, secretValues: {} }, context);
        if (!replacement.ok) throw new Error('Vercel draft cannot be saved');
        const committed = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.replace'].parse(replacement.result);
        const continued = await runConnectedAccountAuthenticationAction({ serverId: fixture.serverId,
            expectedAccountId: 'portable-controller', command: { operation: 'continueConnect', attemptId: started.attemptId,
                ...(committed.revision ? { expectedConfigurationRevision: committed.revision } : {}) } });
        expect(continued.status).toBe('awaitingManual');
        // #40 listed an older awaitingManual address before a configuration draft.
        const second = await runConnectedAccountAuthenticationAction({ serverId: fixture.serverId,
            expectedAccountId: 'portable-controller', command: { operation: 'beginConnect', service: vercel, modeId: 'token' } });
        expect(second.status).toBe('configurationRequired');
    }
    const retained = new Map(fixture.transactions);
    expect([...retained.values()]).toMatchObject(phase === 'awaitingManual'
        ? [{ kind: 'manual', scope: { phase } }, { kind: 'manual', scope: { phase: 'configurationRequired' } }]
        : [{ kind: 'manual', scope: { phase } }]);
    await previousBrowser.unmount();
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    await getInstalledPluginUiClientExecutableComposition().unload();
    // A lost browser does not run unload cleanup against the server. Keep its
    // actual HTTP records while starting a new registration/attempt owner.
    fixture.transactions.clear();
    for (const [id, record] of retained) fixture.transactions.set(id, record);
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={vercel} sheet onCancel={() => {}} />);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:teamId')).not.toBeNull());
        const { listPendingConnectedAccountAuthenticationActions } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
        // The shared attempt owner restores admitted manual work after browser
        // loss. The form must recover without creating another address.
        const pending = await listPendingConnectedAccountAuthenticationActions({ serverId: fixture.serverId,
            expectedAccountId: 'portable-controller', service: vercel });
        expect(pending.status).toBe('pendingAttempts');
        if (pending.status !== 'pendingAttempts') throw new Error('Expected restored Vercel attempts');
        expect(pending.attempts.map(attempt => attempt.attemptId).sort()).toEqual([...retained.keys()].sort());
        expect(fixture.transactions.size).toBe(retained.size);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:teamId'), screen.getTextContent()).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-configuration:projectId')).not.toBeNull();
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.secureTextEntry).toBe(true);
        expect(fixture.machineRpcs).toBe(0);
        expect(fixture.machineReads).toBe(0);
    } finally { await screen.unmount(); }
});

it('keeps an idle Vercel account detail mounted without doing more reads', () => withPortableSheetBrowser(async () => {
    const fixture = await restorePortableFixture(vercel, false, undefined, 'online');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const account = { service: vercel, accountId: 'work-vercel' };
    const row = QualifiedConnectedAccountProfileV4Schema.parse({
        ref: account, authenticationModeId: 'token', revisionSemantics: 'revisioned', status: 'connected',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true,
        configurationRevision: 'configured-vercel',
    });
    homes.answer(fixture.serverId, '/v4/connect/qualified/accounts', { body: { service: vercel, accounts: [row] } });
    storage.getState().applyProfile({ ...storage.getState().profile, connectedAccountsV4: [row] });
    route.params = { ...vercel, accountId: account.accountId };
    vi.useFakeTimers();
    const screen = await renderScreen(<InjectedAuthProvider credentials={fixture.credentials}>
        <AppShellPluginUiProjectionProvider><ConnectedAccountServiceView /></AppShellPluginUiProjectionProvider>
    </InjectedAuthProvider>);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:configuration')).not.toBeNull());
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        const detail = screen.findHostByTestId('qualified-account-detail');
        const pathsBeforeIdle = fixture.paths.length;
        const rpcsBeforeIdle = fixture.machineRpcs;
        for (let minute = 1; minute <= 3; minute += 1) {
            await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
            expect(screen.findHostByTestId('qualified-account-detail')).toBe(detail);
        }
        // Machine presence can age visibly in Works on without refreshing the Account.
        expect(fixture.paths.slice(pathsBeforeIdle)).toEqual([]);
        expect(fixture.machineRpcs - rpcsBeforeIdle).toBe(0);
    } finally {
        await screen.unmount();
        vi.useRealTimers();
    }
}));

it('verifies Replace before rotating the held Vercel token and clearing needs sign-in', () => withPortableSheetBrowser(async () => {
    const invalidToken = 'fixture-vercel-invalid';
    const replacement = 'fixture-vercel-replacement';
    const original = 'fixture-vercel-original';
    const fixture = await restorePortableFixture(vercel, false, undefined, false, undefined, 503, undefined, invalidToken);
    const resourceId = 'held-vercel-token';
    const ref = formatSharedSavedSecretRefV1(resourceId);
    const heldRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const nextRevision = 'csr_123456789ABCDEFGHJKMNPQRST';
    const configurationRevision = 'configured-vercel';
    const account = { service: vercel, accountId: 'work-vercel' };
    const seal = (kind: 'credential' | 'configuration', payload: unknown) => sealQualifiedConnectedAccountContentEnvelope({
        kind, accountMode: 'plain', payload, randomBytes: size => new Uint8Array(size),
    });
    let profile = QualifiedConnectedAccountProfileV4Schema.parse({
        ref: account, authenticationModeId: 'token', revisionSemantics: 'revisioned', status: 'needs_reauth',
        credentialRevision: heldRevision, configurationReady: true, configurationRevision, savedSecretResourceIds: [resourceId],
    });
    let health: ReturnType<typeof QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse>['health'] = { v: 1, status: 'needs_reauth', reconnectRequired: true };
    let content = seal('credential', { v: 1, values: {}, secretRefs: { token: ref } });
    let metadata: Record<string, unknown> = { kind: 'token', displayName: 'Fixture team', scopes: [] };
    let material = { v: 1, name: 'Work token', kind: 'token', value: original };
    let secretRevision = 1;
    let listUnavailable = true;
    const publishProfile = async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().applyProfile({ ...storage.getState().profile, connectedAccountsV4: [profile] });
    };
    const entry = () => ({
        ref, source: 'shared_resource', relationship: 'owner', name: material.name, kind: material.kind,
        encryptionMode: 'plain', ownerAccountId: 'portable-controller', revision: secretRevision, materialStatus: 'ready',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
        audience: { accounts: [], teams: [], groups: [] },
    });
    homes.answer(fixture.serverId, '/v4/connect/qualified/accounts', { select: () => listUnavailable
        ? { status: 503, body: { error: 'fixture_list_unavailable' } }
        : { body: { service: vercel, accounts: [profile] } } });
    homes.answer(fixture.serverId, 'GET /v4/connect/qualified/credential', { select: () => ({
        body: { ref: account, authenticationModeId: 'token', revisionSemantics: 'revisioned',
            credentialRevision: profile.credentialRevision, configurationRevision, metadata, content, health },
    }) });
    homes.answer(fixture.serverId, 'GET /v4/connect/qualified/configuration', { body: {
        target: { kind: 'account', ref: account }, authenticationModeId: 'token',
        revisionSemantics: 'revisioned', credentialRevision: heldRevision, configurationRevision,
        configurationContent: seal('configuration', { values: { teamId: 'team_fixture' }, secretRefs: {} }),
    } });
    homes.answer(fixture.serverId, '/v1/account/saved-secrets/resources', { select: () => ({ body: { resources: [entry()] } }) });
    homes.answer(fixture.serverId, '/v1/account/saved-secrets/resources/materials', { select: () => ({ body: {
        resources: [{ resourceId, encryptionMode: 'plain', entry: entry(),
            storedContent: { t: 'plain', v: material }, recipientEnvelope: null }],
    } }) });
    homes.answer(fixture.serverId, SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.update'], { select: input => {
        const update = SharedSavedSecretUpdateInputV1Schema.parse(input);
        expect(update).toMatchObject({ resourceId, expectedRevision: secretRevision });
        if (update.storedContent.t !== 'plain' || update.storedContent.v.v !== 1) throw new Error('Expected a plain token');
        material = update.storedContent.v;
        secretRevision += 1;
        return { body: { resourceId, revision: secretRevision } };
    } });
    homes.answer(fixture.serverId, 'POST /v4/connect/qualified/credential', { select: input => {
        const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(input);
        expect(mutation).toMatchObject({ ref: account, expectedCredentialRevision: heldRevision,
            expectedConfigurationRevision: configurationRevision, savedSecretResourceIds: [resourceId] });
        content = mutation.content;
        metadata = mutation.metadata;
        profile = { ...profile, credentialRevision: nextRevision };
        return { body: { success: true, credentialRevision: nextRevision, configurationRevision } };
    } });
    homes.answer(fixture.serverId, 'PATCH /v4/connect/qualified/credential/health', { select: async input => {
        const patch = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(input);
        expect(patch).toMatchObject({ ref: account, expectedCredentialRevision: nextRevision, expectedConfigurationRevision: configurationRevision,
            health: { status: 'connected', reconnectRequired: false } });
        health = patch.health;
        profile = { ...profile, status: 'connected' };
        await publishProfile();
        return { body: { success: true, credentialRevision: nextRevision, configurationRevision } };
    } });
    await publishProfile();
    const [{ captureActiveServerAccountScopeLifetime }, { refreshSavedSecretCatalog }] = await Promise.all([
        import('@/sync/domains/scope/activeServerAccountScope'), import('@/sync/engine/settings/savedSecretCatalogEngine'),
    ]);
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected active Vercel fixture Account');
    await refreshSavedSecretCatalog(lifetime.scope, { includeMaterial: false });
    route.params = { ...vercel, accountId: account.accountId };
    const { ModalProvider } = await import('@/modal');
    const screen = await renderScreen(<InjectedAuthProvider credentials={fixture.credentials}>
        <AppShellPluginUiProjectionProvider><ModalProvider><ConnectedAccountServiceView /></ModalProvider></AppShellPluginUiProjectionProvider>
    </InjectedAuthProvider>);
    try {
        const replace = 'qualified-account-detail:key:replace';
        await vi.waitFor(() => expect(screen.findHostByTestId(replace), screen.getTextContent()).not.toBeNull());
        await vi.waitFor(() => expect(fixture.paths).toContain('/v4/connect/qualified/accounts'));
        expect(screen.findHostByTestId('qualified-account-detail:signed-out-banner:sign-in-again')).not.toBeNull();
        expect(screen.findHostByTestId('qualified-account-detail:live-unavailable')).toBeNull();
        await screen.pressByTestIdAsync(replace);
        expect(route.push).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', invalidToken));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error'), screen.getTextContent()).not.toBeNull());
        await screen.pressByTestIdAsync('connected-account:error-details-toggle');
        expect(screen.findHostByTestId('connected-account:error-details-code')?.props.children).toContain('vercel_invalid_token');
        expect(fixture.vendorRequests).toContain('https://api.vercel.com/v2/teams/team_fixture');
        expect({ value: material.value, secretRevision, status: profile.status, credentialRevision: profile.credentialRevision })
            .toEqual({ value: original, secretRevision: 1, status: 'needs_reauth', credentialRevision: heldRevision });

        listUnavailable = false;
        await screen.pressByTestIdAsync('connected-account:error:retry');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        await act(async () => screen.changeTextByTestId('connected-account-manual:token', replacement));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(profile).toMatchObject({ status: 'connected', credentialRevision: nextRevision }));
        await vi.waitFor(() => expect(screen.findHostByTestId('qualified-account-detail:signed-out-banner')).toBeNull());
        expect({ value: material.value, secretRevision }).toEqual({ value: replacement, secretRevision: 2 });
    } finally { await screen.unmount(); }
}));

it('renders Vercel configuration and secret token fields with a stale registry after effect replay', async () => {
    const fixture = await restorePortableFixture(vercel);
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={vercel} sheet
        initialTarget={{ serverIdentityId: fixture.serverId, machineId: 'selected-qa-machine' }} onCancel={() => {}} />, { wrapper: React.StrictMode });
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:teamId'), screen.getTextContent()).not.toBeNull());
        const { getConnectedServiceRegistrySnapshot } = await import('@/sync/domains/connectedServices/connectedServiceRegistry');
        const registry: ConnectedServiceRegistrySnapshot = { ...getConnectedServiceRegistrySnapshot(), status: 'stale' };
        await screen.update(<PortableSetup credentials={fixture.credentials} service={vercel} sheet registry={registry}
            initialTarget={{ serverIdentityId: fixture.serverId, machineId: 'selected-qa-machine' }} onCancel={() => {}} />);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:teamId'), screen.getTextContent()).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-configuration:projectId')).not.toBeNull();
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.secureTextEntry).toBe(true);
        expect(fixture.machineRpcs).toBe(0);
        expect(fixture.machineReads).toBe(0);
    } finally { await screen.unmount(); }
});

it('shows a fresh Connect as in progress while the Account description loads, then connects once', () => withPortableSheetBrowser(async () => {
    let releaseAccounts!: () => void;
    const accountsReady = new Promise<void>(resolve => { releaseAccounts = resolve; });
    const fixture = await restorePortableFixture(vercel, false, undefined, false, undefined, 503, accountsReady);
    const screen = await renderScreen(<PortableSetup credentials={fixture.credentials} service={vercel} sheet onCancel={() => {}} />);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        await act(async () => { screen.changeTextByTestId('connected-account-manual:token', 'synthetic-inline-token'); });
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:submit')!.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await flushHookEffects({ cycles: 10 });
        // The same mounted draft is still on screen: pressing Connect does not remount the sign-in.
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.value).toBe('synthetic-inline-token');
        // The submitted draft waits for the Account description; the person sees it in progress, not an idle form.
        // A busy web control stays focusable, so the pending state is its busy accessibility state.
        expect(screen.findHostByTestId('connected-account-manual:submit')!.props.accessibilityState).toMatchObject({ busy: true });
        expect(fixture.promotions).toHaveLength(0);
        releaseAccounts();
        await vi.waitFor(() => expect(fixture.promotions, screen.getTextContent()).toHaveLength(1), { timeout: 10_000 });
        expect(fixture.vendorRequests).toContain('https://api.vercel.com/v2/teams');
    } finally { releaseAccounts(); await screen.unmount(); }
}));

it.each([
    { service: coder, fieldId: 'endpoint', value: 'https://coder-fixture.test', fromDeployment: false },
    { service: vercel, fieldId: 'teamId', value: 'team_fixture', fromDeployment: true },
])('connects $service.pluginId with one fresh inline submission', async ({ service, fieldId, value, fromDeployment }) => {
    const fixture = await restorePortableFixture(service);
    const onConnected = vi.fn();
    const { ModalProvider } = await import('@/modal');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(fixture.serverId);
    const screen = await renderScreen(fromDeployment
        ? <InjectedAuthProvider credentials={fixture.credentials}><AppShellPluginUiProjectionProvider><ModalProvider>{null}</ModalProvider></AppShellPluginUiProjectionProvider></InjectedAuthProvider>
        : <PortableSetup credentials={fixture.credentials} service={service} sheet onCancel={() => {}} onConnected={onConnected} />);
    try {
        if (fromDeployment) {
            const { showDeploymentPlatformTargetSheet } = await import('@/components/projects/deployments/DeploymentPlatformTargetSheet');
            const { createDeploymentActions } = await import('@/components/projects/deployments/deploymentActions');
            await act(async () => showDeploymentPlatformTargetSheet({ name: 'First Vercel app',
                environment: { id: 'fresh-environment', revision: 1, projectSourceId: '' },
                ownerAccountId: 'portable-controller', lifetime: account.accountLifetime,
                actions: createDeploymentActions(account.accountLifetime, ''), onApproval: () => {},
                initialTargetKey: 'happier.deploy.vercel/runtime' }));
            await vi.waitFor(() => expect(screen.findHostByTestId('project-deployments.platform.connect.add'), screen.getTextContent()).not.toBeNull());
            await screen.pressByTestIdAsync('project-deployments.platform.connect.add');
        }
        await vi.waitFor(() => expect(screen.findHostByTestId(`connected-account-configuration:${fieldId}`), screen.getTextContent()).not.toBeNull());
        await act(async () => {
            screen.changeTextByTestId(`connected-account-configuration:${fieldId}`, value);
            screen.changeTextByTestId('connected-account-manual:token', 'synthetic-inline-token');
        });
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:submit')!.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(fixture.promotions, screen.getTextContent()).toHaveLength(1), { timeout: 10_000 });
        const credential = fixture.promotions[0]!.connectedAccountCredentialMutation;
        if (!credential || !('initialConfiguration' in credential)) throw new Error('Missing initial Account configuration');
        expect(credential.initialConfiguration).toMatchObject({ expectedConfigurationRevision: null,
            replacementContentEnvelope: { t: 'plain', v: { values: { [fieldId]: value } } } });
        expect(fixture.creates).toBe(1);
        expect(fixture.machineRpcs).toBe(0);
        if (fromDeployment) {
            const { ConnectedAccountPurposeTargetChooser } = await import('./ConnectedAccountPurposeTargetChooser');
            await vi.waitFor(() => expect(screen.findAllByType(ConnectedAccountPurposeTargetChooser)
                .map(node => node.props.value), screen.getTextContent()).toContainEqual({ kind: 'account', account: credential.ref }));
            expect(screen.findHostByTestId('project-deployments.platform.connect')).toBeNull();
            expect(screen.findHostByTestId('project-deployments.platform.check')).not.toBeNull();
            expect(fixture.vendorRequests).toContain('https://api.vercel.com/v2/teams/team_fixture');
        } else {
            await vi.waitFor(() => expect(onConnected, screen.getTextContent()).toHaveBeenCalledOnce());
        }
    } finally { await screen.unmount(); account.dispose(); }
});


it('refuses a genuinely changed Coder draft and offers recovery before credential promotion', async () => {
    const fixture = await restorePortableFixture(coder);
    const onCancel = vi.fn();
    const setup = (mounted: boolean) => <PortableSetup credentials={fixture.credentials} service={coder}
        modeId="token" controllerMounted={mounted} onCancel={onCancel} />;
    const screen = await renderScreen(setup(false));
    try {
        await flushHookEffects({ cycles: 10 });
        const { runConnectedAccountAuthenticationAction } = await import('@/sync/ops/connectedAccounts/connectedAccountDaemon');
        const started = await runConnectedAccountAuthenticationAction({ serverId: fixture.serverId,
            expectedAccountId: 'portable-controller', command: { operation: 'beginConnect', service: coder, modeId: 'token' } });
        if (started.status !== 'configurationRequired' || !started.attemptId) throw new Error('Missing Coder configuration draft');
        await screen.update(setup(true));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-configuration:endpoint')).not.toBeNull());
        await flushHookEffects({ cycles: 10 });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const changed = await createDefaultActionExecutor().execute('connectedServices.configuration.replace', {
            target: { kind: 'attempt', attemptId: started.attemptId }, expectedRevision: null,
            values: { endpoint: 'https://coder-changed.test' }, secretValues: {},
        }, { surface: 'ui', authority: 'present_user', serverId: fixture.serverId, expectedAccountId: 'portable-controller' });
        expect(changed.ok).toBe(true);
        await act(async () => {
            screen.changeTextByTestId('connected-account-configuration:endpoint', 'https://coder-fixture.test');
            screen.changeTextByTestId('connected-account-manual:token', 'synthetic-conflict-token');
        });
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:submit')!.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account:error:retry'), screen.getTextContent()).not.toBeNull());
        expect(screen.getTextContent()).toContain(t('connectedServices.errors.accountConfigurationChanged'));
        expect(fixture.promotions).toHaveLength(0);
        const attemptReads = () => fixture.paths.filter(path => path === `/v2/connect/connected-account-attempt-transactions/${started.attemptId}`).length;
        const readsBeforeRetry = attemptReads();
        await screen.pressByTestIdAsync('connected-account:error:retry');
        // Retry resubmits the same draft; it cannot overwrite a newer configuration revision.
        // The real configuration owner reads the addressed transaction before checking its revision.
        await vi.waitFor(() => expect(attemptReads()).toBeGreaterThan(readsBeforeRetry));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:submit')!.props.accessibilityState?.busy).not.toBe(true));
        expect(screen.findHostByTestId('connected-account:error')).not.toBeNull();
        await screen.pressByTestIdAsync('connected-account:error-details-toggle');
        expect(screen.findByTestId('connected-account:error-details-code')?.props.children).toContain('connected_account_configuration_changed');
        expect(screen.findHostByTestId('connected-account-manual:token')!.props.editable).not.toBe(false);
        expect(fixture.promotions).toHaveLength(0);
        await screen.pressByTestIdAsync('connected-account-setup:cancel');
        expect(onCancel).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(fixture.transactions.has(started.attemptId!)).toBe(false));
        expect(fixture.promotions).toHaveLength(0);
    } finally { await screen.unmount(); }
});
