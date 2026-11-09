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
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import type { NativeSshModule, NativeSshHostKeyVerification } from '@happier-dev/ssh-native';

const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));
const native = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>(), exec: vi.fn(), platform: 'ios', trustPrompts: 0,
    hostKeyListeners: new Set<Parameters<NonNullable<NativeSshModule['addListener']>>[1]>(),
    stdoutListeners: new Set<Parameters<NonNullable<NativeSshModule['addListener']>>[1]>(),
    hostKeyResponses: new Map<string, (response: NativeSshHostKeyVerification) => void>(),
}));
vi.mock('@happier-dev/ssh-native', async original => ({ ...await original<typeof import('@happier-dev/ssh-native')>(),
    getNativeSshAvailability: () => ({ available: true, platform: 'ios', engine: 'russh', moduleVersion: 'test',
        supportsLoopbackTunnel: false, supportsPersistentHostKeyStorage: false }),
    getOptionalHappierSshNativeModule: () => ({ exec: native.exec, cancelRequest: async () => {},
        addListener: (eventName: string, listener: Parameters<NonNullable<NativeSshModule['addListener']>>[1]) => {
            if (eventName === 'hostKeyPrompt') native.hostKeyListeners.add(listener);
            if (eventName === 'stdout') native.stdoutListeners.add(listener);
            return { remove: () => { native.hostKeyListeners.delete(listener); native.stdoutListeners.delete(listener); } };
        },
        respondToHostKeyPrompt: async (promptId: string, response: NativeSshHostKeyVerification) => {
            native.hostKeyResponses.get(promptId)?.(response);
        },
        getAvailability: () => ({ available: true, platform: 'ios', engine: 'russh', moduleVersion: 'test',
            supportsLoopbackTunnel: false, supportsPersistentHostKeyStorage: false }) }),
}));
vi.mock('expo/fetch', () => ({ fetch: native.fetch }));
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
    import('@/dev/testkit/fixtures/managedAccountSsh'),
    import('@/dev/testkit/fixtures/connectedAccountAuthentication'),
    import('@/sync/ops/actions/defaultActionExecutor'),
    import('@/components/plugins/reactNative/clientExecutableActivation'),
]);
await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST,
    target: { artifactId: 'account-runtime', exportName: 'activateAccount' },
    projectPath: 'apps/ui', entryPath: 'apps/ui/sources/dev/testkit/fixtures/managedAccountSsh.ts',
    packageName: '@acme/cloud-ssh' });
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

it.each(['pinned', 'substituted', 'browser', 'retained'] as const)('Account SSH %s preserves credential custody through shared enrollment', async scenario => {
    native.trustPrompts = 0;
    native.hostKeyListeners.clear();
    native.stdoutListeners.clear();
    native.hostKeyResponses.clear();
    native.platform = scenario === 'browser' ? 'web' : 'ios';
    // Static harness imports may acquire the shared native module before the
    // approval options are installed; change the OS boundary they all observe.
    const nativeModules = await Promise.all([
        import('react-native'),
        vi.importActual<typeof import('@/dev/reactNativeStub')>('@/dev/reactNativeStub'),
    ]);
    for (const { Platform } of nativeModules) {
        Object.defineProperty(Platform, 'OS', { configurable: true, get: () => native.platform });
    }
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalBoundary = createModalModuleMock({ spies: { show(config) {
        const sheet = config as Readonly<{ chrome?: Readonly<{ testID?: string }>; props?: Readonly<{ onResolve?(trusted: boolean): void }> }>;
        expect(sheet.chrome?.testID).toBe('ssh-host-key-modal');
        native.trustPrompts++;
        queueMicrotask(() => sheet.props?.onResolve?.(true));
        return 'managed-ssh-trust';
    } } });
    const modalModules = await Promise.all([import('@/modal'), vi.importActual<typeof import('@/modal')>('@/modal')]);
    for (const { Modal } of modalModules) vi.spyOn(Modal, 'show').mockImplementation(modalBoundary.spies.show);
    if (scenario === 'browser') {
        const browser = await (await import('@/dev/testkit/harness/browserRuntimeHarness')).installBrowserRuntimeForTests({ url: 'https://native-managed-account.test' });
        onTestFinished(() => browser.restore());
    }
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { bindPresentUserActionConfirmation } = await import('@/sync/ops/actions/presentUserConfirmation');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
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
    if (!provisioner) throw new Error('Missing SSH provisioner declaration');
    const secretMaterials = new Map<string, ReturnType<typeof SavedSecretResourceMaterialsResponseV1Schema.parse>['resources'][number]>();
    const retainCredential = (input: unknown) => {
        const created = SharedSavedSecretCreateInputV1Schema.parse(input);
        const material = SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
            resourceId: created.resourceId, encryptionMode: created.encryptionMode, storedContent: created.storedContent,
            recipientEnvelope: null, entry: { ref: `happier:shared-secret:v1:${created.resourceId}`, source: 'shared_resource',
                relationship: 'owner', ownerAccountId: accountId, name: created.displayName, kind: created.kind, revision: 1,
                materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        }] }).resources[0]!;
        secretMaterials.set(created.resourceId, material);
        return created.resourceId;
    };
    let managed: ReturnType<typeof ManagedMachineV1Schema.parse> | undefined;
    let admissions = 0;
    let allocations = 0;
    let machineRpcs = 0;
    let approvals = 0;
    let credentialCreations = 0;
    let hostPublicKey = '';
    let bootstrapKey = '';
    let retainedLoginKey = '';
    const verifications: unknown[] = [];
    const installationKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const installationPublicKey = encodeBase64(installationKeys.publicKey, 'base64url');
    const guest = { ...createPlainMachineRowFixture({ id: 'joined', accountId }),
        installationPublicKey: encodeBase64(installationKeys.publicKey, 'base64') };
    const guestAccess = MachineAccessGrantsListResponseV1Schema.parse({ machineId: guest.id,
        custodian: { accountId, displayName: 'Test Account' }, access: guest.access,
        canManage: true, grants: [], ownDirectGrant: true, ownAccessSources: [],
    });
    connection = await restoreServerAccountForTest({ serverUrl, accountId, credentials,
        additionalRequestOrigins: ['https://cloud-ssh.test'],
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string) => {
                if (event.includes('rpc')) { machineRpcs++; throw new Error('Zero-Machine Account work cannot use Machine RPC'); }
                return { ok: true };
            });
        },
        request: async (url, init) => {
            const address = new URL(String(url));
            if (address.origin === 'https://cloud-ssh.test') return native.fetch(url, init);
            const path = address.pathname;
            if (path === '/v1/machines/managed/actions/get') return Response.json(managed);
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, id => id === 'joined' ? guest : null);
            if (path === '/v1/machines/joined') return Response.json({ machine: guest });
            if (path === '/v1/machines/joined/access') return Response.json(guestAccess);
            if (path === '/v1/account/saved-secrets/resources/materials') {
                return Response.json(SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [...secretMaterials.values()] }));
            }
            if (path.endsWith('/controller/admit')) {
                admissions++;
                const body = await new Response(init?.body).json();
                managed = ManagedMachineV1Schema.parse({ id: 'managed-1', homeId, custodianAccountId: accountId,
                    enrollmentAccountId: accountId, enrollmentIdentity: body.input.enrollmentIdentity,
                    launch: body.input.selection.launch, retention: body.input.selection.retention,
                    reviewedFacts: body.input.reviewedFacts,
                    allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
                    wakeOnAcceptedMessage: false });
                return Response.json({ machine: managed, replayed: false });
            }
            if (path.endsWith('/controller/create-bootstrap-credential')) {
                const body = await new Response(init?.body).json();
                credentialCreations++;
                const resourceId = retainCredential(body.credential);
                managed = ManagedMachineV1Schema.parse({ ...managed,
                    bootstrapCredentialRef: { kind: 'shared_resource', resourceId } });
                return Response.json({ machine: managed });
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
        expect(await (await import('@/utils/system/runtimeFetch')).readRuntimeFetchHost(account.endpointUrl)).toBe(scenario === 'browser' ? 'browser' : 'native');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing Account lifetime');
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const reader = readPluginAccountAvailability(lifetime.scope);
        expect((await reader.ensureCurrentAccountExecution(PLUGIN_MANIFEST.id)).kind).toBe('available');
        const projection = reader.readAccountUiProjection();
        if (!projection) throw new Error('Missing Account projection');
        const { resolvePluginUiClientExecutablePlatform } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');
        await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: resolvePluginUiClientExecutablePlatform(), reader,
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
        let serviceInstalled = false;
        native.fetch.mockImplementation(async (url, init) => {
            expect(new URL(String(url)).pathname).toBe('/create');
            allocations++;
            const body = await new Response(init?.body).json();
            const cloud = JSON.parse(body.userData.slice('#cloud-config\n'.length));
            hostPublicKey = cloud.ssh_keys.ed25519_public;
            bootstrapKey = cloud.users[0].ssh_authorized_keys[0];
            const { readManagedBootstrapCredential } = await import('@happier-dev/cli-common/machines/managed');
            const retained = readManagedBootstrapCredential(JSON.stringify({ v: 1, bootstrapPrivateKey: 'fixture-login', guestHostPrivateKey: cloud.ssh_keys.ed25519_private }));
            expect(retained.guestHostPublicKey).toBe(hostPublicKey);
            expect(bootstrapKey).toMatch(/^ssh-ed25519 /);
            expect(bootstrapKey).not.toBe(hostPublicKey);
            return Response.json({ id: 'guest-1' });
        });
        native.exec.mockImplementation(async (request: import('@happier-dev/ssh-native').NativeSshExecRequest) => {
            const { computeSshHostKeyFingerprint } = await import('@happier-dev/protocol/ssh/hostTrust');
            verifications.push(request.hostKeyVerification);
            if (scenario === 'retained') {
                expect(request.hostKeyVerification).toEqual({ decision: 'prompt' });
                expect(request.auth.privateKeyPem === retainedLoginKey).toBe(true);
                expect(native.hostKeyListeners.size).toBeGreaterThan(0);
                await new Promise<void>((resolve, reject) => {
                    const promptId = `${request.requestId}:unknown-host`;
                    native.hostKeyResponses.set(promptId, response => {
                        native.hostKeyResponses.delete(promptId);
                        if (response.decision === 'accept-once') resolve();
                        else reject(new Error('Retained host trust was refused'));
                    });
                    for (const listener of native.hostKeyListeners) listener({ requestId: request.requestId, promptId,
                        host: request.host, port: request.port, algorithm: 'ssh-ed25519',
                        fingerprintSha256: computeSshHostKeyFingerprint('AQIDBA=='), status: 'unknown' });
                });
            } else {
                const fingerprint = computeSshHostKeyFingerprint(hostPublicKey.split(' ')[1]!);
                // This models the native SSH engine's authenticated server-key boundary.
                if (request.hostKeyVerification.decision !== 'accept-once'
                    || request.hostKeyVerification.fingerprintSha256 !== fingerprint || scenario === 'substituted') {
                    throw Object.assign(new Error('host key mismatch'), { code: 'native_ssh_host_key_mismatch' });
                }
                expect(request.auth.privateKeyPem).toContain('PRIVATE KEY');
            }
            const command = request.command;
            let stdout = '';
            if (command.includes('uname -s') && command.includes('uname -m') && !command.includes('platform')) stdout = 'Linux\nx86_64\n/home/guest\n';
            else if (command.includes('uname -s')) stdout = JSON.stringify({ platform: 'linux', arch: 'x86_64' });
            else if (command.includes('current_target=') && command.includes('version_path')) stdout = 'current=\nprevious=\n';
            else if (command.includes('enroll-remote')) {
                stdout = `${JSON.stringify({ kind: 'remote_home_enrollment_pairing_request',
                    protocolVersion: 1, publicKey: encodeBase64(new Uint8Array(32).fill(1)), homeServerIdentityId: homeId,
                    pairing: { secretB64Url: encodeBase64(new Uint8Array(32).fill(23), 'base64url'), createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000 },
                    supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'guest-home' })}\n${JSON.stringify({
                    kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true, homeServerIdentityId: homeId,
                    machineId: 'joined', encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'guest-home' })}\n`;
                for (const listener of native.stdoutListeners) listener({ requestId: request.requestId, chunk: stdout });
            }
            else {
                // Native recipe labels use ordinary shell argv; the shared CLI
                // executor quotes each literal argument of the same OS command.
                const cliCommand = command.replaceAll("'", '');
                if (cliCommand.includes('service install')) serviceInstalled = true;
                if (cliCommand.includes('service start') || cliCommand.includes('daemon start')) running = true;
                const status = { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'joined',
                    services: [], service: { installed: serviceInstalled }, daemon: { running, healthy: running },
                    auth: { needsAuth: false, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'joined' },
                    server: { activeServerId: 'guest-home' } };
                stdout = JSON.stringify({ ...status, v: 1, ok: true, kind: 'auth_status', data: status });
            }
            return { exitCode: 0, stdout, stderr: '' };
        });
        const launch = { provider: { pluginId: PLUGIN_MANIFEST.id, localId: provisioner.id }, schemaVersion: 1, name: 'Guest',
            choices: { region: 'ams' },
            credentials: [] };
        const retention = { kind: 'until-delete' as const };
        const input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'one-off', homeId, launch, retention, wakeOnAcceptedMessage: false },
            enrollmentIdentity: { kind: 'existingUser', role: 'personal' }, reviewedFacts: { launch, provisioner, retention,
                retentionCapabilities: provisioner.retention, billing: provisioner.billing, optionStatus: 'current', prerequisites: [], wakeOnAcceptedMessage: false } });
        // Captured public release HTTP bytes keep signature verification and
        // guest installation real; no internal recipe or Action port is replaced.
        vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
            const address = new URL(String(url));
            if (address.origin === 'https://api.github.com') return Response.json({ assets: [
                `checksums-happier-v${signedRelease.version}.txt`,
                `checksums-happier-v${signedRelease.version}.txt.minisig`,
                `happier-v${signedRelease.version}-linux-x64.tar.gz`,
            ].map(name => ({ name, browser_download_url: `${signedRelease.source}${name}` })) });
            if (address.origin === 'https://github.com') {
                if (address.pathname.endsWith('.txt.minisig')) return new Response(signedRelease.signatureText);
                if (address.pathname.endsWith('.txt')) return new Response(signedRelease.checksumsText);
            }
            return homes.request(url, init);
        });
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            serverId, serverIdentityId: homeId, runtimeAccountId: accountId, actionRequestId: 'native-managed-create',
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
        let result;
        if (scenario === 'retained') {
            const { generateKeyPairSync } = await import('node:crypto');
            retainedLoginKey = generateKeyPairSync('rsa', { modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
            const { admitProfileAccount } = await import('@/sync/api/account/apiProfileCatalog');
            const { prepareSavedSecretResourceCreateInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
            const resourceId = await admitProfileAccount(account, async (captured, mode) => {
                const prepared = await prepareSavedSecretResourceCreateInContext(captured, mode, {
                    resourceId: 'retained-bootstrap-credential', displayName: 'Retained SSH login', kind: 'other', value: retainedLoginKey,
                    accountGrants: [], teamGrants: [], groupGrants: [],
                });
                try { return retainCredential(prepared.input); } finally { prepared.dispose(); }
            });
            managed = ManagedMachineV1Schema.parse({ id: 'managed-1', homeId, custodianAccountId: accountId,
                enrollmentAccountId: accountId, enrollmentIdentity: input.enrollmentIdentity,
                launch, retention, reviewedFacts: input.reviewedFacts, allocation: 'bound', creationState: 'active',
                desired: 'start', desiredWhen: 'now', intentRevision: 0, wakeOnAcceptedMessage: false,
                resource: { contributionRef: { pluginId: PLUGIN_MANIFEST.id, localId: provisioner.id }, schemaVersion: 1, value: { id: 'guest-1' } },
                bootstrapCredentialRef: { kind: 'shared_resource', resourceId },
            });
            const retry = { homeId, managedId: managed.id, expectedIntentRevision: 0 };
            result = await executor.execute('machines.managed.bootstrap.retry', retry,
                bindPresentUserActionConfirmation('machines.managed.bootstrap.retry', retry, context));
        } else {
            result = await executor.execute('machines.managed.acquire', input,
                bindPresentUserActionConfirmation('machines.managed.acquire', input, context));
        }
        if (scenario === 'browser') {
            expect(result).toMatchObject({ ok: false, errorCode: 'provider_unavailable' });
            expect({ admissions, allocations, approvals, machineRpcs }).toEqual({ admissions: 0, allocations: 0, approvals: 0, machineRpcs: 0 });
            expect(verifications).toEqual([]);
        } else if (scenario === 'substituted') {
            expect(allocations).toBe(1);
            expect(verifications.length).toBeGreaterThan(0);
            expect(result).toMatchObject({ ok: false, errorCode: 'native_ssh_host_key_mismatch' });
            expect({ approvals, running, machineRpcs }).toEqual({ approvals: 0, running: false, machineRpcs: 0 });
            expect(managed?.enrolledMachineId).toBeUndefined();
        } else {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { managedId: 'managed-1' } });
            const fresh = scenario === 'retained' ? 0 : 1;
            expect({ admissions, allocations, credentialCreations, approvals, machineRpcs, running }).toEqual({
                admissions: fresh, allocations: fresh, credentialCreations: fresh, approvals: 1, machineRpcs: 0, running: true });
            expect(managed?.enrolledMachineId).toBe('joined');
            expect(verifications.length).toBeGreaterThan(0);
            if (scenario === 'retained') expect(native.trustPrompts).toBeGreaterThan(0);
            else expect(native.trustPrompts).toBe(0);
            if (scenario === 'retained') {
                expect(hostPublicKey).toBe('');
                expect(bootstrapKey).toBe('');
                const retained = [...secretMaterials.values()];
                expect(retained).toHaveLength(1);
                expect(retained[0]?.storedContent.t === 'plain'
                    && retained[0].storedContent.v.value === retainedLoginKey).toBe(true);
            }
        }
        expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
    } finally { account.dispose(); }
});
