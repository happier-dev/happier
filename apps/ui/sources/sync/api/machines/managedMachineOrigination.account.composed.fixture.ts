import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import signedRelease from './managedMachineOrigination.signedRelease.fixture.json';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { encodeBase64 } from '@/encryption/base64';
import nacl from 'tweetnacl';
import { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));
const native = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock('expo-constants', async original => {
    const module = await original<typeof import('expo-constants')>();
    return { ...module, default: { ...module.default,
        expoConfig: { ...module.default.expoConfig, extra: { app: { identityVariant: 'publicdev', variant: 'preview' } } },
    } };
});
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: native.fetch }));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
// Packaged assets and the native HTTP SDK are platform boundaries. The public
// compiler, Account activation, credential materializer and native roles stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    get BUNDLED_PLUGIN_UI_APP_ARTIFACTS() { return packaged.artifacts; },
    get BUNDLED_PLUGIN_UI_APP_DECLARATIONS() { return packaged.declarations; },
    BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({
    localUri: `file:///managed-account-fixture/${asset}`, downloadAsync: async () => {},
}) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private readonly uri: string) {}
    async bytes() {
        packaged.reads++;
        const bytes = packaged.files.get(Number(this.uri.split('/').at(-1)));
        if (!bytes) throw new Error('Missing packaged managed fixture');
        return bytes;
    }
} }));
vi.mock('expo-crypto', async original => ({ ...await original<typeof import('expo-crypto')>(),
    randomUUID: (await import('node:crypto')).randomUUID }));
installApprovalCommonModuleMocks();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const [{ PLUGIN_MANIFEST }, { prepareAuthenticationInventory }, { createDefaultActionExecutor },
    { reconcileProjectedPluginUiClientExecutables }] = await Promise.all([
    import('../../../../../../packages/plugins/machine-vercel/src/manifest'),
    import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
    import('@/sync/ops/actions/defaultActionExecutor'),
    import('@/components/plugins/reactNative/clientExecutableActivation'),
]);
await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST,
    target: { artifactId: 'account-runtime', exportName: 'activateAccount' },
    projectPath: 'packages/plugins/machine-vercel', entryPath: 'packages/plugins/machine-vercel/src/manifest.ts',
    additionalArtifacts: [{ target: { artifactId: 'connected-account-authentication', exportName: 'activate' },
        entryPath: 'packages/plugins/machine-vercel/src/account.ts' }],
    packageName: '@happier-dev/plugins-machine-vercel' });
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    await getInstalledPluginUiClientExecutableComposition().unload();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

export function registerManagedAccountHostTests(host: 'native' | 'browser') {
const cases: ReadonlyArray<readonly [string, boolean, 'machines.managed.delete' | 'machines.managed.cancel' | null, boolean, boolean]> = host === 'native' ? [['native', false, null, false, false] as const] : [
    ['browser', true, null, false, false],
    ['browser delete', false, 'machines.managed.delete', false, false],
    ['browser cancel', false, 'machines.managed.cancel', false, false],
    ['browser absent cleanup', false, 'machines.managed.delete', true, false],
    ['browser stopped retained cancel', false, 'machines.managed.cancel', false, true],
] as const;
it.each(cases)('%s host carries the designed Create/Send review through the public Account path', async (label, startAgent, cleanupAction, alreadyAbsent, stoppedCleanup) => {
    if (host === 'native') vi.stubGlobal('__TAURI_INTERNALS__', { invoke: () => null });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { bindPresentUserActionConfirmation } = await import('@/sync/ops/actions/presentUserConfirmation');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const { createUiConnectedAccountContent } = await import('@/sync/ops/connectedAccounts/connectedAccountContent');
    const { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema } =
        await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
    const accountId = 'native-managed-creator';
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverUrl = 'https://native-managed-account.test';
    const homeId = 'srv_native_managed_account';
    const serverId = await homes.addHome({ name: 'Native managed', serverUrl, accountId, credentials, serverIdentityId: homeId,
        accountEncryptionMode: 'plain', credentialResourcesEnabled: true });
    // Model the current Home connection's observed descriptor, rather than the
    // harness's legacy URL-only profile. Enrollment transfers this same Home.
    const { reconcileServerProfileHomeConnectionDescriptor } = await import('@/sync/domains/server/serverProfiles');
    expect(await reconcileServerProfileHomeConnectionDescriptor({ serverUrl, observedServerIdentityId: homeId,
        descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: serverUrl }] },
    })).toMatchObject({ kind: 'applied' });
    // The plain Account's Home admits ordinary token-only terminal pairing.
    const homeFeatures = FeaturesResponseSchema.parse(await (await homes.request(`${serverUrl}/v1/features`)).json());
    homeFeatures.features.encryption.plaintextStorage.enabled = true;
    homeFeatures.features.e2ee.keylessAccounts.enabled = true;
    homes.answer(serverId, '/v1/features', { body: homeFeatures });
    homes.answer(serverId, '/v1/features/authenticated', { body: homeFeatures });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    const provisioner = PLUGIN_MANIFEST.contributes.machineProvisioners?.[0];
    if (!provisioner) throw new Error('Missing Vercel declaration');
    const selected = { service: { pluginId: PLUGIN_MANIFEST.id, localId: 'vercel-account' }, accountId: 'explicit-selected' };
    const secret = 'private-selected-vercel-token';
    let credential: unknown;
    let configuration: unknown;
    let managed: ReturnType<typeof ManagedMachineV1Schema.parse> | undefined;
    let admissions = 0;
    let allocations = 0;
    let machineRpcs = 0;
    let approvals = 0;
    let guestDispatches = 0;
    let guestContinuation: unknown;
    let acquireDigest = '';
    let interruptJoin = !startAgent;
    let vendorAbsent = false;
    let vendorStopped = false;
    let deletes = 0;
    let stops = 0;
    let readCreationStage: ((stage: 'installing' | 'joining') => Promise<void>) | undefined;
    const installationKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const installationPublicKey = encodeBase64(installationKeys.publicKey, 'base64url');
    const guest = { ...createPlainMachineRowFixture({ id: 'joined', accountId }),
        installationPublicKey: encodeBase64(installationKeys.publicKey, 'base64') };
    const guestAccess = MachineAccessGrantsListResponseV1Schema.parse({ machineId: guest.id,
        custodian: { accountId, displayName: 'Test Account' }, access: guest.access,
        canManage: true, grants: [], ownDirectGrant: true, ownAccessSources: [],
    });
    connection = await restoreServerAccountForTest({ serverUrl, accountId, credentials,
        additionalRequestOrigins: ['https://api.vercel.com'],
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string) => {
                if (event.includes('rpc')) { machineRpcs++; throw new Error('Zero-Machine Account work cannot use Machine RPC'); }
                return { ok: true };
            });
        },
        request: async (url, init) => {
            const address = new URL(String(url));
            if (address.origin === 'https://api.vercel.com') return native.fetch(url, init);
            const path = address.pathname;
            if (path === '/v1/machines/managed/actions/get') return Response.json(managed);
            if (path === '/v1/machines/managed/actions/cancel') {
                managed = ManagedMachineV1Schema.parse({ ...managed, creationState: 'canceled', desired: 'delete',
                    intentRevision: managed!.intentRevision + 1, cleanup: { disposition: 'pending', reason: 'creation_canceled' } });
                return Response.json({ machine: managed });
            }
            if (path.endsWith('/controller/admit-control')) {
                const body = await new Response(init?.body).json();
                expect(body).toMatchObject({ action: 'machines.managed.delete', input: { when: 'now', expectedRevision: managed!.intentRevision } });
                managed = ManagedMachineV1Schema.parse({ ...managed, desired: 'delete', intentRevision: managed!.intentRevision + 1,
                    cleanup: { disposition: 'pending', reason: 'delete_requested' } });
                return Response.json({ machine: managed, replayed: false });
            }
            if (path.endsWith('/controller/submit-intent')) {
                const body = await new Response(init?.body).json();
                if (managed?.submittedNativeEffect) return Response.json({ submitted: false, machine: managed });
                managed = ManagedMachineV1Schema.parse({ ...managed, submittedNativeEffect: {
                    requestId: body.requestId, intentRevision: body.expectedIntentRevision, intent: 'delete' } });
                return Response.json({ submitted: true, machine: managed });
            }
            if (path.endsWith('/controller/report-intent')) {
                const body = await new Response(init?.body).json();
                if (stoppedCleanup) {
                    expect(body).toMatchObject({ requestId: 'prior-delete', expectedIntentRevision: 2 });
                    expect(managed?.intentRevision).toBe(4);
                }
                managed = ManagedMachineV1Schema.parse({ ...managed,
                    ...(body.result.kind === 'accepted' ? { nativeOperationRef: body.result.nativeOperationRef } : {}),
                    ...(body.observation ? { observation: body.observation } : {}),
                    ...(body.observation?.availability === 'absent' ? { allocation: 'confirmed-absent', cleanup: undefined,
                        submittedNativeEffect: undefined, nativeOperationRef: undefined } : {}) });
                return Response.json({ machine: managed });
            }
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, id => id === 'joined' ? guest : null);
            if (path === '/v1/machines/joined') return Response.json({ machine: guest });
            if (path === '/v1/machines/joined/access') return Response.json(guestAccess);
            if (path === '/v1/actions/session.spawn_new/execution-authorization') {
                const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(await new Response(init?.body).json());
                guestContinuation = body.managedContinuation;
                return Response.json({ v: 1, token: 'guest-creation-proof', binding: {
                    serverIdentityId: homeId, accountId, authentication: { kind: 'account', tokenEpoch: 0 },
                    actionId: 'session.spawn_new', requestId: body.envelope.requestId, target: { kind: 'machine', machineId: 'joined' },
                    machineId: 'joined', installationId: guest.installationId, custodianAccountId: accountId, accountEncryptionMode: 'plain',
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
                    managedContinuation: { ...body.managedContinuation, acquireRequestEnvelopeDigest: acquireDigest },
                } });
            }
            if (path === '/v1/actions/session.spawn_new') {
                guestDispatches++;
                const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(await new Response(init?.body).json());
                return Response.json(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'session.spawn_new', requestId: body.envelope.requestId, execution: { ok: true, result: SessionSpawnNewActionResultV1Schema.parse({
                    type: 'success', disposition: 'created', sessionId: 'managed-session', executionTarget: { serverId: homeId, machineId: 'joined' },
                    organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' },
                }) } }));
            }
            if (path === '/v4/connect/qualified/accounts') return Response.json({ service: selected.service, accounts: [{
                ref: selected, status: 'connected', authenticationModeId: 'token', configurationReady: true,
                configurationRevision: 'selected-config', revisionSemantics: 'revisioned',
                credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [],
            }] });
            if (path === '/v4/connect/qualified/credential') return Response.json(credential);
            if (path === '/v4/connect/qualified/configuration') return Response.json(configuration);
            if (path.endsWith('/controller/admit')) {
                admissions++;
                const body = await new Response(init?.body).json();
                acquireDigest = body.requestEnvelopeDigest;
                managed = ManagedMachineV1Schema.parse({ id: 'managed-1', homeId, custodianAccountId: accountId,
                    enrollmentAccountId: accountId, enrollmentIdentity: body.input.enrollmentIdentity,
                    launch: body.input.selection.launch, retention: body.input.selection.retention,
                    reviewedFacts: body.input.reviewedFacts,
                    allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
                    wakeOnAcceptedMessage: false });
                return Response.json({ machine: managed, replayed: false });
            }
            if (path.endsWith('/controller/submit')) {
                managed = ManagedMachineV1Schema.parse({ ...managed, allocation: 'may-exist' });
                return Response.json({ submitted: true, machine: managed });
            }
            if (path.endsWith('/controller/report')) {
                const body = await new Response(init?.body).json();
                if (body.result.kind === 'bound') managed = ManagedMachineV1Schema.parse({ ...managed, allocation: 'bound', resource: body.result.resource,
                    ...(body.bootstrapInstalled ? { bootstrapInstalled: true } : {}) });
                if (body.observation) managed = ManagedMachineV1Schema.parse({ ...managed, observation: body.observation });
                return Response.json({ machine: managed });
            }
            if (path.endsWith('/controller/current') || path.endsWith('/controller/enrollment-context')) return Response.json({ machine: managed });
            if (path.endsWith('/controller/context')) return Response.json({ machine: managed, requestId: 'native-managed-create',
                enrollmentInstallation: { machineId: 'joined', installationId: guest.installationId, installationPublicKey } });
            if (path === '/v1/auth/response') {
                approvals++;
                managed = ManagedMachineV1Schema.parse({ ...managed, enrolledMachineId: 'joined' });
                return Response.json({ success: true });
            }
            if (path === '/v1/auth/request/status') return Response.json({ status: 'pending', supportsV2: true });
            return homes.request(url, init);
        } });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        expect(account.serverIdentityId).toBe(homeId);
        expect(await (await import('@/utils/system/runtimeFetch')).readRuntimeFetchHost(account.endpointUrl)).toBe(host);
        const content = createUiConnectedAccountContent(account);
        const mode = await content.resolveAccountMode();
        credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: selected, authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: 'selected-config',
            content: content.seal('credential', mode, { v: 1, values: { token: secret } }), metadata: { scopes: [] } });
        configuration = QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({ target: { kind: 'account', ref: selected },
            authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            configurationRevision: 'selected-config', configurationContent: content.seal('configuration', mode, {
                values: { teamId: 'team_one', projectId: 'prj_one' }, secretRefs: {},
            }) });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing Account lifetime');
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const reader = readPluginAccountAvailability(lifetime.scope);
        expect((await reader.ensureCurrentAccountExecution(PLUGIN_MANIFEST.id)).kind).toBe('available');
        const projection = reader.readAccountUiProjection();
        if (!projection) throw new Error('Missing Account projection');
        await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: 'web', reader,
            accountLifetime: lifetime, loaderBackend: createPluginUiCommonJsLoaderBackend() });
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const { registerCurrentUiContextActionPort } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const { createCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
        onTestFinished(publishCommittedAppShellPluginUiProjection(() => reader.readAccountUiProjection()));
        onTestFinished(registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface, hostAction, readProjection: () => reader.readAccountUiProjection(),
            // No route commands are mounted in this foreground Account journey.
            reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
            readNavigationBinding: () => null,
        })));
        let running = false;
        const commands = new Map<string, string>();
        const session = { id: 'sbx_one', sourceSandboxName: 'happier-managed-1', projectId: 'prj_one', createdAt: 919,
            networkPolicy: { mode: 'allow-all' } };
        const snapshot = { id: 'snap_one', sourceSessionId: session.id, projectId: 'prj_one', createdAt: 1100, status: 'created' };
        const named = () => ({ sandbox: { name: 'happier-managed-1', createdAt: 1000, currentSessionId: session.id,
            ...(vendorStopped ? { currentSnapshotId: snapshot.id } : {}),
            persistent: true, status: vendorStopped ? 'stopped' : 'running', tags: { 'happier-managed-id': 'managed-1' },
            expiresAt: Date.now() + 300000, networkPolicy: { mode: 'allow-all' } }, session });
        native.fetch.mockImplementation(async (url, init) => {
            const path = new URL(String(url)).pathname;
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
            if (path === '/v9/projects/prj_one') return Response.json({ id: 'prj_one' });
            if (path === '/v2/teams/team_one') return Response.json({ id: 'team_one', billing: { plan: 'pro' } });
            if (path === '/v4/sandboxes') { allocations++; return Response.json(named()); }
            if (path === '/v2/sandboxes/happier-managed-1') {
                if (init?.method === 'DELETE') { deletes++; vendorAbsent = true; }
                return allocations && !vendorAbsent ? Response.json(named()) : Response.json({}, { status: 404 });
            }
            if (path.endsWith('/stop')) { stops++; vendorStopped = true; return Response.json({}); }
            if (path === '/v2/sandboxes/snapshots') return Response.json({ snapshots: vendorStopped && !vendorAbsent ? [snapshot] : [], pagination: { next: null } });
            if (path === '/v2/sandboxes/sessions/sbx_one') return Response.json({ session });
            if (path === '/v2/sandboxes/snapshots/snap_one') return Response.json({ snapshot: { ...snapshot, status: vendorAbsent ? 'deleted' : 'created' } });
            if (path.endsWith('/cmd') && init?.method === 'POST') {
                const body = await new Response(init.body).json();
                const id = `command-${commands.size}`;
                commands.set(id, [body.command, ...(body.args ?? [])].join(' '));
                return Response.json({ command: { id, sessionId: session.id, exitCode: null } });
            }
            const id = path.split('/cmd/')[1]?.split('/')[0];
            if (id && path.endsWith('/logs')) {
                const command = commands.get(id) ?? '';
                let stdout = '';
                if (command.includes('uname -s')) {
                    await readCreationStage?.('installing');
                    stdout = 'Linux\nx86_64\n/home/guest\n';
                }
                else if (command.includes(signedRelease.source) && command.includes('checksums-happier-')) {
                    stdout = command.includes('.txt.minisig') ? signedRelease.signatureText : signedRelease.checksumsText;
                }
                else if (command.includes('current_target=') && command.includes('version_path')) stdout = 'current=\nprevious=\n';
                else if (command.includes("'auth' 'request'")) {
                    await readCreationStage?.('joining');
                    if (interruptJoin) return Response.json({ error: 'Join interrupted at native transport' }, { status: 503 });
                    stdout = JSON.stringify({ kind: 'remote_home_enrollment_pairing_request',
                    protocolVersion: 1, publicKey: encodeBase64(new Uint8Array(32).fill(1)), homeServerIdentityId: homeId,
                    pairing: { secretB64Url: encodeBase64(new Uint8Array(32).fill(23), 'base64url'), createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000 },
                    supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'guest-home' });
                }
                else if (command.includes("'auth' 'wait'")) stdout = JSON.stringify({ kind: 'remote_home_enrollment_result', protocolVersion: 1,
                    success: true, homeServerIdentityId: homeId, machineId: 'joined', encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'guest-home' });
                else {
                    if (command.includes('daemon') && command.includes('start')) running = true;
                    const status = { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'joined',
                        services: [], service: { installed: false }, daemon: { running, healthy: running }, auth: { needsAuth: false, machineId: 'joined' }, server: { activeServerId: 'guest-home' } };
                    stdout = JSON.stringify({ ...status, v: 1, ok: true, kind: 'auth_status', data: status });
                }
                return new Response(JSON.stringify({ stream: 'stdout', data: stdout }) + '\n');
            }
            if (id) return Response.json({ command: { id, sessionId: session.id, exitCode: 0 } });
            throw new Error(`Unexpected native vendor HTTP ${path}`);
        });
        const homeFetch = globalThis.fetch;
        vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) => new URL(String(url)).origin === 'https://api.vercel.com'
            ? native.fetch(url, init) : homeFetch(url, init));
        const { createPluginSurfaceAccountNetworkServices } = await import('@/components/plugins/surfaces/pluginSurfaceAccountNetworkServices');
        const networkProbe = createPluginSurfaceAccountNetworkServices({ pluginId: PLUGIN_MANIFEST.id,
            accountLifetime: lifetime, signal: new AbortController().signal, isCurrent: () => lifetime.isCurrent() });
        try {
            const probe = await networkProbe.http.request({ url: 'https://api.vercel.com/v2/teams/team_one',
                headers: { authorization: `Bearer ${secret}` }, redirect: 'error' }).then(
                response => ({ phase: 'account_http', status: response.status }),
                (error: unknown) => ({ phase: 'account_http', code: error !== null && typeof error === 'object'
                    ? Reflect.get(error, 'code') : undefined }));
            expect(probe).toEqual({ phase: 'account_http', status: 200 });
        } finally { networkProbe.dispose(); }
        const launch = { provider: { pluginId: PLUGIN_MANIFEST.id, localId: provisioner.id }, schemaVersion: 1, name: 'Guest',
            choices: { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 2, timeoutMs: 300000, snapshotExpirationMs: 0 },
            credentials: [{ purpose: { consumer: { pluginId: PLUGIN_MANIFEST.id, localId: provisioner.id }, purpose: 'cloud-api' },
                account: selected }] };
        const retention = { kind: 'until-delete' as const };
        const input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'one-off', homeId, launch, retention, wakeOnAcceptedMessage: false },
            ...(startAgent ? { agentStart: { directory: { kind: 'managed' }, agentTarget: {
                kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            } } } : {}),
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, reviewedFacts: { launch, provisioner, retention,
                retentionCapabilities: provisioner.retention, billing: provisioner.billing, optionStatus: 'current', prerequisites: [], wakeOnAcceptedMessage: false } });
        // Captured public release HTTP bytes keep signature verification and
        // guest installation real; no internal recipe or Action port is replaced.
        const releaseMetadataPaths: string[] = [];
        vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
            const address = new URL(String(url));
            if (address.origin === 'https://api.vercel.com') return native.fetch(url, init);
            if (address.origin === 'https://api.github.com') {
                releaseMetadataPaths.push(address.pathname);
                expect(address.pathname).toBe('/repos/happier-dev/happier/releases/tags/cli-dev');
                return Response.json({ assets: [
                `checksums-happier-v${signedRelease.version}.txt`,
                `checksums-happier-v${signedRelease.version}.txt.minisig`,
                `happier-v${signedRelease.version}-linux-x64.tar.gz`,
                ].map(name => ({ name, browser_download_url: `${signedRelease.source}${name}` })) });
            }
            if (address.origin === 'https://github.com') {
                throw new TypeError('GitHub release asset downloads lack browser CORS');
            }
            return homes.request(url, init);
        });
        const executor = createDefaultActionExecutor();
        const context = bindPresentUserActionConfirmation('machines.managed.acquire', input, { surface: 'ui', authority: 'present_user',
            serverId, serverIdentityId: homeId, runtimeAccountId: accountId, actionRequestId: 'native-managed-create',
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) });
        const discoveryContext = { ...context, presentUserConfirmation: undefined, actionRequestId: 'account-provider-discovery' };
        const probe = { homeId, contribution: launch.provider };
        expect(await executor.execute('machines.provisioners.check', probe, discoveryContext))
            .toMatchObject({ ok: false, errorCode: 'credential_unavailable' });
        expect(await executor.execute('machines.provisioners.check', { ...probe, credentials: launch.credentials }, discoveryContext))
            .toMatchObject({ ok: true, result: { available: true } });
        expect(await executor.execute('machines.provisioners.options', {
            ...probe, credentials: launch.credentials, selectors: launch.choices,
        }, discoveryContext)).toMatchObject({ ok: true, result: { base: { available: true, launch: launch.choices } } });
        expect({ admissions, allocations, machineRpcs }).toEqual({ admissions: 0, allocations: 0, machineRpcs: 0 });
        const stages = new Set<string>();
        readCreationStage = async stage => {
            const observed = await executor.execute('machines.managed.get', { homeId, managedId: 'managed-1' }, {
                ...context, actionRequestId: `stage-${stage}`, presentUserConfirmation: undefined,
            });
            expect(observed).toMatchObject({ ok: true, result: { id: 'managed-1', allocation: 'bound' } });
            if (!observed.ok) throw new Error('Creation fact read failed');
            const row = ManagedMachineV1Schema.parse(observed.result);
            expect(row.enrolledMachineId).toBeUndefined();
            if (stage === 'joining') expect.soft(row).toMatchObject({ bootstrapInstalled: true });
            else expect(row.bootstrapInstalled).toBeUndefined();
            stages.add(stage);
        };
        // Exercise both mounted entry owners, without a test-supplied confirmation
        // or private port. Vendor/Home HTTP remain the only effect boundaries.
        let interrupted: ActionExecuteResult;
        if (startAgent) {
            const { runManagedMachineCreation } = await import('@/components/settings/machines/managed/managedMachineCreation');
            const created = await runManagedMachineCreation({
                draft: { selection: input.selection, receipt: input.reviewedFacts!, enrollmentIdentity: input.enrollmentIdentity },
                acquisition: { requestId: 'native-managed-create', selection: input.selection },
                agentStart: input.agentStart, scope: lifetime.scope, signal: new AbortController().signal,
                isCurrent: () => lifetime.isCurrent(), onAcquisitionChange: () => {}, onProgress: () => {},
                onApprovalPending: () => { throw new Error('The designed review must answer default confirmation'); },
            });
            const code = created.kind === 'failed' ? created.code : created.kind;
            interrupted = created.kind === 'enrolled' ? { ok: true, result: { managedId: created.machine.id } }
                : { ok: false, errorCode: code, error: code };
        } else {
            const { createManagedProvisionerClient } = await import('@/components/settings/machines/managed/managedProvisionerClient');
            const created = await createManagedProvisionerClient(lifetime.scope, homeId).execute('machines.managed.acquire', input);
            const code = created.kind === 'failed' ? created.code : created.kind;
            interrupted = created.kind === 'succeeded' ? { ok: true, result: created.value }
                : { ok: false, errorCode: code, error: code };
        }
        expect(releaseMetadataPaths).toEqual(['/repos/happier-dev/happier/releases/tags/cli-dev']);
        expect(stages, JSON.stringify(interrupted)).toEqual(new Set(['installing', 'joining']));
        readCreationStage = undefined;
        let retried = interrupted;
        if (!startAgent) {
            expect(interrupted).toMatchObject({ ok: false });
            const retained = await executor.execute('machines.managed.get', { homeId, managedId: 'managed-1' }, {
                ...context, actionRequestId: 'stage-interrupted', presentUserConfirmation: undefined,
            });
            expect(retained).toMatchObject({ ok: true, result: { allocation: 'bound', bootstrapInstalled: true } });
            if (!retained.ok) throw new Error('Interrupted creation read failed');
            expect(ManagedMachineV1Schema.parse(retained.result).enrolledMachineId).toBeUndefined();
            expect({ running, allocations, approvals, guestDispatches }).toEqual({ running: false, allocations: 1, approvals: 0, guestDispatches: 0 });
            if (cleanupAction) {
                vendorAbsent = alreadyAbsent;
                if (stoppedCleanup) {
                    vendorStopped = true;
                    managed = ManagedMachineV1Schema.parse({ ...managed, intentRevision: 2, desired: 'delete',
                        cleanup: { disposition: 'pending', reason: 'delete_requested' },
                        submittedNativeEffect: { requestId: 'prior-delete', intentRevision: 2, intent: 'delete' } });
                }
                if (alreadyAbsent) managed = ManagedMachineV1Schema.parse({ ...managed, creationState: 'canceled', desired: 'delete',
                    cleanup: { disposition: 'pending', reason: 'creation_canceled' } });
                const cleanupInput = cleanupAction === 'machines.managed.delete'
                    ? { homeId, managedId: 'managed-1', when: 'now' as const, expectedRevision: managed!.intentRevision,
                        intent: 'delete' as const, reviewedDependencies: true as const }
                    : { homeId, managedId: 'managed-1', expectedIntentRevision: managed!.intentRevision };
                const cleaned = await executor.execute(cleanupAction, cleanupInput,
                    bindPresentUserActionConfirmation(cleanupAction, cleanupInput, {
                        ...context, actionRequestId: 'native-managed-cleanup', presentUserConfirmation: undefined,
                    }));
                expect.soft(cleaned, JSON.stringify(cleaned)).toMatchObject({ ok: true });
                expect.soft(managed).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
                expect.soft(managed?.cleanup).toBeUndefined();
                expect.soft(managed?.submittedNativeEffect).toBeUndefined();
                expect.soft({ stops, deletes }).toEqual(alreadyAbsent ? { stops: 0, deletes: 0 } : { stops: stoppedCleanup ? 0 : 1, deletes: 1 });
                return;
            }
            interruptJoin = false;
            const retryInput = { homeId, managedId: 'managed-1', expectedIntentRevision: 0 };
            retried = await executor.execute('machines.managed.bootstrap.retry', retryInput,
                bindPresentUserActionConfirmation('machines.managed.bootstrap.retry', retryInput, {
                    ...context, actionRequestId: 'native-managed-retry', presentUserConfirmation: undefined,
                }));
        }
        expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true, result: { managedId: 'managed-1' } });
        const joined = await executor.execute('machines.managed.get', { homeId, managedId: 'managed-1' }, {
            ...context, actionRequestId: 'stage-joined', presentUserConfirmation: undefined,
        });
        expect(joined).toMatchObject({ ok: true, result: { allocation: 'bound', bootstrapInstalled: true, enrolledMachineId: 'joined' } });
        expect({ admissions, allocations, approvals, machineRpcs, guestDispatches }).toEqual({
            admissions: 1, allocations: 1, approvals: 1, machineRpcs: 0, guestDispatches: startAgent ? 1 : 0,
        });
        if (startAgent) expect(guestContinuation).toEqual({ managedId: 'managed-1', creationRequestId: 'native-managed-create', expectedIntentRevision: 0 });
        expect(JSON.stringify({ interrupted, retried })).not.toContain(secret);
        const inspect = await executor.execute('machines.managed.inspect', { homeId, managedId: 'managed-1' }, {
            ...context, actionRequestId: 'native-managed-inspect', presentUserConfirmation: undefined,
        });
        expect.soft(inspect, JSON.stringify(inspect)).toMatchObject({ ok: true, result: { machine: { id: 'managed-1',
            observation: { availability: 'present', power: 'running' } } } });
        expect.soft(allocations).toBe(1);
        expect.soft(approvals).toBe(1);
        expect.soft(JSON.stringify({ inspect, retried })).not.toContain(secret);
    } finally { account.dispose(); }
});
}
