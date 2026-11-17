import '../../../../ui/sources/dev/vitestSetup';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { AccountProfileSchema, AccountSettingsSchema, createActionExecutor, normalizeActionsSettingsV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedControllerReportV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { ApiMachineClient } from '@/api/apiMachine';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { prepareExternalActionRequesterAccountAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { fetchAccountProfile } from '@/api/accountProfile';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { configuration } from '@/configuration';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { fixture as nativeFixture, roleResult } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { prepareInstalledRequesterAccountActionContext, prepareRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionProjection';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '../externalActions/approvalExecutionAuthorization';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '../externalActions/daemonExternalActionTargetResolver';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';

// Only the physical listener is substituted; the primary startup constructor remains real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }) }));
// The live Account observation consumes the authenticated Home socket boundary.
vi.mock('socket.io-client', async importOriginal => (
    await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
const serverUrl = 'https://primary-isolation.invalid';
const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential transport'); };
const authority = createManagedProviderOperationAuthority({ purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
    selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
    projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
}) });

    it.each(['supported', 'failed', 'approved-own-account', 'approved-admitted-own-account'] as const)(
      'joins primary daemon Session isolation acquisition before Session birth (%s)', async nativeSandbox => {
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const accountCredentials = { token, encryption: null };
        const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'session.spawn_new': ['cli'], 'machines.managed.acquire': ['cli'] } } });
        const actionsSettingsProvider = createActionSettingsProvider({ accountSettings: settings });
        setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 1,
            loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(accountCredentials) });
        const directory = await mkdtemp(join(tmpdir(), 'happier-primary-isolation-'));
        const happyHomeDir = join(directory, 'home');
        let active: ApiMachineClient | null = null;
        const controller = { machineId: 'controller', installationId: 'installation-pending' };
        const serverId = 'primary-isolation';
        const launch = { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Local sandbox', choices: {} };
        const content = sealManagedMachinePresetContentV1({ presetId: 'isolation-preset', mode: 'plain',
            content: { v: 1, name: launch.name, launch } });
        const preset = { id: 'isolation-preset', homeId: 'srv_home', revision: 1, owner: { kind: 'account', accountId: 'account' },
            controller, contentEncryptionMode: 'plain', ...content };
        let machine = ManagedMachineV1Schema.parse({ id: 'isolation-resource', homeId: 'srv_home', custodianAccountId: 'account',
            controller, preset: { id: preset.id, revision: 1, contentEncryptionMode: 'plain' }, acquisitionMode: 'resource-bound',
            allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const roles: string[] = [];
        const nativeInputs: unknown[] = [];
        let releaseAcquire!: () => void;
        const acquireReleased = new Promise<void>(resolve => { releaseAcquire = resolve; });
        let notifyAcquireStarted!: () => void;
        const acquireStarted = new Promise<void>(resolve => { notifyAcquireStarted = resolve; });
        let notifyAcquireAccepted!: () => void;
        const acquireAccepted = new Promise<void>(resolve => { notifyAcquireAccepted = resolve; });
        onTestFinished(() => releaseAcquire());
        const base = nativeFixture({ privateNative: true, credentialPurposes: [] });
        const manifest = normalizePluginManifestV2({ ...base.manifest, contributes: { ...base.manifest.contributes,
            machineProvisioners: base.manifest.contributes.machineProvisioners.map(entry => ({ ...entry,
                sessionPlacement: { kind: 'controller-local', supportsAgentNativeSandbox: true } })) } });
        const admitted = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir,
            runtimeOptions: { scopedActionRuntime: { credentials: accountCredentials,
                actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings }) } },
            plugins: [{ manifest, files: { 'daemon.mjs': `let run;
                export function configure(callback) { run = callback; }
                export function activate(api) { for (const id of ${JSON.stringify(manifest.contributes.actions.map(action => action.id))}) {
                    api.actions.register(id, input => run(id, input));
                } }` }, instantiateCommittedModule(module) {
                if (typeof module.configure !== 'function') throw new Error('Missing native module configuration');
                module.configure(async (role: string, input: unknown) => {
                    roles.push(role); nativeInputs.push({ role, input });
                    if (role === 'acquire') {
                        notifyAcquireStarted(); await acquireReleased;
                        if (nativeSandbox === 'failed') throw new PluginError({ code: 'native_acquire_failed', message: 'Native acquisition failed' });
                    }
                    return roleResult(role);
                });
                return module;
            } }],
        });
        onTestFinished(() => admitted.dispose());
        // Home persistence, installed-machine RPC and native plugin effects are
        // system boundaries. Session defaults, admission, preset opening,
        // controller custody and native role qualification remain real.
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (new URL(String(request.url)).pathname === '/v1/home/governance/get') return { status: 200, data: { homeDefaults: null } };
            if ((request.method ?? 'GET').toUpperCase() === 'GET') return axios.get(String(request.url));
            throw new Error(`Unexpected isolation Home request ${String(request.url)}`);
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (new URL(String(url)).pathname.endsWith('/connected-accounts/purposes')) return { status: 200,
                data: { status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes',
                    value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) } } } };
            if (new URL(String(url)).pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (new URL(String(url)).pathname === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'account' }) };
            if (new URL(String(url)).pathname === '/v2/account/settings') return { status: 200,
                data: { content: { t: 'plain', v: settings }, version: 1 } };
            if (new URL(String(url)).pathname === ACCOUNT_SECURITY_PATH_V1) return { status: 200,
                data: AccountSecurityGetResponseV1Schema.parse({ v: 1, encryptionMode: 'plain', nativeEmail: null,
                    password: { status: 'not_enrolled', revision: null } }) };
            if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }) };
            if (new URL(String(url)).pathname === '/v1/machines/controller') return { status: 200, data: { machine: { id: 'controller', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
            throw new Error(`Unexpected isolation GET ${String(url)}`);
        });
        const isolationAdmissions: unknown[] = [];
        const isolationReports: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/execution-authorization')) {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                return { status: 200, data: { v: 1, token: 'isolation-root-proof', binding: { accountId: 'account', custodianAccountId: 'account',
                    authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain', serverIdentityId: 'srv_home',
                    ...controller, actionId: 'session.spawn_new', requestId: request.envelope.requestId,
                    target: { kind: 'machine', machineId: 'controller' }, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } } };
            }
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/presets/get')) return { status: 200, data: { kind: 'found', preset } };
            if (path.endsWith('/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
            if (path.endsWith('/admit')) {
                isolationAdmissions.push(body);
                return { status: 200, data: { machine, presetContent: content, replayed: false } };
            }
            if (path.endsWith('/current')) return { status: 200, data: { machine, current: true } };
            if (path.endsWith('/submit')) {
                machine = ManagedMachineV1Schema.parse({ ...machine, allocation: 'may-exist' });
                return { status: 200, data: { machine, submitted: true } };
            }
            if (path.endsWith('/report')) {
                isolationReports.push(body);
                const report = ManagedControllerReportV1Schema.parse(body);
                machine = ManagedMachineV1Schema.parse({ ...machine,
                    allocation: report.result.kind === 'bound' ? 'bound' : machine.allocation });
                return { status: 200, data: { machine } };
            }
            throw new Error(`Unexpected isolation POST ${path}`);
        });
        const nativeRpc = async (method: string) => {
            if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT || method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE)
                return { ok: true, directory: '/tmp', directoryKind: 'path', directoryCreationRequired: false, checkout: null };
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection: {
                v: 2, generation: 1, familiesById: {}, agentsById: { codex: { id: 'codex', title: 'Codex',
                    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true }, nativeSandbox: { off: true } } } } } };
            if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: {
                installed: true, version: '1.0', latestVersion: null, update: { supported: false, command: null },
                signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
                install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] } } } };
            throw new Error(`Unexpected isolation native RPC ${method}`);
        };
        vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(request => nativeRpc(request.method));
        vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(request => nativeRpc(request.method));
        const launched: unknown[] = [];
        const isolationChildResults: unknown[] = [];
        const isolationQualifications: boolean[] = [];
        let isolationFailure: unknown;
        const fixture = await createRequesterSessionControlRuntimeFixture({ happyHomeDir,
            activeServerDir: join(happyHomeDir, 'servers', serverId), serverId, serverHttpBaseUrl: serverUrl,
            machineId: 'controller', custodianAccountId: 'account', credentials: accountCredentials,
            connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
            registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
            getApiMachineForSessions: () => active, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
            beforeStartup: async () => {
                await writeStoredCredentialsForServerId(serverId, accountCredentials);
                const profile = await addServerProfile({ name: serverId, serverUrl, webappUrl: serverUrl });
                await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
                    v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: serverUrl, revision: 1,
                    endpoints: [{ kind: 'https', url: serverUrl }],
                } });
            },
            startup: { pluginRuntimeController: admitted.controller, managedProviderOperationAuthority: authority,
                resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'controller', serverIdentityId: 'srv_home' }) },
        });
        if (!fixture.installation) throw new Error('Missing installed primary daemon identity');
        controller.installationId = fixture.installation.installationId;
        preset.controller = controller;
        machine = ManagedMachineV1Schema.parse({ ...machine, controller });
        active = new ApiMachineClient(token, { id: 'controller', encryptionMode: 'plain', metadata: {
            host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: directory, happyHomeDir,
        }, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 });
        const operations = active;
        const managed = fixture.runtime.managedMachinePolicyAdapter;
        onTestFinished(async () => { await active?.shutdown(); await fixture.dispose(); await rm(directory, { recursive: true, force: true }); });
        const deps = createCliActionDeps({ credentials: accountCredentials, token, sessionId: '', mode: 'plain', ctx: null,
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
            externalActionMachineRequestPrivateKey: fixture.installation.privateKey, externalActionMachineInstallationId: controller.installationId,
            actionsSettingsProvider,
            savedSecretOperationContext: createInvocationSavedSecretOperationContextV1({ credentials: accountCredentials,
                serverHttpBaseUrl: serverUrl, isCurrent: async () => true, snapshot: { settings, settingsVersion: 1,
                    loadedAtMs: 1, settingsSecretsReadKeys: [], source: 'network', scopeKey: resolveAccountSettingsScopeKey(accountCredentials),
                    whenRefreshed: null, connectedPurposeCatalog: { status: 'ready', revision: 1, record: { key: 'purposes',
                        value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: [] }) } } } }),
            acquireSessionIsolationSandbox: async request => {
                try {
                    const resolveNativeSandbox = request.resolveNativeSandbox;
                    return await managed.acquireSessionIsolationSandbox({ ...request,
                        ...(resolveNativeSandbox ? { resolveNativeSandbox: supports => {
                            isolationQualifications.push(supports);
                            return resolveNativeSandbox(supports);
                        } } : {}),
                        executeSessionIsolationAcquire: async (input, context) => {
                            const result = await request.executeSessionIsolationAcquire(input, context);
                            isolationChildResults.push(result);
                            notifyAcquireAccepted();
                            return result;
                        },
                    });
                } catch (error) {
                    isolationFailure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack,
                        ...(error instanceof ManagedMachineControllerError ? { failureCause: error.failureCause, details: error.details } : {}) } : error;
                    throw error;
                }
            },
            sessionSpawnDirectTargetTransport: { machineId: 'controller', readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1,
                metadata: { isolationPolicyV1: { agentNativeSandboxEnabled: true,
                    configuredSandboxes: { local: { provisioner: launch.provider, presetId: preset.id } },
                    workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'local', lifecycle: 'fresh' },
                        botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } } } } }),
                prepare: async () => ({ ok: true, directory: '/tmp', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
                spawnedSession: { spawn: async request => { launched.push(request);
                    // The real Home refuses Session birth until its managed resource is bound.
                    if (machine.allocation !== 'bound') return { type: 'error', errorMessage: 'session-origin-forbidden' };
                    return { type: 'success', sessionId: 'created',
                    sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } }; },
                    resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) } },
            machineActionDirectTargetTransport: { machineId: 'controller', invoke: nativeRpc },
        });
        let approval: ApprovalRequest | undefined;
        let executor: ReturnType<typeof createActionExecutor>;
        const replayLifetime = new AbortController();
        onTestFinished(() => replayLifetime.abort());
        const resolveOrigin = async () => ({ machineId: 'controller', serverIdentityId: 'srv_home' });
        const prepareApprovalExecutionAuthorization = createDaemonApprovalExecutionAuthorizationPreparer({
            machineId: 'controller', serverId: configuration.activeServerId, serverBaseUrl: serverUrl,
            resolveCurrentMachineExecutionOriginContext: resolveOrigin, daemonWorkSignal: replayLifetime.signal,
            // Match the daemon's admitted requester policy provider: it reads
            // this own-Account Home through the real settings bootstrap owner.
            readAdmittedRequesterActionsSettings: async ({ signal }) => {
                const snapshot = await runWithServerHttpBaseUrl(serverUrl, () => bootstrapAccountSettingsContext({
                    credentials: accountCredentials, signal: signal ?? replayLifetime.signal,
                    mode: 'blocking', publication: 'invocation',
                }));
                return snapshot.settings.actionsSettingsV1;
            },
            prepareRequesterAccountContext: request => prepareInstalledRequesterAccountActionContext({ ...request,
                purpose: { kind: 'external_action' }, machineId: 'controller', serverId: configuration.activeServerId,
                serverHttpBaseUrl: serverUrl, ownCredentials: accountCredentials,
                resolveCurrentMachineExecutionOriginContext: resolveOrigin, createExecutor: () => executor,
            }),
        });
        const isApprovalExecutionOriginCurrent = createDaemonApprovalExecutionOriginCurrentness({
            accountId: 'account', machineId: 'controller', serverId: configuration.activeServerId,
            resolveCurrentMachineExecutionOriginContext: resolveOrigin,
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials: accountCredentials }),
            isAccountCurrent: async signal => (await fetchAccountProfile({ token, projection: 'self', signal })).id === 'account',
            listAccountApiTokens: unavailable, externalActionMachinePublicKey: fixture.installation.publicKey,
            verifyExternalExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                privateKey: fixture.installation!.privateKey, installationId: controller.installationId, serverHttpBaseUrl: serverUrl }),
        });
        executor = createActionExecutor({ ...deps, managedMachineAction: managed,
            approvalsGet: async () => approval ?? null,
            approvalsUpdate: async ({ request }) => { approval = request; return { ok: true }; },
            isApprovalExecutionOriginCurrent,
            prepareApprovalExecutionAuthorization,
            runActionOperation: request => operations.runActionOperation(request) });
        const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'isolation-spawn',
            executionTarget: { serverId: configuration.activeServerId, machineId: 'controller' }, directory: { kind: 'path', path: '/tmp' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, memoryEnabled: false,
            configuration: { mode: { value: null, updatedAtMs: 1 },
                model: { value: null, updatedAtMs: 1, selectionSource: 'inherited' },
                permissionIntent: { value: null, updatedAtMs: 1 }, options: {} } });
        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId: 'session.spawn_new', input,
            requestId: 'isolation-spawn', target: { kind: 'machine', machineId: 'controller' }, machineId: 'controller',
            accountId: 'account', accountEncryptionMode: 'plain', tokenEpochHint: 0, token, serverId: configuration.activeServerId,
            serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl, installationId: controller.installationId, privateKey: fixture.installation.privateKey });
        if (!authorization) throw new Error('Home did not admit the Session isolation root');
        const approvedReplay = nativeSandbox.startsWith('approved-');
        const requester = approvedReplay ? null : await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
            machineId: 'controller', installationId: controller.installationId, installationPrivateKey: fixture.installation.privateKey,
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
            ownCredentials: accountCredentials, isCurrent: async () => true, createExecutor: () => executor });
        if (!requester && !approvedReplay) throw new Error('The receiving host must open its admitted requester custody');
        onTestFinished(() => requester?.dispose());
        const rootContext: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
            actionsSettings: normalizeActionsSettingsV1(settings.actionsSettingsV1), runtimeAccountId: 'account', actionRequestId: 'isolation-spawn',
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home',
            ...(requester ? { externalActionExecutionAuthorization: requester.authorization }
                : nativeSandbox === 'approved-admitted-own-account' ? { externalActionExecutionAuthorization: authorization } : {}),
            signExternalActionApprovalInput: request => signExternalActionApprovalInputV1({ ...request,
                authorizationToken: authorization.token, privateKey: fixture.installation!.privateKey }),
            externalActionTarget: authorization.binding.target,
            originalActionEnvelope: { v: 1, requestId: 'isolation-spawn', target: authorization.binding.target, input } };
        if (approvedReplay) {
            // An unsigned historical root remains refused; new roots retain the
            // same Home admission and installation signature through approval.
            approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
                createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'session.spawn_new', actionArgs: input,
                summary: 'Start Session', decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' }, executionOriginV1:
                nativeSandbox === 'approved-admitted-own-account' ? buildApprovalExecutionOriginV1({
                    actionId: 'session.spawn_new', input, context: rootContext, targetSessionId: null,
                }) : {
                    v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                    serverId: configuration.activeServerId, serverIdentityId: 'srv_home', accountId: 'account',
                    machineId: 'controller', target: { kind: 'machine', machineId: 'controller' },
                    actionId: 'session.spawn_new', requestId: 'isolation-spawn',
                } });
            releaseAcquire();
            // The production CLI replay wrapper supplies this current captured
            // Account/Home policy; stored Artifact provenance does not carry it.
            const result = await executor.replayApprovedApprovalRequest({ artifactId: 'own-account-spawn', callerAuthority: 'present_user',
                currentAccount: { accountId: (await fetchAccountProfile({ token, projection: 'self' })).id,
                    serverId: configuration.activeServerId, serverIdentityId: 'srv_home',
                    actionsSettings: actionsSettingsProvider.getActionsSettings() } });
            if (nativeSandbox === 'approved-own-account') {
                expect(result).toMatchObject({ ok: true, result: { status: 'failed', execution: {
                    ok: false,
                } } });
                expect(isolationAdmissions).toEqual([]);
                expect(roles).toEqual([]);
                expect(launched).toEqual([]);
                return;
            }
            expect(result, JSON.stringify({ result, isolationFailure, isolationChildResults,
                isolationAdmissions, isolationReports, roles, nativeInputs })).toMatchObject({
                ok: true, result: { status: 'executed', execution: { ok: true, result: { type: 'success' } } },
            });
            expect(isolationAdmissions).toHaveLength(1);
            expect(isolationAdmissions[0]).toMatchObject({ originalActionEnvelope: rootContext.originalActionEnvelope });
            expect(roles.filter(role => role === 'acquire')).toHaveLength(1);
            expect(launched).toHaveLength(1);
            return;
        }
        const pendingResult = operations.observeActionExecution({ actionId: 'session.spawn_new', input, actionRequestId: 'isolation-spawn',
            actionContext: rootContext,
            execute: operation => executor.execute('session.spawn_new', input, { ...rootContext, ...operation }) });
        let settledWhileAcquiring = false;
        void pendingResult.then(() => { settledWhileAcquiring = true; }, () => { settledWhileAcquiring = true; });
        await Promise.all([acquireAccepted, acquireStarted]);
        // Let the admitted operation reach its existing completion join while
        // the native plugin boundary remains held.
        await new Promise<void>(resolve => setImmediate(resolve));
        const launchedWhileAcquiring = [...launched];
        const settledBeforeNativeCompletion = settledWhileAcquiring;
        releaseAcquire();
        const result = await pendingResult;
        const diagnostic = JSON.stringify({ result, isolationChildResults, isolationQualifications, isolationFailure,
            isolationAdmissions, isolationReports, roles, launched });
        expect(settledBeforeNativeCompletion, diagnostic).toBe(false);
        expect(launchedWhileAcquiring, diagnostic).toEqual([]);
        if (nativeSandbox === 'failed') {
            expect(result, diagnostic).toMatchObject({ ok: false, errorCode: 'spawn_failed',
                details: { type: 'error', code: 'spawn_failed',
                    launchError: { kind: 'launch_error', code: 'native_acquire_failed' } } });
            expect(launched).toEqual([]);
            return;
        }
        expect(result, diagnostic).toMatchObject({ ok: true, result: { type: 'success' } });
        expect(isolationAdmissions, diagnostic).toEqual([expect.objectContaining({ acquisitionMode: 'resource-bound' })]);
        expect(machine.acquisitionMode).toBe('resource-bound');
        // Bootstrap opens a transport carrier; installing a CLI or daemon would
        // also require native exec/file effects or enrollment HTTP, which the
        // real boundary recorders expose or reject.
        // This newly selected preset has no saved configuration facts: the
        // capture owner qualifies it once before the two native effects.
        expect(roles, diagnostic).toEqual(['check', 'options', 'acquire', 'bootstrap']);
        expect(nativeInputs, diagnostic).toContainEqual({ role: 'bootstrap', input: { resource: {} } });
        expect(machine.enrolledMachineId).toBeUndefined();
        expect(launched).toHaveLength(1);
        expect(launched[0]).toMatchObject({ nativeSandbox: 'on' });
    });
