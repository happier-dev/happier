import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isManagedOpaquePresetReadV1, ManagedAcquireInputV1Schema, ManagedControlAdmissionInputV1Schema,
    ManagedControllerReportV1Schema, ManagedControllerResizeReportV1Schema,
    ManagedControllerIntentReportV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { RetentionCapabilitiesV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { ManagedConfigurationFactsV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import signedRelease from './managedMachineOrigination.signedRelease.fixture.json';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { allowRealServerSocketBoundary, configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { HomeGovernanceGetInputV1Schema } from '@happier-dev/protocol/home/governance/actionsV1';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import nacl from 'tweetnacl';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeRequestSchema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginError, isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { ManagedMachineCreationProgress } from '@/components/settings/machines/managed/managedMachineCreation';
import type { ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';

const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));
const native = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock('expo-constants', async original => {
    const module = await original<typeof import('expo-constants')>();
    return { ...module, default: { ...module.default,
        expoConfig: { ...module.default.expoConfig, extra: { app: { identityVariant: 'publicdev', variant: 'preview' } } },
    } };
});
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
// These import the same App/runtime graph. Preload them in dependency order
// after the external boundaries are installed, so fixture collection has one
// deterministic evaluation order.
const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/machine-vercel/src/manifest');
const { prepareAuthenticationInventory } = await import('@/dev/testkit/fixtures/connectedAccountAuthentication');
const { reconcileProjectedPluginUiClientExecutables } = await import('@/components/plugins/reactNative/clientExecutableActivation');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
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

function e2eeRecipient(accountId: string, contentPublicKey: Uint8Array) {
    return {
        account: { kind: 'account' as const, accountId, name: null, firstName: accountId, lastName: null, username: accountId, avatarUrl: null },
        readiness: { status: 'available' as const, contentPublicKey: encodeBase64(contentPublicKey, 'base64'),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentPublicKey) },
        envelopeStatus: 'missing' as const,
    };
}

export function registerManagedAccountHostTests(host: 'native' | 'browser') {
const cases: ReadonlyArray<[string, boolean, 'machines.managed.delete' | 'machines.managed.cancel' | null, boolean, boolean, boolean, boolean, ('bound' | 'unknown')?]> = host === 'native' ? [
    ['native', false, null, false, false, false, false],
    ['native refused roles seed', false, null, false, false, false, false],
    ['native E2EE one-off', false, null, false, false, false, false],
    ['native opaque E2EE preset', false, null, false, false, true, false],
    ['native Home payload one-off', false, null, false, false, false, false],
    ['native Home payload unknown source', false, null, false, false, false, false],
    ['native Home payload opaque preset', false, null, false, false, true, false],
    ['native opaque E2EE preset missing policy', false, null, false, false, true, false],
    ['native opaque Plain preset missing policy', false, null, false, false, true, false],
    ['native opaque Plain preset delegated policy', false, null, false, false, true, false],
    ['native opaque E2EE preset refuses keyless Account', false, null, false, false, true, true],
    ['native authored failure', false, null, false, false, false, false],
] : [
    ['browser', true, null, false, false, false, false],
    ['browser Home payload export', true, null, false, false, false, false],
    ['browser Home payload export opaque Plain preset', true, null, false, false, true, false],
    ['browser bootstrap failure recovery', true, null, false, false, false, false],
    ['browser bootstrap failure recovery Home payload export', true, null, false, false, false, false],
    ['browser bootstrap failure recovery Delete', true, 'machines.managed.delete', false, false, false, false],
    ['browser refused roles seed', true, null, false, false, false, false],
    ['browser delete', false, 'machines.managed.delete', false, false, false, false],
    ['browser cancel', false, 'machines.managed.cancel', false, false, false, false],
    ['browser absent cleanup', false, 'machines.managed.delete', true, false, false, false],
    ['browser stopped retained cancel', false, 'machines.managed.cancel', false, true, false, false],
    ['browser Home payload one-off', false, null, false, false, false, false],
    ['browser Home payload opaque preset', false, null, false, false, true, false],
    ['browser authored failure', false, null, false, false, false, false],
    ['browser retained acquisition Delete bound', false, 'machines.managed.delete', false, false, false, false, 'bound'],
    ['browser retained acquisition Delete unknown', false, 'machines.managed.delete', false, false, false, false, 'unknown'],
];
it.each(cases)('%s host carries the designed Create/Send review through the public Account path', async (label, startAgent, cleanupAction, alreadyAbsent, stoppedCleanup, opaquePreset, keylessE2ee, uncertainDelete) => {
    const homePayload = label.includes('Home payload');
    const exportedHomePayload = label.includes('Home payload export');
    const homePayloadArchive = { target: { os: 'linux' as const, arch: 'x64' as const },
        sha256: '4b'.repeat(32), url: '/v1/runtime/guest-cli/payloads/linux/x64' };
    const homeRetryArchive = { ...homePayloadArchive, sha256: '6d'.repeat(32),
        url: '/v1/runtime/guest-cli/payloads/retry/linux/x64' };
    const missingPolicy = label.includes('missing policy');
    const delegatedPolicy = label.includes('delegated policy');
    const refusedRoles = label.includes('refused roles seed');
    const plainPreset = label.includes('Plain preset');
    const brokerPreset = label === 'native opaque E2EE preset';
    const presetMode = plainPreset ? 'plain' as const : 'e2ee' as const;
    const e2eeAccount = opaquePreset && !plainPreset || label === 'native E2EE one-off';
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
    const e2eeCredentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }),
        secret: encodeBase64(new Uint8Array(32).fill(41), 'base64url') };
    const credentials = e2eeAccount && !keylessE2ee
        ? e2eeCredentials
        : { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    // A Home may retain E2EE content after a token-only Account loses its
    // content key. The fixture's writer key must not become that Account key.
    const encryption = e2eeAccount ? await createEncryptionFromAuthCredentials(e2eeCredentials) : null;
    const serverUrl = 'https://native-managed-account.test';
    const homeId = 'srv_native_managed_account';
    const serverId = await homes.addHome({ name: 'Native managed', serverUrl, accountId, credentials, serverIdentityId: homeId,
        accountEncryptionMode: e2eeAccount ? 'e2ee' : 'plain', credentialResourcesEnabled: true });
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
    // This HTTP fixture serves the captured signed stable release below, not
    // the source Home's development payload.
    homeFeatures.capabilities.guestCli = { source: homePayload ? 'home-payload' : 'public-release',
        line: signedRelease.version.split('.').slice(0, 2).join('.'), channel: 'stable',
        ...(exportedHomePayload ? { payloads: [homePayloadArchive] } : {}) };
    if (label.endsWith('unknown source')) homeFeatures.capabilities.guestCli = undefined;
    homes.answer(serverId, '/v1/features', { body: homeFeatures });
    homes.answer(serverId, '/v1/features/authenticated', { body: homeFeatures });
    // Match the connection's pushed public snapshot to this Home's HTTP identity.
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: homeFeatures } });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    const declaredProvisioner = PLUGIN_MANIFEST.contributes.machineProvisioners?.[0];
    if (!declaredProvisioner) throw new Error('Missing Vercel declaration');
    const provisioner = { ...declaredProvisioner,
        retention: RetentionCapabilitiesV1Schema.parse(declaredProvisioner.retention) };
    const selected = { service: { pluginId: PLUGIN_MANIFEST.id, localId: 'vercel-account' }, accountId: 'explicit-selected' };
    const secret = 'private-selected-vercel-token';
    let credential: unknown;
    let configuration: unknown;
    let managed: ReturnType<typeof ManagedMachineV1Schema.parse> | undefined;
    let admissions = 0;
    let admittedPresetPolicy: unknown;
    let allocations = 0;
    let authoredNativeFailure: PluginError | undefined;
    let machineRpcs = 0;
    let approvals = 0;
    let joinAttempts = 0;
    let guestDispatches = 0;
    let roleDispatches = 0;
    let guestContinuation: unknown;
    let acquireDigest = '';
    let interruptJoin = !startAgent;
    let interruptBootstrap = label.startsWith('browser bootstrap failure recovery');
    let vendorAbsent = false;
    let vendorStopped = false;
    let deletes = 0;
    let stops = 0;
    let readCreationStage: ((stage: 'installing' | 'joining') => Promise<void>) | undefined;
    let admittedPresetContent: Readonly<{ content: unknown; recipients: readonly unknown[] }> | undefined;
    let sourcePresetContent: typeof admittedPresetContent;
    let presetReadProjection: unknown;
    let presetContentOverride: unknown;
    const homePaths: string[] = [];
    const homeBodies: string[] = [];
    const launch = { provider: { pluginId: PLUGIN_MANIFEST.id, localId: provisioner.id }, schemaVersion: 1, name: 'Guest',
        choices: { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 2, timeoutMs: 300000, snapshotExpirationMs: 0 },
        credentials: [{ purpose: { consumer: { pluginId: PLUGIN_MANIFEST.id, localId: provisioner.id }, purpose: 'cloud-api' },
            account: selected }] };
    const retention = { kind: 'until-delete' as const };
    const enrollmentIdentity = { kind: 'guestProcess' as const, role: 'sandbox' as const };
    const reviewedFacts = ManagedConfigurationFactsV1Schema.parse({ launch, provisioner, retention, retentionCapabilities: provisioner.retention,
        billing: provisioner.billing, optionStatus: 'current', prerequisites: [], wakeOnAcceptedMessage: false });
    const privatePresetName = 'Private opaque preset';
    const privateLaunchName = 'Private opaque base launch';
    const privateOverrideName = 'Private opaque machine name';
    let input: ReturnType<typeof ManagedAcquireInputV1Schema.parse>;
    const createOpaquePresetInput = async () => {
        if (!encryption && !plainPreset) throw new Error('Missing E2EE preset writer encryption');
        const { createManagedMachinePresetAcquireOverrideV1, projectManagedMachinePresetForRecipientV1,
            sealManagedMachinePresetContentV1 } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
        const privateLaunch = { ...launch, name: privateLaunchName };
        const sealContent = { presetId: 'opaque-preset',
            content: { v: 1 as const, name: privatePresetName, launch: privateLaunch,
                ...(brokerPreset ? { credentialBroker: true } : {}) },
            randomBytes: (length: number) => new Uint8Array(length).fill(7) };
        const sealed = encryption ? sealManagedMachinePresetContentV1({ ...sealContent, mode: 'e2ee',
            recipientCensus: [e2eeRecipient(accountId, encryption.contentDataKey)] })
            : sealManagedMachinePresetContentV1({ ...sealContent, mode: 'plain' });
        admittedPresetContent = { content: sealed.content, recipients: sealed.recipients };
        sourcePresetContent = admittedPresetContent;
        presetReadProjection = projectManagedMachinePresetForRecipientV1({ content: sealed.content, recipients: sealed.recipients,
            recipientAccountId: accountId });
        const overrideContent = { presetId: 'opaque-preset', projection: presetReadProjection,
            launchName: privateOverrideName, enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const } };
        const override = encryption ? createManagedMachinePresetAcquireOverrideV1({ ...overrideContent,
            mode: 'e2ee', accountId, accountKey: encryption.getContentPrivateKey(),
            randomBytes: length => new Uint8Array(length).fill(11) })
            : createManagedMachinePresetAcquireOverrideV1({ ...overrideContent, mode: 'plain' });
        if (!override) throw new Error('Expected a same-DEK private acquire override');
        presetContentOverride = override;
        return ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId, id: 'opaque-preset', revision: 1 },
            ...(startAgent ? { agentStart: { directory: { kind: 'managed' }, agentTarget: {
                kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            } } } : {}),
            ...(missingPolicy ? {} : { retention, wakeOnAcceptedMessage: false }), presetContentOverride: override });
    };
    // The guest's published mode and Action envelopes must match this Account.
    // Keep the real encrypted codec at the captured guest HTTP boundary.
    const guestRoles = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: homeId,
        accountId, machineId: 'joined', actionId: 'machines.roles.set', tokenEpoch: 0,
        ...(encryption ? { encryption } : {}), requesterInvocation: 'optional',
        execute: input => {
            roleDispatches++;
            expect(input).toMatchObject({ machineId: 'joined', policy: { active: ['sessions'] } });
            return { status: 'applied', policy: { active: ['sessions'] }, metadataVersion: 1 };
        } });
    const guest = guestRoles.machine;
    const installationPublicKey = encodeBase64(nacl.sign.keyPair.fromSecretKey(guestRoles.installationPrivateKey).publicKey, 'base64url');
    const guestSessions = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: homeId,
        accountId, machineId: guest.id,
        actionId: 'session.spawn_new', tokenEpoch: 0,
        ...(encryption ? { encryption } : {}), requesterInvocation: 'optional',
        execute: () => {
            guestDispatches++;
            return SessionSpawnNewActionResultV1Schema.parse({ type: 'success', disposition: 'created', sessionId: 'managed-session',
                executionTarget: { serverId: homeId, machineId: guest.id }, organizationPlacement: { sectionId: null, tagIds: [] },
                initialInput: { status: 'notRequested' } });
        } });
    const guestAccess = MachineAccessGrantsListResponseV1Schema.parse({ machineId: guest.id,
        custodian: { accountId, displayName: 'Test Account' }, access: guest.access,
        canManage: true, grants: [], ownDirectGrant: true, ownAccessSources: [],
    });
    let receiver: Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>> | undefined;
    let receiverProjection: ReturnType<typeof buildDeferredDaemonProjectionSections> | undefined;
    const homeBoundaryFailures: unknown[] = [];
    let releaseRequests = 0;
    const releaseResponse = (address: URL) => {
        releaseRequests++;
        if (address.pathname === '/repos/happier-dev/happier/releases') {
            return Response.json([{ tag_name: `cli-v${signedRelease.version}`, draft: false, prerelease: false }]);
        }
        if (address.pathname !== `/repos/happier-dev/happier/releases/tags/cli-v${signedRelease.version}`)
            homeBoundaryFailures.push({ releasePath: address.pathname });
        expect(address.pathname).toBe(`/repos/happier-dev/happier/releases/tags/cli-v${signedRelease.version}`);
        return Response.json({ assets: [
            `checksums-happier-v${signedRelease.version}.txt`,
            `checksums-happier-v${signedRelease.version}.txt.minisig`,
            `happier-v${signedRelease.version}-linux-x64.tar.gz`,
        ].map(name => ({ name, browser_download_url: `${signedRelease.source}${name}` })) });
    };
    const request: typeof fetch = async (url, init) => {
        const address = new URL(String(url));
        if (address.origin === 'https://api.github.com') return releaseResponse(address);
        if (address.origin === 'https://api.vercel.com') return native.fetch(url, init);
        if (address.pathname === '/v1/machines/read-batch') {
            const receivingMachine = receiver?.machine;
            return createMachineReadBatchResponseFixture(init?.body,
                id => id === 'joined' ? guest : receivingMachine && id === receivingMachine.id ? receivingMachine : null);
        }
        const response = await receiver?.handle(address, init);
        if (response) return response;
        try { return await requestHome(url, init); }
        catch (error) { homeBoundaryFailures.push(error); throw error; }
    };
    connection = await restoreServerAccountForTest({ serverUrl, accountId, credentials,
        additionalRequestOrigins: ['https://api.vercel.com', 'https://api.github.com'],
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'timeout').mockReturnValue(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: unknown) => {
                if (event === 'rpc-call' && receiver && receiverProjection) {
                    if (!payload || typeof payload !== 'object' || !('method' in payload)
                        || typeof payload.method !== 'string' || !('params' in payload)
                        || payload.method !== `${receiver.machine.id}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`) {
                        throw new Error('Unexpected receiver RPC');
                    }
                    const content = { mode: 'plain' as const };
                    const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
                    const input = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(decoded.params);
                    const read = 'sectionRead' in input ? input.sectionRead : undefined;
                    const result = read ? receiverProjection.read(read.digest, read.offset, read.includeDigests)
                        : receiverProjection.manifest;
                    return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
                }
                if (event.includes('rpc')) { machineRpcs++; throw new Error('Unexpected Machine operation RPC'); }
                return { ok: true };
            });
        },
        request });
    async function requestHome(url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
            const address = new URL(String(url));
            const path = address.pathname;
            homePaths.push(path);
            if (typeof init?.body === 'string') homeBodies.push(init.body);
            if (path === '/v1/home/governance/get') {
                expect(HomeGovernanceGetInputV1Schema.parse(await new Response(init?.body).json()))
                    .toEqual({ projection: 'session_defaults' });
                return Response.json(HomeSessionDefaultsProjectionV1Schema.parse({ homeDefaults: null }));
            }
            if (path === '/v1/machines/presets/get') {
                if (!sourcePresetContent) throw new Error('Missing exact preset content');
                return Response.json({ kind: 'found', preset: {
                    id: 'opaque-preset', homeId, revision: 1, owner: { kind: 'account', accountId },
                    contentEncryptionMode: presetMode, ...sourcePresetContent,
                    ...(missingPolicy || delegatedPolicy ? {} : { retention, wakeOnAcceptedMessage: false }),
                } });
            }
            if (path === '/v1/machines/managed/actions/get') {
                const { projectManagedMachinePresetForRecipientV1 } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
                return Response.json(opaquePreset && admittedPresetContent
                    ? { machine: managed, presetContent: projectManagedMachinePresetForRecipientV1({
                        ...admittedPresetContent, recipientAccountId: accountId }) }
                    : managed);
            }
            if (path === '/v1/machines/managed/actions/list') return Response.json({ machines: managed ? [managed] : [] });
            if (path === '/v1/machines/managed/actions/cancel') {
                managed = ManagedMachineV1Schema.parse({ ...managed, creationState: 'canceled', desired: 'delete',
                    intentRevision: managed!.intentRevision + 1, cleanup: { disposition: 'pending', reason: 'creation_canceled' } });
                return Response.json({ machine: managed });
            }
            if (path.endsWith('/controller/admit-control')) {
                const body = await new Response(init?.body).json();
                if (opaquePreset && body.action === 'machines.managed.resize') {
                    const admitted = ManagedControlAdmissionInputV1Schema.parse(body);
                    expect(admitted).toMatchObject({ action: 'machines.managed.resize', input: {
                        homeId, managedId: managed!.id, presetContentOverride: expect.any(Object),
                    } });
                    expect('size' in admitted.input).toBe(false);
                    if (!admittedPresetContent) throw new Error('Missing persisted opaque preset content');
                    return Response.json({ machine: managed, presetContent: admittedPresetContent,
                        resizeProvisioner: provisioner, replayed: false });
                }
                if (opaquePreset && body.action === 'machines.managed.power.set') {
                    const admitted = ManagedControlAdmissionInputV1Schema.parse(body);
                    if (admitted.action !== 'machines.managed.power.set') throw new Error('Expected power admission');
                    managed = ManagedMachineV1Schema.parse({ ...managed, desired: admitted.input.intent,
                        intentRevision: managed!.intentRevision + 1 });
                    return Response.json({ machine: managed, presetContent: admittedPresetContent, replayed: false });
                }
                expect(body).toMatchObject({ action: 'machines.managed.delete', input: { when: 'now', expectedRevision: managed!.intentRevision } });
                managed = ManagedMachineV1Schema.parse({ ...managed, desired: 'delete', intentRevision: managed!.intentRevision + 1,
                    cleanup: { disposition: 'pending', reason: 'delete_requested' } });
                return Response.json({ machine: managed, ...(opaquePreset ? { presetContent: admittedPresetContent } : {}), replayed: false });
            }
            if (path.endsWith('/controller/submit-intent')) {
                const body = await new Response(init?.body).json();
                if (managed?.submittedNativeEffect) return Response.json({ submitted: false, machine: managed });
                managed = ManagedMachineV1Schema.parse({ ...managed, submittedNativeEffect: {
                    requestId: body.requestId, intentRevision: body.expectedIntentRevision, intent: managed!.desired } });
                return Response.json({ submitted: true, machine: managed });
            }
            if (path.endsWith('/controller/report-intent')) {
                const body = await new Response(init?.body).json();
                if (opaquePreset) {
                    const report = ManagedControllerIntentReportV1Schema.parse(body);
                    if (!('presetContent' in report) || !admittedPresetContent) throw new Error('Expected sealed native control report');
                    expect(report.presetContent.t).toBe(plainPreset ? 'plain' : 'encrypted');
                    expect(report.result).toEqual({ kind: report.result.kind });
                    if (!plainPreset) expect(JSON.stringify(report)).not.toContain(privateOverrideName);
                    expect(JSON.stringify(report)).not.toContain(secret);
                    admittedPresetContent = { ...admittedPresetContent, content: report.presetContent };
                }
                if (stoppedCleanup) {
                    expect(body).toMatchObject({ requestId: 'prior-delete', expectedIntentRevision: 2 });
                    expect(managed?.intentRevision).toBe(4);
                }
                managed = ManagedMachineV1Schema.parse({ ...managed,
                    ...(body.result.kind === 'accepted' ? { nativeOperationRef: body.result.nativeOperationRef } : {}),
                    ...(body.observation ? { observation: body.observation } : {}),
                    ...(opaquePreset && body.result.kind === 'confirmed' ? { submittedNativeEffect: undefined } : {}),
                    ...(body.observation?.availability === 'absent' ? { allocation: 'confirmed-absent', cleanup: undefined,
                        submittedNativeEffect: undefined, nativeOperationRef: undefined } : {}) });
                return Response.json({ machine: managed });
            }
            if (path === '/v1/machines/joined') return Response.json({ machine: guest });
            if (path === '/v1/machines/joined/access') return Response.json(guestAccess);
            if (path === '/v1/actions/session.spawn_new/execution-authorization'
                || path === '/v1/actions/machines.roles.set/execution-authorization') {
                const actionId = path === '/v1/actions/machines.roles.set/execution-authorization' ? 'machines.roles.set' : 'session.spawn_new';
                const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(await new Response(init?.body).json());
                guestContinuation = body.managedContinuation;
                if (refusedRoles && actionId === 'machines.roles.set') {
                    return Response.json({ code: 'permission_denied' }, { status: 403 });
                }
                return Response.json({ v: 1, token: 'guest-creation-proof', binding: {
                    serverIdentityId: homeId, accountId, authentication: { kind: 'account', tokenEpoch: 0 },
                    actionId, requestId: body.envelope.requestId, target: { kind: 'machine', machineId: 'joined' },
                    machineId: 'joined', installationId: guest.installationId, custodianAccountId: accountId,
                    accountEncryptionMode: encryption ? 'e2ee' : 'plain',
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
                    managedContinuation: { ...body.managedContinuation, acquireRequestEnvelopeDigest: acquireDigest },
                } });
            }
            if (path === '/v1/actions/machines.roles.set' || path === '/v1/actions/session.spawn_new') {
                const boundary = path === '/v1/actions/machines.roles.set' ? guestRoles : guestSessions;
                const response = await boundary.handle(new URL(String(url)), init);
                if (!response) throw new Error('Missing guest Action HTTP boundary');
                return response;
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
                admittedPresetPolicy = body.presetPolicy;
                const admittedGuestCli = homeFeatures.capabilities.guestCli;
                if (exportedHomePayload) {
                    expect(body).not.toHaveProperty('guestCli');
                    expect(body.input).not.toHaveProperty('guestCli');
                    // Publishing a newer build after this admission must not
                    // change the archive this already accepted guest installs.
                    homeFeatures.capabilities.guestCli = { ...homeFeatures.capabilities.guestCli!, payloads: [
                        { ...homePayloadArchive, sha256: '5c'.repeat(32), url: '/v1/runtime/guest-cli/payloads/newer/linux/x64' },
                    ] };
                }
                if (delegatedPolicy) {
                    const { resolveMachineRetentionPolicyV1 } = await import('@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1');
                    const expected = resolveMachineRetentionPolicyV1({ billing: provisioner.billing, nativeCapabilities: provisioner.retention });
                    expect(body.presetPolicy).toEqual({ retention: expected.retention, wakeOnAcceptedMessage: expected.wakeOnAcceptedMessage });
                    expect(body.input).toEqual(input);
                    return Response.json({ code: 'permission_denied' }, { status: 403 });
                }
                if (missingPolicy && managed) {
                    return Response.json({ machine: managed, presetContent: admittedPresetContent,
                        ...(presetContentOverride === undefined ? {} : { presetContentOverride }), replayed: true });
                }
                acquireDigest = body.requestEnvelopeDigest;
                if (opaquePreset) {
                    const acquire = ManagedAcquireInputV1Schema.parse(body.input);
                    if (acquire.selection.kind !== 'preset' || !admittedPresetContent || presetContentOverride === undefined) {
                        throw new Error('Expected exact opaque preset admission');
                    }
                    const { resolveMachineRetentionPolicyV1 } = await import('@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1');
                    const explicitPolicy = 'retention' in acquire
                        ? { retention: acquire.retention, wakeOnAcceptedMessage: acquire.wakeOnAcceptedMessage } : undefined;
                    const expectedPolicy = explicitPolicy ?? resolveMachineRetentionPolicyV1({
                        billing: provisioner.billing, nativeCapabilities: provisioner.retention,
                    });
                    if (missingPolicy) {
                        expect(explicitPolicy).toBeUndefined();
                        expect(body.presetPolicy).toEqual({ retention: expectedPolicy.retention,
                            wakeOnAcceptedMessage: expectedPolicy.wakeOnAcceptedMessage });
                        expect(computeExternalActionRequestEnvelopeDigestV1(body.originalActionEnvelope)).toBe(body.requestEnvelopeDigest);
                        expect(body.originalActionEnvelope.input).toEqual(acquire);
                    } else {
                        expect(explicitPolicy).toBeDefined();
                    }
                    managed = ManagedMachineV1Schema.parse({ id: 'managed-1', homeId, custodianAccountId: accountId,
                        enrollmentAccountId: accountId,
                        ...(admittedGuestCli === undefined ? {} : { guestCli: admittedGuestCli }),
                        preset: { id: acquire.selection.id, revision: acquire.selection.revision, contentEncryptionMode: presetMode },
                        retention: expectedPolicy.retention, wakeOnAcceptedMessage: expectedPolicy.wakeOnAcceptedMessage,
                        allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0 });
                    return Response.json({ machine: managed, presetContent: admittedPresetContent, presetContentOverride, replayed: false });
                }
                managed = ManagedMachineV1Schema.parse({ id: 'managed-1', homeId, custodianAccountId: accountId,
                    enrollmentAccountId: accountId, enrollmentIdentity: body.input.enrollmentIdentity,
                    ...(admittedGuestCli === undefined ? {} : { guestCli: admittedGuestCli }),
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
                if (opaquePreset) {
                    // The Account keyholder must reseal full native facts into the
                    // admitted carrier before they cross the Home boundary.
                    const report = ManagedControllerReportV1Schema.parse(body);
                    if (!('presetContent' in report)) throw new Error('Expected opaque preset report');
                    expect(report.result).toEqual({ kind: body.result.kind });
                    if (!plainPreset) expect(JSON.stringify(report)).not.toContain(privatePresetName);
                    if (!plainPreset) expect(JSON.stringify(report)).not.toContain(privateLaunchName);
                    if (!plainPreset) expect(JSON.stringify(report)).not.toContain(privateOverrideName);
                    expect(JSON.stringify(report)).not.toContain(secret);
                    if (!admittedPresetContent) throw new Error('Missing opaque preset admission carrier');
                    admittedPresetContent = { content: report.presetContent, recipients: admittedPresetContent.recipients };
                    presetContentOverride = undefined;
                    managed = ManagedMachineV1Schema.parse({ ...managed,
                        ...(report.result.kind === 'bound' ? { allocation: 'bound' as const } : {}),
                        ...(report.bootstrapInstalled ? { bootstrapInstalled: true } : {}),
                        ...(report.observation ? { observation: report.observation } : {}),
                    });
                    return Response.json({ machine: managed });
                }
                if (body.result.kind === 'bound') managed = ManagedMachineV1Schema.parse({ ...managed, allocation: 'bound', resource: body.result.resource,
                    ...(managed?.allocation === 'may-exist' && managed.submittedNativeEffect?.intent !== 'delete' ? { nativeOperationRef: undefined } : {}),
                    ...(body.bootstrapInstalled ? { bootstrapInstalled: true } : {}) });
                if (body.result.kind === 'pending') managed = ManagedMachineV1Schema.parse({ ...managed, nativeOperationRef: body.result.nativeOperationRef });
                if (body.result.kind === 'unknown') managed = ManagedMachineV1Schema.parse({ ...managed, recovery: body.result.recovery });
                if (body.observation) managed = ManagedMachineV1Schema.parse({ ...managed, observation: body.observation });
                return Response.json({ machine: managed });
            }
            if (path.endsWith('/controller/report-resize')) {
                const body = await new Response(init?.body).json();
                if (!opaquePreset) throw new Error('Only the opaque resize test reaches this endpoint');
                const report = ManagedControllerResizeReportV1Schema.parse(body);
                if (!('presetContent' in report)) throw new Error('Expected opaque preset resize report');
                expect(report.result).toEqual({ kind: body.result.kind });
                if (!plainPreset) expect(JSON.stringify(report)).not.toContain(privatePresetName);
                if (!plainPreset) expect(JSON.stringify(report)).not.toContain(privateLaunchName);
                if (!plainPreset) expect(JSON.stringify(report)).not.toContain(privateOverrideName);
                expect(JSON.stringify(report)).not.toContain(secret);
                expect(JSON.stringify(report)).not.toContain('memoryBytes');
                if (!admittedPresetContent) throw new Error('Missing opaque resize carrier');
                admittedPresetContent = { content: report.presetContent, recipients: admittedPresetContent.recipients };
                return Response.json({ machine: managed });
            }
            if (path.endsWith('/controller/current') || path.endsWith('/controller/enrollment-context')) return Response.json({ machine: managed });
            if (path.endsWith('/controller/context')) return Response.json({ machine: managed,
                ...(exportedHomePayload ? { guestCli: { ...homeFeatures.capabilities.guestCli!, payloads: [homeRetryArchive] } } : {}),
                ...(opaquePreset && admittedPresetContent ? { presetContent: admittedPresetContent,
                    ...(presetContentOverride === undefined ? {} : { presetContentOverride }) } : {}),
                requestId: 'native-managed-create', enrollmentInstallation: { machineId: 'joined', installationId: guest.installationId, installationPublicKey } });
            if (path === '/v1/auth/response') {
                approvals++;
                managed = ManagedMachineV1Schema.parse({ ...managed, enrolledMachineId: 'joined' });
                return Response.json({ success: true });
            }
            if (path === '/v1/auth/request/status') return Response.json({ status: 'pending', supportsV2: true });
            return homes.request(url, init);
    }
    const account = await captureLazyActionAccountContext(serverId);
    try {
        expect(account.serverIdentityId).toBe(homeId);
        expect(await (await import('@/utils/system/runtimeFetch')).readRuntimeFetchHost(account.endpointUrl)).toBe(host);
        if (keylessE2ee) {
            input = await createOpaquePresetInput();
            const context = bindPresentUserActionConfirmation('machines.managed.acquire', input, { surface: 'ui', authority: 'present_user',
                serverId, serverIdentityId: homeId, runtimeAccountId: accountId, actionRequestId: 'native-managed-create',
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) });
            const { executeManagedMachineNativeAction } = await import('./managedMachineOrigination');
            const refused = await executeManagedMachineNativeAction({ account, actionId: 'machines.managed.acquire', input, context,
                signal: new AbortController().signal });
            expect(refused).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            expect({ admissions, allocations, machineRpcs }).toEqual({ admissions: 1, allocations: 0, machineRpcs: 0 });
            expect(homePaths.filter(path => path.includes('/machines/presets/') || path.includes('/machines/pools/')))
                .toEqual(['/v1/machines/presets/get']);
            const wire = homeBodies.join('\n');
            expect(wire).not.toContain(privatePresetName);
            expect(wire).not.toContain(privateLaunchName);
            expect(wire).not.toContain(privateOverrideName);
            expect(wire).not.toContain(secret);
            return;
        }
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
        if (delegatedPolicy) {
            input = await createOpaquePresetInput();
            const requestId = 'delegated-native-policy';
            const target = { kind: 'machine' as const, machineId: 'delegated-controller' };
            const originalActionEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target, input });
            const { ExternalActionExecutionAuthorizationV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-delegation', binding: {
                serverIdentityId: homeId, accountId: 'delegated-member', custodianAccountId: accountId,
                authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
                actionId: 'machines.managed.acquire', requestId, target, machineId: target.machineId,
                installationId: 'delegated-installation', managedAcquireDelegation: true,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope),
            } });
            const context = bindPresentUserActionConfirmation('machines.managed.acquire', input, { surface: 'ui', authority: 'present_user',
                serverId, serverIdentityId: homeId, runtimeAccountId: accountId, actionRequestId: requestId,
                externalActionExecutionAuthorization: authorization, originalActionEnvelope,
                actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) });
            const { executeManagedMachineNativeAction } = await import('./managedMachineOrigination');
            const refused = await executeManagedMachineNativeAction({ account, actionId: 'machines.managed.acquire', input, context,
                signal: new AbortController().signal });
            expect(refused).toMatchObject({ ok: false, errorCode: 'permission_denied' });
            expect({ admissions, allocations, machineRpcs }).toEqual({ admissions: 1, allocations: 0, machineRpcs: 0 });
            expect(homePaths.filter(path => path.includes('/machines/presets/'))).toEqual(['/v1/machines/presets/get']);
            return;
        }
        if (host === 'browser') {
            const [{ default: Fastify }, { enableExternalActionHttpBody }, { installAxiosFastifyAdapter },
                { createRequesterCurrentnessSocketHarness }, { executeExternalAction },
                { prepareRequesterAccountActionContext }, { createCliActionExecutorFromCredentials },
                { normalizeActionsSettingsV1 }] = await Promise.all([
                import('fastify'),
                import('../../../../../server/sources/app/api/utils/externalActionHttpBody'),
                import('../../../../../cli/src/testkit/http/axiosAdapter'),
                import('../../../../../cli/src/testkit/backends/requesterCurrentnessSocketHarness'),
                import('../../../../../cli/src/daemon/externalActions/executeExternalAction'),
                import('../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection'),
                import('../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials'),
                import('@happier-dev/protocol/actions/actionSettings'),
            ]);
            // The receiver reads the same Home over its genuine HTTP and update
            // boundaries. Requester admission and the bundled CLI Account runtime
            // run below those boundaries, including private requester-box custody.
            const { verifyExternalActionExecutionAuthorizationCurrent } =
                await import('../../../../../cli/src/api/externalActionExecutionAuthorization');
            const updates = await createRequesterCurrentnessSocketHarness();
            const allowUpdates = allowRealServerSocketBoundary(updates.serverUrl);
            onTestFinished(async () => {
                try { await updates.close(); } finally { allowUpdates.dispose(); }
            });
            const app = Fastify().withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();
            onTestFinished(() => app.close());
            enableExternalActionHttpBody(app);
            const { registerAuthoredAccountActionRelease } = await import('../../../../../cli/src/plugins/runtime/accountPluginActions.testkit');
            const { resolve: resolveSourcePath } = await import('node:path');
            const accountProjectRoot = resolveSourcePath(import.meta.dirname, '../../../../../../packages/plugins/machine-vercel');
            // Compile and serve the same real Account executable through the
            // canonical release/artifact HTTP boundary used by CLI host tests.
            await registerAuthoredAccountActionRelease(app, accountId, { primary: {
                manifest: PLUGIN_MANIFEST, projectRoot: accountProjectRoot,
                entryPath: resolveSourcePath(accountProjectRoot, 'src/manifest.ts'),
                activateExport: 'activateAccount', manifestExport: null,
            } });
            app.route({ method: ['GET', 'POST'], url: '/*', handler: async (incoming, reply) => {
                const headers = Object.fromEntries(Object.entries(incoming.headers)
                    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
                const response = await request(`${serverUrl}${incoming.url}`, { method: incoming.method, headers,
                    ...(incoming.body === undefined ? {} : { body: JSON.stringify(incoming.body) }) });
                reply.code(response.status);
                response.headers.forEach((value, key) => reply.header(key, value));
                return reply.send(await response.text());
            } });
            const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
            onTestFinished(restoreHttp);
            type Admitted = Parameters<Parameters<typeof prepareRequesterAccountActionContext>[0]['createExecutor']>[0];
            const { resolveAccountExecutionRuntime } = await import('../../../../../cli/src/plugins/runtime/accountExecutionRuntime');
            const { listRuntimeContributedActionDefinitions } = await import('../../../../../cli/src/plugins/runtime/invocation/actions/createCommittedContributedActionDeps');
            const catalogRuntime = await resolveAccountExecutionRuntime({ accountExecution: {
                credentials: { ...credentials, encryption: null }, serverId, serverUrl, isCurrent: () => lifetime.isCurrent(),
            } });
            onTestFinished(() => catalogRuntime.registry.dispose());
            const executor = (admitted?: Admitted) => {
                const installationId = receiver?.machine.installationId;
                return createCliActionExecutorFromCredentials({
                credentials: admitted?.credentials ?? { ...credentials, encryption: null, credentialProvenance: 'stored_session' },
                machineId: 'account-receiver', serverId, serverApiUrl: serverUrl, serverIdentityId: homeId,
                pluginActionExecutionOwner: 'current_process',
                listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(catalogRuntime.registry, selection),
                ...(admitted ? { savedSecretOperationContext: admitted.savedSecretOperationContext,
                    accountPluginActions: true as const } : {}),
                ...(receiver && installationId ? { externalActionMachineRequestPrivateKey: receiver.installationPrivateKey,
                    externalActionMachineInstallationId: installationId } : {}),
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(
                    admitted?.accountSettingsContext.settings.actionsSettingsV1),
                    getAccountSettings: () => admitted?.accountSettingsContext.settings ?? null },
            }); };
            receiver = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: homeId, accountId,
                machineId: 'account-receiver', actionId: 'action.invoke', tokenEpoch: 0,
                failure: result => {
                    const failure = ActionExecuteFailureSchema.safeParse(result);
                    return failure.success ? failure.data : null;
                },
                execute: async (_input, context) => {
                    if (!receiver) throw new Error('Receiver installation unavailable');
                    const machineId = receiver.machine.id;
                    const installationId = receiver.machine.installationId;
                    if (!installationId) throw new Error('Receiver installation unavailable');
                    const privateKey = receiver.installationPrivateKey;
                    const result = await executeExternalAction({ actionId: 'action.invoke', envelope: context.envelope,
                        principal: { accountId, authentication: { kind: 'account', tokenEpoch: 0 }, authority: 'present_user' },
                        currentMachineId: machineId, currentInstallationId: installationId,
                        currentAccountId: accountId, currentServerId: serverId, currentServerHttpBaseUrl: serverUrl,
                        externalActionMachineRequestPrivateKey: privateKey, executionAuthorization: context.authorization,
                        ...(context.signal ? { signal: context.signal } : {}),
                        verifyExecutionAuthorization: async input => await verifyExternalActionExecutionAuthorizationCurrent({
                            ...input, privateKey, installationId, serverHttpBaseUrl: serverUrl,
                        }),
                        resolveTarget: async ({ target }) => target ?? null, executor: executor(),
                        prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({
                            authorization: input.authorization, purpose: { kind: 'external_action' },
                            machineId, installationId, installationPrivateKey: privateKey,
                            serverId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
                            isCurrent: async () => lifetime.isCurrent(), createExecutor: executor,
                            ...(input.signal ? { signal: input.signal } : {}),
                        }),
                    });
                    if (result.kind !== 'response' || !('execution' in result.response)) throw new Error(JSON.stringify(result));
                    return result.response.execution.ok ? result.response.execution.result : result.response.execution;
                } });
            const [{ normalizePluginManifestV2 }, { projectLoadedPluginContributes },
                { createResolvedContributionRegistry }, { buildPluginProjectionV2 },
                { createPluginRuntimeOccurrenceId }, { resolve }] = await Promise.all([
                import('../../../../../cli/src/plugins/manifest/normalize'),
                import('../../../../../cli/src/plugins/projection/registry/fullProjection'),
                import('../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry'),
                import('../../../../../cli/src/plugins/projection/registry/projection/v2'),
                import('../../../../../cli/src/plugins/runtime/runtimeSlots'),
                import('node:path'),
            ]);
            // A receiver publishes the CLI projection, before the UI adds its
            // Account placement facts. Derive it from the actual plugin manifest.
            const manifest = normalizePluginManifestV2(PLUGIN_MANIFEST);
            const pluginRootPath = resolve(import.meta.dirname, '../../../../../../packages/plugins/machine-vercel');
            const daemonEntry = manifest.entrypoints?.daemon;
            if (!daemonEntry) throw new Error('Missing plugin daemon entry');
            const registry = createResolvedContributionRegistry({ ...projectLoadedPluginContributes({
                loadResult: { loadedPlugins: [{ pluginId: manifest.id, pluginRootPath,
                    manifestPath: resolve(pluginRootPath, 'plugin.json'),
                    daemonEntryPath: resolve(pluginRootPath, daemonEntry), devDaemonEntryPath: null,
                    sourceSpec: { kind: 'package', locator: '@happier-dev/plugins-machine-vercel',
                        trustPolicy: 'local_trusted', installPolicy: 'copy' },
                    manifest }], diagnosticsByPluginId: {} },
                provenance: 'first_party',
            }), occurrenceIdsByPluginId: { [manifest.id]: createPluginRuntimeOccurrenceId(manifest.id) } });
            receiverProjection = buildDeferredDaemonProjectionSections({ protocolVersion: 1,
                projectionDigest: 'a'.repeat(64),
                projection: PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: 1 })) });
            // Browser-reachable retained cleanup needs no online Machine.
            await publishMachineInventoryForTest(lifetime.scope, uncertainDelete ? [] : [createHydratedPlainMachineFixture({
                id: receiver.machine.id, accountId, machine: { activeAt: Date.now(), access: receiver.machine.access,
                    installationId: receiver.machine.installationId } })]);
        }
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
        let enrollmentRoles: unknown;
        const session = { id: 'sbx_one', sourceSandboxName: 'happier-managed-1', projectId: 'prj_one', createdAt: 919,
            networkPolicy: { mode: 'allow-all' } };
        const snapshot = { id: 'snap_one', sourceSessionId: session.id, projectId: 'prj_one', createdAt: 1100, status: 'created' };
        const named = () => ({ sandbox: { name: 'happier-managed-1', createdAt: 1000, currentSessionId: session.id,
            ...(vendorStopped ? { currentSnapshotId: snapshot.id } : {}),
            persistent: true, status: vendorStopped ? 'stopped' : 'running', tags: { 'happier-managed-id': 'managed-1' },
            expiresAt: Date.now() + 300000, networkPolicy: { mode: 'allow-all' } }, session });
        native.fetch.mockImplementation(async (url, init) => {
            const address = new URL(String(url));
            if (address.origin === 'https://api.github.com') return releaseResponse(address);
            const path = address.pathname;
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`);
            if (path === '/v9/projects/prj_one') return Response.json({ id: 'prj_one' });
            if (path === '/v2/teams/team_one') return Response.json({ id: 'team_one', billing: { plan: 'pro' } });
            if (path === '/v4/sandboxes') { allocations++; return Response.json(named()); }
            if (path === '/v2/sandboxes/happier-managed-1') {
                if (label.endsWith('authored failure')) {
                    authoredNativeFailure = new PluginError({ code: 'credential_unavailable',
                    message: 'Sign in to the selected cloud account.', remediation: { kind: 'retry' },
                    failureCause: { phase: 'machines.managed.acquire', errorClass: 'Error', errorCode: 'EACCES', httpStatus: 403 },
                    details: { nativeCause: { localCause: 'native_options_changed' }, privateOutput: secret } });
                    throw authoredNativeFailure;
                }
                if (init?.method === 'DELETE') { deletes++; vendorAbsent = true; }
                return (allocations || uncertainDelete === 'bound') && !vendorAbsent ? Response.json(named()) : Response.json({}, { status: 404 });
            }
            if (path.endsWith('/stop')) { stops++; vendorStopped = true; return Response.json({}); }
            if (path === '/v2/sandboxes/snapshots') return Response.json({ snapshots: vendorStopped && !vendorAbsent ? [snapshot] : [], pagination: { next: null } });
            if (path === '/v2/sandboxes/sessions/sbx_one') return Response.json({ session });
            if (path === '/v2/sandboxes/snapshots/snap_one') {
                if (init?.method === 'DELETE') { deletes++; vendorAbsent = true; return Response.json({}); }
                return Response.json({ snapshot: { ...snapshot, status: vendorAbsent ? 'deleted' : 'created' } });
            }
            if (path.endsWith('/cmd') && init?.method === 'POST') {
                const body = await new Response(init.body).json();
                const id = `command-${commands.size}`;
                commands.set(id, [body.command, ...(body.args ?? [])].join(' '));
                return Response.json({ command: { id, sessionId: session.id, exitCode: null } });
            }
            const id = path.split('/cmd/')[1]?.split('/')[0];
            if (brokerPreset && id && path.endsWith('/stdin') && commands.get(id)?.includes("'auth' 'request'")) {
                const { data } = await new Response(init?.body).json();
                const enrollment = JSON.parse(new TextDecoder().decode(decodeBase64(data)));
                enrollmentRoles = enrollment.initialMachineMetadata.rolesV1;
            }
            if (id && path.endsWith('/logs')) {
                const command = commands.get(id) ?? '';
                let stdout = '';
                if (command.includes('uname -s')) {
                    await readCreationStage?.('installing');
                    if (interruptBootstrap) return Response.json({ error: 'Guest transport interrupted after allocation' }, { status: 503 });
                    stdout = 'Linux\nx86_64\n/home/guest\n';
                }
                else if (command.includes(signedRelease.source) && command.includes('checksums-happier-')) {
                    stdout = command.includes('.txt.minisig') ? signedRelease.signatureText : signedRelease.checksumsText;
                }
                else if (command.includes('current_target=') && command.includes('version_path')) stdout = 'current=\nprevious=\n';
                else if (command.includes('managed_guest_cli_absent')) stdout = 'managed_guest_cli_absent\n';
                else if (command.includes("'auth' 'request'")) {
                    await readCreationStage?.('joining');
                    joinAttempts++;
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
        if (opaquePreset) {
            input = await createOpaquePresetInput();
        } else {
            input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'one-off', homeId, launch, retention, wakeOnAcceptedMessage: false },
                ...(startAgent ? { agentStart: { directory: { kind: 'managed' }, agentTarget: {
                    kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                } } } : {}),
                enrollmentIdentity, reviewedFacts });
        }
        // Captured public release HTTP bytes keep signature verification and
        // guest installation real; no internal recipe or Action port is replaced.
        vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
            const address = new URL(String(url));
            if (address.origin === 'https://api.vercel.com') return native.fetch(url, init);
            if (address.origin === 'https://api.github.com') return releaseResponse(address);
            if (address.origin === 'https://github.com') {
                throw new TypeError('GitHub release asset downloads lack browser CORS');
            }
            return homes.request(url, init);
        });
        const executor = createDefaultActionExecutor();
        const context = bindPresentUserActionConfirmation('machines.managed.acquire', input, { surface: 'ui', authority: 'present_user',
            serverId, serverIdentityId: homeId, runtimeAccountId: accountId, actionRequestId: 'native-managed-create',
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) });
        if (homePayload && !exportedHomePayload) {
            const refused = await executor.execute('machines.managed.acquire', input, context);
            expect({ admissions, allocations, machineRpcs, approvals }, JSON.stringify(refused)).toEqual({ admissions: 0, allocations: 0, machineRpcs: 0, approvals: 0 });
            expect(refused).toMatchObject({ ok: false, failureCause: { errorCode: label.endsWith('unknown source')
                ? 'guest_cli_identity_unavailable' : 'guest_payload_missing' } });
            expect(managed).toBeUndefined();
            return;
        }
        if (uncertainDelete) {
            const handle = { contributionRef: launch.provider, schemaVersion: 1,
                value: { kind: 'acquire', name: 'happier-managed-1', managedId: 'managed-1', teamId: 'team_one', projectId: 'prj_one' } };
            managed = ManagedMachineV1Schema.parse({ id: 'managed-1', homeId, custodianAccountId: accountId,
                launch, retention, reviewedFacts, enrollmentIdentity,
                allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
                wakeOnAcceptedMessage: false, nativeOperationRef: handle,
                recovery: { reference: 'managed-1', reason: 'native_identity_unavailable' } });
            const deletion = { homeId, managedId: managed.id, when: 'now' as const, expectedRevision: 0,
                intent: 'delete' as const, reviewedDependencies: true as const };
            const result = await executor.execute('machines.managed.delete', deletion,
                bindPresentUserActionConfirmation('machines.managed.delete', deletion, {
                    ...context, actionRequestId: 'retained-acquisition-delete', presentUserConfirmation: undefined,
                }));
            if (uncertainDelete === 'bound') {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'accepted', managedId: managed.id } });
                expect(managed).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
                expect(managed.submittedNativeEffect).toBeUndefined();
                expect(deletes).toBe(1);
            } else {
                expect(result, JSON.stringify(result)).toMatchObject({ ok: false,
                    failureCause: { errorClass: 'ManagedMachineControllerError', errorCode: 'native_acquisition_pending' } });
                expect(managed).toMatchObject({ allocation: 'may-exist', nativeOperationRef: handle });
                expect(managed.submittedNativeEffect).toBeUndefined();
                expect({ stops, deletes }).toEqual({ stops: 0, deletes: 0 });
            }
            expect({ admissions, allocations, approvals, guestDispatches, machineRpcs }).toEqual({
                admissions: 0, allocations: 0, approvals: 0, guestDispatches: 0, machineRpcs: 0,
            });
            expect(JSON.stringify(result)).not.toContain(secret);
            return;
        }
        const discoveryContext = { ...context, presentUserConfirmation: undefined, actionRequestId: 'account-provider-discovery' };
        const probe = { homeId, contribution: launch.provider };
        expect(await executor.execute('machines.provisioners.check', probe, discoveryContext))
            .toMatchObject({ ok: false, errorCode: 'credential_unavailable' });
        const providerCheck = await executor.execute('machines.provisioners.check', { ...probe, credentials: launch.credentials }, discoveryContext);
        expect(providerCheck, JSON.stringify(providerCheck)).toMatchObject({ ok: true, result: { available: true } });
        expect(await executor.execute('machines.provisioners.options', {
            ...probe, credentials: launch.credentials, selectors: launch.choices,
        }, discoveryContext)).toMatchObject({ ok: true, result: { base: { available: true, launch: launch.choices } } });
        expect({ admissions, allocations, machineRpcs }).toEqual({ admissions: 0, allocations: 0, machineRpcs: 0 });
        if (label.endsWith('authored failure')) {
            const failure = await executor.execute('machines.managed.acquire', input, context);
            expect(authoredNativeFailure).toBeDefined();
            expect(allocations).toBe(0);
            expect(failure, JSON.stringify({ boundaryError: { canonical: isPluginError(authoredNativeFailure),
                sameErrorIntrinsic: new Function('return Error')() === Error } })).toMatchObject({ ok: false, errorCode: 'credential_unavailable',
                error: 'Sign in to the selected cloud account.',
                failureCause: { phase: 'machines.managed.acquire', errorClass: 'Error', errorCode: 'EACCES', httpStatus: 403 },
                details: { name: 'PluginError', message: 'Sign in to the selected cloud account.', remediation: { kind: 'retry' } },
            });
            expect(JSON.stringify(failure)).not.toContain(secret);
            expect(allocations).toBe(0);
            return;
        }
        const stages = new Set<string>();
        readCreationStage = async stage => {
            const observed = await executor.execute('machines.managed.get', { homeId, managedId: 'managed-1' }, {
                ...context, actionRequestId: `stage-${stage}`, presentUserConfirmation: undefined,
            });
            if (!observed.ok) throw new Error('Creation fact read failed');
            const row = ManagedMachineV1Schema.parse(isManagedOpaquePresetReadV1(observed.result)
                ? observed.result.machine : observed.result);
            expect(row).toMatchObject({ id: 'managed-1', allocation: 'bound' });
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
            let acquisition: ManagedMachineAcquisitionDraft = { requestId: 'native-managed-create', selection: input.selection };
            const progress: ManagedMachineCreationProgress[] = [];
            const created = await runManagedMachineCreation({
                draft: { selection: input.selection, receipt: reviewedFacts, enrollmentIdentity,
                    ...('presetContentOverride' in input ? { presetContentOverride: input.presetContentOverride } : {}) },
                acquisition,
                agentStart: input.agentStart, scope: lifetime.scope, signal: new AbortController().signal,
                isCurrent: () => lifetime.isCurrent(), onAcquisitionChange: value => { acquisition = value; }, onProgress: value => { progress.push(value); },
                onApprovalPending: () => { throw new Error('The designed review must answer default confirmation'); },
            });
            if (label.startsWith('browser bootstrap failure recovery')) {
                expect(created).toMatchObject({ kind: 'failed' });
                expect(progress.at(-1), JSON.stringify(progress)).toMatchObject({ kind: 'failed', managedId: 'managed-1', retryInstallationAvailable: true });
                expect(acquisition.managedId).toBe('managed-1');
                expect(managed).toMatchObject({ id: 'managed-1', allocation: 'bound', observation: { availability: 'unavailable' } });
                expect(managed?.enrolledMachineId).toBeUndefined();
                expect(allocations).toBe(1);
                const listed = await executor.execute('machines.managed.list', { homeId }, context);
                expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, result: { machines: [
                    { id: 'managed-1', allocation: 'bound', observation: { availability: 'unavailable' } },
                ] } });
                if (cleanupAction) {
                    let reviewed = false;
                    const deleted = await runManagedMachineCreation({
                        draft: { selection: input.selection, receipt: reviewedFacts, enrollmentIdentity }, acquisition,
                        scope: lifetime.scope, signal: new AbortController().signal, setupRecovery: 'delete',
                        reviewDelete: async census => { expect(census.machineId).toBeNull(); reviewed = true; return true; },
                        isCurrent: () => lifetime.isCurrent(), onAcquisitionChange: value => { acquisition = value; },
                        onProgress: value => { progress.push(value); },
                        onApprovalPending: () => { throw new Error('The in-page Delete review must be sufficient'); },
                    });
                    expect(deleted, JSON.stringify(deleted)).toEqual({ kind: 'delete_requested', managedId: 'managed-1' });
                    expect(reviewed).toBe(true);
                    expect(managed).toMatchObject({ allocation: 'confirmed-absent', observation: { availability: 'absent' } });
                    expect(managed?.controller).toBeUndefined();
                    expect({ allocations, admissions, stops, deletes }).toEqual({ allocations: 1, admissions: 1, stops: 1, deletes: 1 });
                    return;
                }
                interruptBootstrap = false;
                const retried = await runManagedMachineCreation({
                    draft: { selection: input.selection, receipt: reviewedFacts, enrollmentIdentity }, acquisition,
                    agentStart: input.agentStart, scope: lifetime.scope, signal: new AbortController().signal,
                    retryInstallation: true, isCurrent: () => lifetime.isCurrent(),
                    onAcquisitionChange: value => { acquisition = value; }, onProgress: value => { progress.push(value); },
                    onApprovalPending: () => { throw new Error('The designed review must answer default confirmation'); },
                });
                expect(homeBoundaryFailures).toEqual([]);
                if (exportedHomePayload) {
                    expect(managed?.guestCli?.payloads).toEqual([homePayloadArchive]);
                    const installed = [...commands.values()].filter(command => command.includes(homeRetryArchive.url));
                    expect(installed, JSON.stringify({ retried, progress })).toHaveLength(1);
                    expect(installed[0]).toContain(homeRetryArchive.sha256);
                    expect(releaseRequests).toBe(0);
                }
                expect(retried, JSON.stringify({ retried, progress, homePaths })).toMatchObject({ kind: 'enrolled', machine: { id: 'managed-1', enrolledMachineId: 'joined' } });
                expect({ allocations, admissions, guestDispatches }).toEqual({ allocations: 1, admissions: 1, guestDispatches: 0 });
                return;
            }
            const code = created.kind === 'failed' ? created.code : created.kind;
            interrupted = created.kind === 'enrolled' ? { ok: true, result: { managedId: created.machine.id } }
                : { ok: false, errorCode: code, error: code };
        } else {
            const { createManagedProvisionerClient } = await import('@/components/settings/machines/managed/managedProvisionerClient');
            const created = await createManagedProvisionerClient(lifetime.scope, homeId).execute('machines.managed.acquire', input);
            const code = created.kind === 'failed' ? created.code : created.kind;
            interrupted = created.kind === 'succeeded' ? { ok: true, result: created.value }
                : { ok: false, errorCode: code, error: code,
                    ...(created.kind === 'failed' && created.failureCause ? { failureCause: created.failureCause } : {}) };
        }
        if (missingPolicy) {
            const { resolveMachineRetentionPolicyV1 } = await import('@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1');
            const policy = resolveMachineRetentionPolicyV1({ billing: provisioner.billing, nativeCapabilities: provisioner.retention });
            expect(admissions, JSON.stringify(interrupted)).toBe(1);
            expect(admittedPresetPolicy, JSON.stringify(interrupted)).toEqual({
                retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage });
        }
        expect(homeBoundaryFailures).toEqual([]);
        expect(stages, JSON.stringify({ interrupted, observation: managed?.observation })).toEqual(new Set(['installing', 'joining']));
        readCreationStage = undefined;
        if (missingPolicy && !plainPreset) {
            // Replay the same root against the Home's real report-updated
            // retained carrier; the source Preset has no native resource facts.
            const replayed = await executor.execute('machines.managed.acquire', input, context);
            expect(joinAttempts, JSON.stringify(replayed)).toBe(2);
            expect({ admissions, allocations }).toEqual({ admissions: 2, allocations: 1 });
        }
        let retried = interrupted;
        if (!startAgent) {
            expect(interrupted).toMatchObject({ ok: true, result: { managedId: 'managed-1' } });
            const retained = await executor.execute('machines.managed.get', { homeId, managedId: 'managed-1' }, {
                ...context, actionRequestId: 'stage-interrupted', presentUserConfirmation: undefined,
            });
            if (!retained.ok) throw new Error('Interrupted creation read failed');
            const retainedRow = ManagedMachineV1Schema.parse(isManagedOpaquePresetReadV1(retained.result)
                ? retained.result.machine : retained.result);
            expect(retainedRow).toMatchObject({ allocation: 'bound', bootstrapInstalled: true });
            expect(retainedRow.enrolledMachineId).toBeUndefined();
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
        expect(machineRpcs).toBe(0);
        expect(homeBoundaryFailures).toEqual([]);
        expect(retried, JSON.stringify({ retried, homePaths, roleDispatches, allocations, joinAttempts })).toMatchObject({ ok: true, result: { managedId: 'managed-1' } });
        if (brokerPreset) expect(enrollmentRoles).toEqual({ active: ['sessions', 'broker'] });
        const joined = await executor.execute('machines.managed.get', { homeId, managedId: 'managed-1' }, {
            ...context, actionRequestId: 'stage-joined', presentUserConfirmation: undefined,
        });
        if (!joined.ok) throw new Error('Joined creation read failed');
        expect(ManagedMachineV1Schema.parse(isManagedOpaquePresetReadV1(joined.result)
            ? joined.result.machine : joined.result)).toMatchObject({ allocation: 'bound', bootstrapInstalled: true, enrolledMachineId: 'joined' });
        expect({ admissions, allocations, approvals, machineRpcs, guestDispatches }).toEqual({
            admissions: missingPolicy && !plainPreset ? 2 : 1, allocations: 1, approvals: 1, machineRpcs: 0, guestDispatches: startAgent ? 1 : 0,
        });
        expect(roleDispatches).toBe(0);
        expect(guestContinuation).toEqual(startAgent
            ? { managedId: 'managed-1', creationRequestId: 'native-managed-create', expectedIntentRevision: 0 }
            : undefined);
        if (exportedHomePayload) {
            expect(releaseRequests).toBe(0);
            const installCommands = [...commands.values()].filter(command => command.includes(homePayloadArchive.url));
            expect(installCommands).toHaveLength(1);
            expect(installCommands[0]).toContain(homePayloadArchive.sha256);
            expect(installCommands[0]).toContain(serverUrl);
        }
        expect(JSON.stringify({ interrupted, retried })).not.toContain(secret);
        if (missingPolicy) {
            expect(homePaths.filter(path => path === '/v1/machines/presets/get')).toHaveLength(plainPreset ? 1 : 2);
        }
        if (plainPreset) {
            expect(encryption).toBeNull();
            expect(credentials).not.toHaveProperty('secret');
            return;
        }
        let resized: ActionExecuteResult | undefined;
        if (opaquePreset) {
            const { createManagedMachinePresetResizeOverrideV1, projectManagedMachinePresetForRecipientV1 } =
                await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
            if (!encryption || !admittedPresetContent || !managed?.preset
                || managed.preset.contentEncryptionMode !== 'e2ee') throw new Error('Missing opaque resize custody');
            const projection = projectManagedMachinePresetForRecipientV1({ content: admittedPresetContent.content,
                recipients: admittedPresetContent.recipients, recipientAccountId: accountId });
            const override = createManagedMachinePresetResizeOverrideV1({ presetId: managed.preset.id,
                mode: 'e2ee', projection, accountId,
                accountKey: encryption.getContentPrivateKey(), size: { memoryBytes: 6 * 1024 ** 3 },
                randomBytes: length => new Uint8Array(length).fill(19) });
            if (!override) throw new Error('Expected a sealed opaque resize override');
            const resizeInput = { homeId, managedId: managed.id, presetContentOverride: override };
            resized = await executor.execute('machines.managed.resize', resizeInput,
                bindPresentUserActionConfirmation('machines.managed.resize', resizeInput, {
                    ...context, actionRequestId: 'native-managed-opaque-resize', presentUserConfirmation: undefined,
                }));
            expect(resized, JSON.stringify(resized)).toMatchObject({ ok: true, result: {
                result: { kind: 'unsupported' }, presetContent: expect.any(Object),
            } });
            expect(JSON.stringify(resized)).not.toContain('memoryBytes');
        }
        const inspect = await executor.execute('machines.managed.inspect', { homeId, managedId: 'managed-1' }, {
            ...context, actionRequestId: undefined, presentUserConfirmation: undefined,
        });
        expect.soft(inspect, JSON.stringify(inspect)).toMatchObject({ ok: true, result: { machine: { id: 'managed-1',
            observation: { availability: 'present', power: 'running' } } } });
        expect.soft(allocations).toBe(1);
        expect.soft(approvals).toBe(1);
        expect.soft(JSON.stringify({ inspect, retried })).not.toContain(secret);
        if (opaquePreset) {
            const stopInput = { homeId, managedId: 'managed-1', when: 'now' as const,
                expectedRevision: managed!.intentRevision, intent: 'stop' as const };
            const stopped = await executor.execute('machines.managed.power.set', stopInput,
                bindPresentUserActionConfirmation('machines.managed.power.set', stopInput, {
                    ...context, actionRequestId: 'native-managed-opaque-stop', presentUserConfirmation: undefined,
                }));
            expect(stopped, JSON.stringify(stopped)).toMatchObject({ ok: true, result: { kind: 'accepted' } });
            expect(stops).toBe(1);
            const deleteInput = { homeId, managedId: 'managed-1', when: 'now' as const,
                expectedRevision: managed!.intentRevision, intent: 'delete' as const, reviewedDependencies: true as const };
            const deleted = await executor.execute('machines.managed.delete', deleteInput,
                bindPresentUserActionConfirmation('machines.managed.delete', deleteInput, {
                    ...context, actionRequestId: 'native-managed-opaque-delete', presentUserConfirmation: undefined,
                }));
            expect(deleted, JSON.stringify({ deleted, stops, deletes, allocation: managed?.allocation,
                intentRevision: managed?.intentRevision, paths: homePaths.slice(-6) }))
                .toMatchObject({ ok: true, result: { kind: 'accepted' } });
            expect(deletes).toBe(1);
            expect(managed?.allocation).toBe('confirmed-absent');
            // Actual external Action responses retain the structural/ciphertext
            // projection, never the local declaration or native resource.
            expect(homePaths.filter(path => path.includes('/machines/presets/') || path.includes('/machines/pools/')))
                .toEqual(Array.from({ length: missingPolicy ? 2 : 1 }, () => '/v1/machines/presets/get'));
            const homeWire = homeBodies.join('\n');
            expect(homeWire).not.toContain(privatePresetName);
            expect(homeWire).not.toContain(privateLaunchName);
            expect(homeWire).not.toContain(privateOverrideName);
            expect(homeWire).not.toContain(secret);
            const outbound = JSON.stringify({ interrupted, retried, resized, joined, inspect });
            expect(outbound).not.toContain(privatePresetName);
            expect(outbound).not.toContain(privateLaunchName);
            expect(outbound).not.toContain(privateOverrideName);
            expect(outbound).not.toContain(secret);
            expect(outbound).not.toContain('"launch"');
            expect(outbound).not.toContain('"resource"');
        }
    } finally { account.dispose(); }
}, 120_000);
}
