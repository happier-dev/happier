import axios from 'axios';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as childProcesses from 'node:child_process';
import nacl from 'tweetnacl';
import { afterEach, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { StoredApprovalRequestSchema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { ManagedAcquireInputV1Schema, ManagedControllerReportV1Schema, ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { GuestCliIdentityV1Schema } from '@happier-dev/protocol/features';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { machineSetup } from '@happier-dev/cli-common';
import { createManagedBootstrapSshCredential, readManagedBootstrapCredential } from '@happier-dev/cli-common/machines/managed';
import { MachineEffectInternalRequestSchema } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { PLUGIN as HETZNER_PLUGIN } from '../../../../../packages/plugins/machine-hetzner/src/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { TargetActionInvocationRegistration } from '@/plugins/runtime/invocation/targetActionRegistry';
import { fixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { projectPluginSystemToolContributions } from '@/plugins/runtime/exec/system/tools/definitions';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import { createConnectedAccountPluginHttpPurposeHost } from '@/plugins/runtime/fetch/connectedAccountPurpose';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createManagedMachineAcquisitionDriver } from './acquire';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { reloadConfiguration } from '@/configuration';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { createCliPayloadFixture } from '../../../../../packages/cli-common/src/systemTasks/testkit/createCliPayloadFixture';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { AccountSettingsSchema, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createLiveRemoteSshBootstrapTaskKind } from '@/capabilities/systemTasks/ssh/liveRemoteSshBootstrap';
import { encodeStoredCredentials } from '@/persistence';

type SshRequest = Parameters<typeof import('@happier-dev/cli-common/ssh')['runOpenSshRemoteCommand']>[0];
const sshBoundary = vi.hoisted(() => ({ run: vi.fn<(request: SshRequest) => Promise<{ status: number; stdout: string; stderr: string }>>() }));
// SSH execution/upload are the physical guest/network boundaries. Builders,
// installation, setup interpreter and pairing flow below remain real.
vi.mock('@happier-dev/cli-common/ssh', async importOriginal => ({
    ...await importOriginal<typeof import('@happier-dev/cli-common/ssh')>(),
    runOpenSshRemoteCommand: (request: SshRequest) => sshBoundary.run(request),
    transferOpenSshFile: async () => {},
}));
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); reloadConfiguration(); });

it('uses one real Create confirmation through Hetzner enrollment and administrator setup', () => confirmCreate(false));
it('carries the Create confirmation through a retained enrollment into real guest policy', () => confirmCreate(true));
it('keeps one independent confirmation for standalone administrator setup', () => confirmCreate(true, 'admin'));
it('keeps one independent confirmation for standalone enrollment', () => confirmCreate(false, 'enroll'));

async function confirmCreate(alreadyEnrolled: boolean, entry: 'create' | 'admin' | 'enroll' = 'create') {
    const currentness = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => currentness.close());
    const accountId = 'mac36-owner';
    const homeId = 'srv_mac36';
    const controller = { machineId: 'mac36-controller', installationId: 'mac36-installation' };
    const provider = { pluginId: 'happier.machine.hetzner', localId: 'hetzner' };
    const service = { pluginId: provider.pluginId, localId: 'hetzner-account' };
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 2,
        provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential boundary'); };
    const credential = { purpose: { consumer: provider, purpose: 'cloud-api' }, account: { service, accountId: 'captured' } };
    let input = ManagedAcquireInputV1Schema.parse({
        enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized' },
        selection: { kind: 'one-off', homeId, controller, launch: { provider, schemaVersion: 1, name: 'Reviewed guest',
            credentials: [credential], choices: { serverTypeId: '22', imageId: '67794396', locationId: 'fsn1',
                publicNetworking: { ipv4: true, ipv6: false } } }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    });
    if (input.selection.kind !== 'one-off') throw new Error('Expected the actual one-off selection');
    const resourceId = 'mac36-bootstrap-key';
    const key = generateKeyPairSync('rsa', { modulusLength: 1024,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    const bootstrapCredential = createManagedBootstrapSshCredential({ bootstrapPrivateKey: key,
        randomBytes: size => new Uint8Array(size).fill(37) });
    const guestHostPublicKey = readManagedBootstrapCredential(bootstrapCredential).guestHostPublicKey;
    if (!guestHostPublicKey) throw new Error('Missing generated guest host identity');
    const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain',
        content: { v: 1, name: 'Bootstrap key', kind: 'other', value: bootstrapCredential } });
    let machine = ManagedMachineV1Schema.parse({ id: 'mac36-managed', homeId, custodianAccountId: accountId, controller,
        launch: input.selection.launch, enrollmentIdentity: input.enrollmentIdentity, allocation: 'unsubmitted', creationState: 'active',
        desired: 'start', desiredWhen: 'now', intentRevision: 0, retention: input.selection.retention,
        wakeOnAcceptedMessage: false, bootstrapCredentialRef: { kind: 'shared_resource', resourceId } });
    if (alreadyEnrolled) machine = ManagedMachineV1Schema.parse({ ...machine, allocation: 'bound', enrolledMachineId: 'mac36-guest',
        resource: { contributionRef: provider, schemaVersion: 1, value: { serverId: 41, owned: { volumeIds: [], primaryIpIds: [9] } } } });
    const guestKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(73));
    const guestRow = { id: 'mac36-guest', kind: 'persistent', active: true, installationId: 'mac36-guest-installation',
        installationPublicKey: Buffer.from(guestKeys.publicKey).toString('base64'), revokedAt: null, replacedByMachineId: null,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null,
        access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    const manifest = normalizePluginManifestV2(HETZNER_PLUGIN.manifest);
    const descriptor = manifest.contributes.machineProvisioners.find(candidate => candidate.id === provider.localId);
    if (!descriptor) throw new Error('Missing activated Hetzner declaration');
    const reviewedFacts = buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(descriptor.launchSchema),
        launch: input.selection.launch, controller, provisioner: descriptor, optionStatus: 'current',
        prerequisites: descriptor.prerequisites.map(requirement => ({ requirement, status: 'available' })),
        billing: descriptor.billing, retentionCapabilities: descriptor.retention,
        machineOverride: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
    input = ManagedAcquireInputV1Schema.parse({ ...input, reviewedFacts });
    const activated = await activateContributionModule({ pluginId: provider.pluginId,
        occurrenceId: createPluginRuntimeOccurrenceId(provider.pluginId), manifest,
        moduleNamespace: { activateAccount: HETZNER_PLUGIN.activateAccount },
        target: { realm: 'account', artifactId: 'account-runtime', exportName: 'activateAccount' }, isOccurrenceCurrent: () => true });
    const actionHandlers = new Map(activated.registrations.flatMap((registration): [string, TargetActionInvocationRegistration['handler']][] =>
        registration.family === 'actions' ? [[registration.localId, (body, context) => Reflect.apply(registration.value, undefined, [body, context])]] : []));
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const credentialOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: accountId,
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable, resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Captured' } : null,
        materializeAccount: async () => ({ kind: 'httpHeaders', headers: { Authorization: 'Bearer simulated-provider-token' } }),
        resolveCredentialConfigurationRevision: async () => 'configuration-1', projectTargetAccounts: unavailable,
        assertTargetAccountMaterializable: unavailable });
    let vendorCreates = 0;
    const vendorRequests: string[] = [];
    const homeRequests: string[] = [];
    const guestResults: unknown[] = [];
    const guestNativeActions: string[] = [];
    const guestConfirmations: string[] = [];
    const systemTools = createPluginExecSystemToolResolver({
        definitions: projectPluginSystemToolContributions(manifest.contributes.systemTools),
        registerGrant() {},
    });
    const serviceOwners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, connectedAccounts: credentialOwner,
        exec: { systemToolsForPlugin: () => systemTools, resolveExecutable: unavailable, resolvePath: unavailable },
        http: createStablePluginHttpHost({
            purposeHost: createConnectedAccountPluginHttpPurposeHost(credentialOwner, {
                registerRawForRedaction(seed, value) { serviceOwners.registerRawForRedaction(seed, value); },
            }),
            adapter: { openWebSocket: unavailable, request: async request => {
            const path = new URL(request.url).pathname;
            vendorRequests.push(`${request.method} ${path}`);
            if (request.method === 'POST') { expect(path).toBe('/v1/servers'); vendorCreates++; }
            else { expect(request.method).toBe('GET'); expect(path).toBe('/v1/servers/41'); }
            return { status: 201, headers: { 'content-type': 'application/json' }, finalUrl: request.url,
                body: new TextEncoder().encode(JSON.stringify({ server: { id: 41, status: 'running', labels: {}, volumes: [],
                    public_net: { ipv4: { id: 9, ip: '203.0.113.10' }, ipv6: null } } })) };
        } } }) });
    const native = fixture({ fixtureManifest: manifest, actionHandlers, credentialOwner, executionRealm: 'account',
        credentialPurposes: [{ purpose: 'cloud-api', service }],
        createServices: serviceOwners.createServices, resolveHostBinding: serviceOwners.resolveHostBinding });
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(), purposeBindingOwner: credentialOwner,
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }) });
    const directory = await mkdtemp(join(tmpdir(), 'mac36-create-confirmation-'));
    const payload = await createCliPayloadFixture();
    const oldHome = process.env.HAPPIER_HOME_DIR;
    await mkdir(join(directory, 'servers', homeId), { recursive: true });
    const homeDescriptor = { v: 1 as const, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.example', revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://home.example' }] };
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ schemaVersion: 5, onboardingCompleted: true, activeServerId: homeId,
        servers: { [homeId]: { id: homeId, name: 'Home', serverUrl: 'https://home.example', webappUrl: 'https://home.example',
            homeConnectionDescriptor: homeDescriptor, createdAt: 1, updatedAt: 1, lastUsedAt: 1 } } }));
    await writeFile(join(directory, 'servers', homeId, 'access.key'), JSON.stringify(encodeStoredCredentials(credentials)));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payload.payloadRoot);
    reloadConfiguration();
    onTestFinished(async () => { await payload.cleanup(); await rm(directory, { recursive: true, force: true });
        if (oldHome === undefined) delete process.env.HAPPIER_HOME_DIR; else process.env.HAPPIER_HOME_DIR = oldHome;
        reloadConfiguration(); });
    const hostKeyLine = `203.0.113.10 ${guestHostPublicKey}`;
    const actualProcesses = await vi.importActual<typeof childProcesses>('node:child_process');
    vi.spyOn(childProcesses, 'spawn').mockImplementation((command, argv = [], options) => basename(command) === 'ssh-keyscan'
        ? actualProcesses.spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(hostKeyLine + '\n')})`], options)
        : actualProcesses.spawn(command, argv, options));
    vi.spyOn(childProcesses, 'spawnSync').mockImplementation((...args: Parameters<typeof childProcesses.spawnSync>) => basename(args[0]) === 'ssh-keyscan'
        ? { pid: 1, status: 0, signal: null, stdout: `${hostKeyLine}\n`, stderr: '', output: [] } : actualProcesses.spawnSync(...args));
    const applied = new Set<string>();
    const remoteStages: string[] = [];
    const backend: machineSetup.MachineSetupBackend = {
        observe: async step => {
            const facts: Record<string, boolean | number> = step.kind === 'user' ? { present: true, uid: 1001 } : {};
            return { stepId: step.id, status: applied.has(step.id) ? 'satisfied' : 'drifted', facts };
        },
        apply: async step => { applied.add(step.id); },
    };
    sshBoundary.run.mockImplementation(async request => {
        const command = request.remoteCommand.join(' ');
        remoteStages.push(['uname', '/etc/os-release', 'effect-internal', 'enroll-remote', 'auth', 'daemon', 'version_path']
            .find(stage => command.includes(stage)) ?? 'other');
        let stdout = '';
        if (command.includes('uname -s') && command.includes('printf') && command.includes('platform')) {
            // The ordinary SSH install transport frames release facts as JSON;
            // the dedicated bootstrap's separate uname probe remains line-framed.
            stdout = JSON.stringify({ platform: 'linux', arch: 'x86_64' }) + '\n';
        } else if (command.includes('uname -s')) stdout = command.includes('uname -m') ? 'Linux\nx86_64\n/home/happier\n' : 'Linux\n';
        else if (command.includes('/etc/os-release')) stdout = 'ubuntu\nnoble\namd64\n';
        else if (command.includes('managed_guest_cli_absent')) stdout = 'managed_guest_cli_absent\n';
        else if (command.includes('version_path')) stdout = 'current=\nprevious=\n';
        else if (command.includes('mktemp -d /tmp/happier-bootstrap-upload.')) stdout = '/tmp/happier-bootstrap-upload.fixture\n';
        else if (command.includes('effect-internal')) {
            const frame = MachineEffectInternalRequestSchema.parse(JSON.parse(String(request.input).trim()));
            if (frame.mode === 'check' && !('steps' in frame)) throw new Error('Unexpected firewall check frame');
            const result = frame.mode === 'check'
                ? { status: 'checked', plan: await machineSetup.checkMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps, backend }) }
                : await machineSetup.applyMachineSetupEffectPlans({ ...frame, backend });
            stdout = JSON.stringify({ type: 'result', result }) + '\n';
        } else if (command.includes('enroll-remote')) {
            const startedAt = Date.now();
            stdout = JSON.stringify({ kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
                publicKey: Buffer.alloc(32, 3).toString('base64'), homeServerIdentityId: homeId,
                pairing: { secretB64Url: Buffer.alloc(32, 4).toString('base64url'), createdAtMs: startedAt, expiresAtMs: startedAt + 60_000 },
                supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: homeId }) + '\n'
                + JSON.stringify({ kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
                    homeServerIdentityId: homeId, machineId: 'mac36-guest', encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: homeId }) + '\n';
            machine = ManagedMachineV1Schema.parse({ ...machine, enrolledMachineId: 'mac36-guest' });
        } else if (/auth.*status/u.test(command)) stdout = JSON.stringify({ v: 1, ok: true, kind: 'auth_status', data: {
            authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'mac36-guest' } }) + '\n';
        else if (/daemon.*status/u.test(command)) stdout = JSON.stringify({ server: { activeServerId: homeId }, service: { installed: true },
            daemon: { running: true, healthy: true }, auth: { needsAuth: false, machineId: 'mac36-guest' } }) + '\n';
        // Dedicated-user commands also contain id -u in their wrapper; only
        // the standalone UID probe has this as its observable result.
        else if (command.includes('id -u happier') && !command.includes('runuser')) stdout = '1001\n';
        else stdout = JSON.stringify({ ok: true, data: {} }) + '\n';
        request.onStdoutChunk?.(stdout);
        return { status: 0, stdout, stderr: '' };
    });
    // Only Home/provider HTTP and Artifact persistence are substituted. Parent
    // preparation, approval decision/replay, native custody and provider run real.
    const guestCli = GuestCliIdentityV1Schema.parse({ source: 'home-payload', line: '0.3', channel: 'stable' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: { teams: { enabled: true } },
        capabilities: { serverIdentity: { serverIdentityId: homeId }, guestCli }, homeConnectionDescriptor: homeDescriptor })));
    // Action admission reads the Account's automation index (696f6e7545a fails closed when it can't);
    // this Account has no automations, and the index travels over generic axios.request.
    installAxiosRequestMethodAdapter();
    vi.spyOn(axios, 'get').mockImplementation(async rawUrl => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
        if (path === '/v1/machines/mac36-guest') return { status: 200, data: { machine: guestRow } };
        if (path === '/v1/machines') return { status: 200, data: [guestRow] };
        if (path.endsWith('/account/profile')) return { status: 200, data: { id: accountId } };
        if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path.endsWith(`/v1/machines/${controller.machineId}`)) return { status: 200, data: { machine: {
            id: controller.machineId, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
            access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
        if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
        if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        if (path.endsWith('/resources/materials')) return { status: 200, data: { resources: [{ resourceId,
            encryptionMode: 'plain', storedContent, recipientEnvelope: null, entry: { ref: formatSharedSavedSecretRefV1(resourceId),
                source: 'shared_resource', relationship: 'owner', name: 'Bootstrap key', kind: 'other', ownerAccountId: accountId, revision: 1,
                materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] } };
        throw new Error(`Unexpected Home GET ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const path = new URL(String(url)).pathname;
        homeRequests.push(path);
        if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
        if (path === managedMachineActionEndpointPathV1('machines.managed.get')) return {
            status: 200, data: ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(machine),
        };
        const actionId = path.startsWith('/v1/actions/machines.setup.adminAccess.set') ? 'machines.setup.adminAccess.set'
            : path.startsWith('/v1/actions/machines.agentIsolation.preview') ? 'machines.agentIsolation.preview'
            : path.startsWith('/v1/actions/machines.agentIsolation.set') ? 'machines.agentIsolation.set'
            : path.startsWith('/v1/actions/machines.roles.set') ? 'machines.roles.set' : null;
        if (actionId) {
            const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const envelope = carrier.success ? carrier.data.envelope : ExternalActionRequestEnvelopeV1Schema.parse(body);
            // Home admits raw original-Account requests before forwarding to
            // the daemon too; transport admission is not parent consent.
            const admitted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-child', binding: {
                    accountId, custodianAccountId: accountId, authentication: { kind: 'terminal', tokenEpoch: 2 }, accountEncryptionMode: 'plain',
                    serverIdentityId: homeId, machineId: guestRow.id, installationId: guestRow.installationId, actionId,
                    requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
                    ...(carrier.success && carrier.data.managedContinuation ? { managedContinuation: { ...carrier.data.managedContinuation, controller,
                        acquireRequestEnvelopeDigest: 'a'.repeat(43) } } : {}),
                } });
            if (path.endsWith('/execution-authorization')) return { status: 200, data: admitted };
            const result = await executeExternalAction({ actionId, envelope,
                executionAuthorization: carrier.success && carrier.data.executionAuthorization ? carrier.data.executionAuthorization : admitted,
                principal: { accountId, authority: 'account_automation', authentication: { kind: 'terminal', tokenEpoch: 2 } },
                currentMachineId: guestRow.id, currentAccountId: accountId, currentServerId: homeId, currentServerHttpBaseUrl: 'https://home.example',
                machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: accountId,
                    custodianAccountId: accountId, machineId: guestRow.id, installationId: guestRow.installationId,
                    role: guestRow.access.role, encryptionMode: guestRow.access.resourceMode }),
                currentInstallationId: guestRow.installationId, externalActionMachineRequestPrivateKey: guestKeys.secretKey,
                verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                    privateKey: guestKeys.secretKey, installationId: guestRow.installationId, serverHttpBaseUrl: 'https://home.example' }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: guest.executor,
                prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
                    purpose: { kind: 'external_action' }, machineId: guestRow.id, installationId: guestRow.installationId,
                    installationPrivateKey: guestKeys.secretKey, serverId: homeId, serverIdentityId: homeId,
                    serverHttpBaseUrl: 'https://home.example', ownCredentials: credentials,
                    isCurrent: async () => !request.signal?.aborted, createExecutor: () => guest.executor }),
            });
            guestResults.push(result.kind === 'response' && result.response.v === 1 ? result.response.execution : result);
            if (result.kind !== 'response') throw new Error(`Guest receiver refused: ${result.kind}`);
            return { status: 200, data: result.response };
        }
        if (path === '/v1/auth/response') return { status: 200, data: {} };
        if (!path.startsWith('/v1/machines/managed/controller/')
            || !['/admit', '/current', '/context', '/submit', '/report', '/enrollment-context'].some(suffix => path.endsWith(suffix))) {
            throw new Error(`Unexpected Home POST ${path}`);
        }
        if (String(url).endsWith('/submit')) machine = ManagedMachineV1Schema.parse({ ...machine, allocation: 'may-exist' });
        if (String(url).endsWith('/report')) {
            const report = ManagedControllerReportV1Schema.parse(body);
            if (report.result.kind === 'bound') machine = ManagedMachineV1Schema.parse({ ...machine, allocation: 'bound', resource: report.result.resource });
        }
        return { status: 200, data: { machine, ...(String(url).endsWith('/admit') ? { replayed: false } : {}),
            ...(String(url).endsWith('/submit') ? { submitted: true } : {}) } };
    });
    const driver = createManagedMachineAcquisitionDriver({ token, serverUrl: 'https://home.example', homeId, controller, credentials,
        observeRecordedApprovalExecution: args => guest.observeRecordedApprovalExecution(args),
        runtimeRegistry: native.runtimeRegistry, managedProviderOperationAuthority: authority,
        homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] }, authority: 'current_connection' }) });
    const questions = new Set<string>();
    const promptResponses: Promise<unknown>[] = [];
    const promptResponseFailures: unknown[] = [];
    let additionalConsent = () => {};
    const consentPresented = new Promise<void>(resolve => { additionalConsent = resolve; });
    let lastOperation: unknown;
    let adminPhase = 'not_started';
    let lastGuestOperation: Readonly<{ state: string; errorCode?: string }> | undefined;
    onTestFailed(() => console.error('Managed confirmation boundary progress', { lastOperation, adminPhase, lastGuestOperation,
        remoteStages, vendorRequests, homeRequests, guestResults, guestConfirmations, guestNativeActions }));
    const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => accountId,
        generateOperationId: () => 'mac36-create', publishSnapshot: snapshot => {
            const task = snapshot.domainRef?.kind === 'managedMachine' ? snapshot.domainRef.bootstrapTask : undefined;
            lastOperation = { state: snapshot.state, progress: snapshot.progress, error: snapshot.error, promptKind: task?.prompt?.kind };
            if (task?.prompt?.kind !== 'auth.approveRemoteProvisioning' || questions.has(task.id)) return;
            questions.add(task.id);
            additionalConsent();
            // The operation publishes before the runner installs its response
            // resolver; a human/client response arrives after that stack unwinds.
            promptResponses.push(Promise.resolve().then(() => getLiveSystemTasksRunnerAdapter()
                .respond({ taskId: task.id, answer: { approved: true } }))
                .catch(error => { promptResponseFailures.push(error); }));
        } });
    onTestFinished(async () => { await operations.handlers.cancel({ operationId: 'mac36-create' }); await entered?.catch(() => undefined); });
    const approvals = new Map<string, ApprovalRequest>();
    let entered: Promise<unknown> | undefined;
    let guestOperationSequence = 0;
    const guestOperations = createHostActionOperationRuntime({ machineId: guestRow.id, resolveAccountId: async () => accountId,
        generateOperationId: () => `mac36-guest-policy-${++guestOperationSequence}`, publishSnapshot: snapshot => {
            const errorCode = snapshot.error && Reflect.get(snapshot.error, 'errorCode');
            lastGuestOperation = { state: snapshot.state,
                ...(typeof errorCode === 'string' && /^[a-zA-Z0-9_.:-]+$/u.test(errorCode) ? { errorCode } : {}) };
        } });
    const guest = createCliActionExecutorHarness({ token, credentials, mode: 'plain', ctx: null, sessionId: '', serverId: homeId,
        serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.example', externalActionMachineInstallationId: guestRow.installationId,
        externalActionMachineRequestPrivateKey: guestKeys.secretKey,
        actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false, accountSettings: AccountSettingsSchema.parse({
            actionsSettingsV1: { v: 1, actions: { 'machines.setup.adminAccess.set': { approvalRequiredSurfaces: ['cli', 'ui'] },
                'machines.agentIsolation.set': { approvalRequiredSurfaces: ['cli', 'ui'] } } },
        }) }),
        // The remote Machine RPC/native OS is the boundary. Receiving Action
        // policy, requester custody and parent-review issuer remain real.
        machineActionDirectTargetTransport: { machineId: guestRow.id, invoke: async method => {
            guestNativeActions.push(method);
            if (method === 'machines.setup.adminAccess.set') return { status: 'applied', policy: { version: 1, mode: 'preauthorized' }, metadataVersion: 1 };
            // Machine roles (OWNER-RULINGS 2026-11-12): a managed server seeds its reviewed role set.
            if (method === 'machines.roles.set') return { status: 'applied', policy: { active: ['sessions', 'broker', 'workspaces', 'relay'] }, metadataVersion: 1 };
            if (method === 'machines.agentIsolation.preview') return { kind: 'ready', policy: { enabled: false }, metadataVersion: 1,
                status: { kind: 'unavailable', code: 'provisioning_unavailable' }, plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0,
                    requiresAdmin: false, planDigest: 'physical-guest-plan' } };
            if (method === 'machines.agentIsolation.set') return { kind: 'accepted', operationId: 'physical-isolation', metadataVersion: 2,
                status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } };
            throw new Error(`Unexpected guest Machine RPC ${method}`);
        } },
    }, {
        runActionOperation: guestOperations.runActionOperation,
        presentUserActionConfirmation: async request => { guestConfirmations.push(request.actionId); return true; },
        approvalsCreate: async ({ request }) => {
            const artifactId = `mac36-approval-${approvals.size + 1}`;
            approvals.set(artifactId, StoredApprovalRequestSchema.parse(request));
            additionalConsent();
            return { artifactId };
        },
        approvalsGet: async ({ artifactId }) => approvals.get(artifactId) ?? null,
        approvalsUpdate: async ({ artifactId, request }) => {
            const current = approvals.get(artifactId); if (!current) throw new Error('Missing persisted approval');
            const transition = decideApprovalRequestTransition(current, request); if (!transition.ok) return transition;
            approvals.set(artifactId, StoredApprovalRequestSchema.parse(request)); return { ok: true };
        },
        isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
            machineId: guestRow.id, serverId: homeId, serverApiUrl: 'https://home.example',
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: guestRow.id }) }),
    });
    if (entry === 'admin') {
        // Standalone UI requests cross Home's authenticated Machine RPC boundary;
        // the direct installed adapter above is reserved for receiving admission.
        vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
            expect(request.machineId).toBe(guestRow.id);
            expect(request.method).toBe('machines.setup.adminAccess.set');
            guestNativeActions.push(request.method);
            return { status: 'applied', policy: { version: 1, mode: 'preauthorized' }, metadataVersion: 1 };
        });
    }
    const executor = createActionExecutor({
        runActionOperation: operations.runActionOperation,
        managedMachineAction: async ({ actionId, input, context }) => {
            const work = driver.execute(actionId, input, { requestId: 'mac36-create-request', context, signal: context.signal });
            entered = work;
            return await work;
        },
        approvalsCreate: async ({ request }) => { const artifactId = `mac36-approval-${approvals.size + 1}`;
            approvals.set(artifactId, StoredApprovalRequestSchema.parse(request)); return { artifactId }; },
        approvalsGet: async ({ artifactId }) => approvals.get(artifactId) ?? null,
        approvalsUpdate: async ({ artifactId, request }) => {
            const current = approvals.get(artifactId);
            if (!current) throw new Error('Missing persisted approval');
            const transition = decideApprovalRequestTransition(current, request);
            if (!transition.ok) return transition;
            approvals.set(artifactId, StoredApprovalRequestSchema.parse(request)); return { ok: true };
        },
        isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
            machineId: controller.machineId, serverId: homeId, serverApiUrl: 'https://home.example',
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: controller.machineId }) }),
    });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
        runtimeAccountId: accountId, serverId: homeId, serverIdentityId: homeId,
        defaultSessionMachineId: controller.machineId, externalActionTarget: { kind: 'machine' as const, machineId: controller.machineId },
        actionRequestId: 'mac36-create-request', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'machines.managed.acquire': { approvalRequiredSurfaces: ['cli'] } } }) };
    if (entry === 'enroll') {
        const prompts: string[] = [];
        const result = await createLiveRemoteSshBootstrapTaskKind().run({ params: {
            ssh: { target: 'happier@203.0.113.10', auth: 'agent', trustedHostKey: hostKeyLine },
            relay: { relayUrl: 'https://home.example', webappUrl: 'https://home.example' },
            homeTarget: resolveHomeTargetFromDescriptor({ descriptor: homeDescriptor, authority: 'current_connection' }),
            channel: 'dev', serviceMode: 'none', requireLocalApproval: true,
        }, emit() {}, prompt: async request => {
            prompts.push(request.kind);
            if (request.kind !== 'auth.approveRemoteProvisioning') throw new Error(`Unexpected standalone enrollment question ${request.kind}`);
            return { approved: true };
        } });
        expect(result).toMatchObject({ machineId: 'mac36-guest' });
        expect(prompts).toEqual(['auth.approveRemoteProvisioning']);
        expect(homeRequests.filter(path => path === '/v1/auth/response')).toHaveLength(1);
        expect(approvals.size).toBe(0);
        expect(vendorCreates).toBe(0);
        return;
    }
    if (entry === 'admin') {
        const directContext = { ...context, surface: 'ui' as const, defaultSessionMachineId: guestRow.id,
            externalActionTarget: { kind: 'machine' as const, machineId: guestRow.id }, actionRequestId: 'standalone-admin' };
        adminPhase = 'execute';
        const result = await guest.executor.execute('machines.setup.adminAccess.set', { serverId: homeId, machineId: guestRow.id,
            expectedMetadataVersion: 0, expectedAdminAccess: { version: 1, mode: 'none' },
            adminAccess: { version: 1, mode: 'preauthorized' }, comparison: 'field' }, directContext);
        adminPhase = 'execute_settled';
        if (!result.ok) throw new Error(JSON.stringify(result));
        expect(result).toMatchObject({ ok: true, result: { status: 'applied',
            policy: { version: 1, mode: 'preauthorized' }, metadataVersion: 1 } });
        adminPhase = 'wait_for_terminal';
        const settled = await guestOperations.handlers.getV2({ operationId: 'mac36-guest-policy-1', waitForTerminal: true });
        adminPhase = 'terminal_observed';
        expect(settled).toMatchObject({ kind: 'found', operation: {
            operationId: 'mac36-guest-policy-1', state: 'succeeded' } });
        expect(guestConfirmations).toEqual(['machines.setup.adminAccess.set']);
        expect(approvals.size).toBe(0);
        expect(guestNativeActions).toEqual(['machines.setup.adminAccess.set']);
        return;
    }
    expect(await executor.execute('machines.managed.acquire', input, context)).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created', artifactId: 'mac36-approval-1' } });
    expect(vendorCreates).toBe(0);
    const decision = await executor.execute('approval.request.decide', { artifactId: 'mac36-approval-1', decision: 'approve' },
        { ...context, actionRequestId: 'mac36-decision' });
    await Promise.race([entered?.catch(() => undefined), consentPresented]);
    expect(approvals.size + questions.size).toBe(1);
    await entered?.catch(() => undefined);
    await Promise.all(promptResponses);
    expect(promptResponseFailures).toEqual([]);
    const settled = await operations.handlers.getV2({ operationId: 'mac36-create', waitForTerminal: true });
    if (settled.kind === 'found') expect(settled.operation.error).toBeUndefined();
    expect(settled).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    expect(decision).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(vendorCreates).toBe(alreadyEnrolled ? 0 : 1);
    expect(machine.enrolledMachineId).toBe('mac36-guest');
    expect(guestNativeActions).toEqual(expect.arrayContaining(['machines.setup.adminAccess.set', 'machines.agentIsolation.preview', 'machines.agentIsolation.set']));
    expect(guestConfirmations).toEqual([]);
}
