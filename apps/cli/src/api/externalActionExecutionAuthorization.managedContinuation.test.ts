import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import nacl from 'tweetnacl';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, prepareExternalActionResponseV2, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { dispatchLocalManagedMachineSetup, dispatchLocalManagedMachineAdminAccess, dispatchManagedMachineSetup, dispatchManagedMachineSetupPlan, dispatchManagedSessionStart, dispatchManagedMachineAdminAccess, isReviewedMachineSetupPlanChild,
    dispatchLocalManagedMachineAgentIsolation, dispatchManagedMachineAgentIsolation, verifyManagedCreationAgentIsolationInput,
    verifyManagedCreationAdminAccessInput, createExternalActionMachineRpcExecution } from './externalActionExecutionAuthorization';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { encodeStoredCredentials, updateSettings, writeStoredCredentialsForServerId, readStoredCredentialsForServerId,
    removeStoredCredentialsForServerId, readStoredCredentials, sameStoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { withCliApiToken } from '@/auth/cliApiToken';
import { createRequesterSessionCredentialCustody, readRequesterSessionCredentialsForChild } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { projectExternalActionRequesterHttpAuthorization } from './externalActionExecutionAuthorization';
import { admitRequesterAccountActionContext, projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ManagedAcquireInputV1Schema, MachineSetupApplyInputV1Schema, readMachineSetupPlanChildInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { ApiMachineClient } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { prepareInstalledRequesterAccountActionContext, prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { openManagedCreationActionCodecV1, sealManagedCreationActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { HostReviewedParentV1Schema } from '@happier-dev/protocol/actions/actionExecutor';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import * as installationStore from '@/daemon/identity/store';
import { createMachineSetupPlanAction } from '@/machines/setup/machineSetupAction';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { invokeHostReviewedChildV1, readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { BOT_TEMPLATE_SETUP_APPLY_ROLE_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';

const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    serverIdentityId: 'srv_home', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 2 },
    actionId: 'machines.managed.acquire', requestId: 'creation', requestEnvelopeDigest: 'a'.repeat(43),
    machineId: 'controller', custodianAccountId: 'account', installationId: 'installation', target: { kind: 'machine', machineId: 'controller' },
    accountEncryptionMode: 'e2ee',
} });
const input = { executionTarget: { serverId: 'home-profile', machineId: 'guest' }, directory: { kind: 'managed' as const },
    agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } },
    initialInput: { text: 'private instructions' } };
const continuation = { managedId: 'managed', creationRequestId: 'creation', expectedIntentRevision: 3 };

describe('managed continuation through the ordinary public Action transport', () => {
    beforeEach(async () => {
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
            'home-profile': { id: 'home-profile', name: 'Home', serverUrl: 'https://home.example', webappUrl: 'https://home.example',
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'https://home.example',
                    revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] } },
        } }));
    });
    afterEach(() => vi.restoreAllMocks());

    it.each(['own', 'account-owned-source', 'foreign', 'foreign-surface-stamp', 'foreign-session-stamp', 'missing', 'undeclared'] as const)(
        'inherits managed parent review only from the Home-observed controller custody (%s)', async custody => {
        const currentness = await createRequesterCurrentnessSocketHarness();
        onTestFinished(() => currentness.close());
        const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
        const machine = new ApiMachineClient(credentials.token, { id: 'guest', encryptionMode: 'plain', metadataVersion: 0,
            daemonState: null, daemonStateVersion: 0, metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier',
                setup: { version: 1, revision: 3, sources: [{ kind: 'direct', setup: {} }], exclusions: [] } } });
        Reflect.set(machine, 'socket', createApiSessionSocketStub({ connected: true }));
        const artifacts: string[] = [];
        const askRequests: unknown[] = [];
        const executor = createCliActionExecutorHarness({ token: credentials.token, credentials, mode: 'plain', ctx: null,
            sessionId: '', serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example',
            actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false, accountSettings: AccountSettingsSchema.parse({
                actionsSettingsV1: { v: 1, actions: { 'machines.setup.plan': { approvalRequiredSurfaces: ['ui'] } } },
            }) }),
        }, { machineSetupPlan: createMachineSetupPlanAction({ apiMachine: machine, homeId: 'srv_home', machineId: 'guest' }),
            // Approval Artifact storage is an external boundary; policy, native
            // custody, issuer and the receiving Setup implementation remain real.
            approvalsCreate: async ({ request }) => { artifacts.push(request.actionId); askRequests.push(request); return { artifactId: 'child-ask' }; },
        }).executor;
        const read = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            if (url.endsWith('/v1/machines/controller')) {
                expect(config?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
                return { status: 200, data: { machine: {
                id: 'controller', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
                ...(custody === 'missing' ? {} : { access: { custodian: { accountId: custody === 'foreign' ? 'company' : 'account', displayName: 'Controller owner' },
                    role: 'manage', resourceMode: 'plain', accessState: 'ready' } }),
            } } };
            }
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account' } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
            expect(url).toBe('https://home.example/v1/account/encryption/currentness');
            return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 0,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        // Model the SOURCE-signed packet at the Home/network boundary. A
        // foreign plain SOURCE can lie about both parent custody and input;
        // neither assertion is authority for the guest's own Account.
        const parent = { ...root, binding: { ...root.binding, accountEncryptionMode: 'plain' as const } };
        const target = { kind: 'machine' as const, machineId: 'guest' };
        const planInput = getActionSpec('machines.setup.plan').inputSchema.parse({ homeId: 'srv_home', machineId: 'guest' });
        const reviewedParent = HostReviewedParentV1Schema.parse({ actionId: 'machines.managed.acquire', input: ManagedAcquireInputV1Schema.parse({
                enrollmentIdentity: { kind: 'existingUser', role: 'adopted' },
                selection: { kind: 'preset', homeId: 'srv_home', id: custody === 'foreign' ? 'substituted' : 'reviewed', revision: 1 },
                ...(custody === 'account-owned-source' ? {} : { controller: { machineId: 'controller', installationId: 'installation' } }),
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                ...(custody === 'undeclared' ? {} : { reviewedFacts: {
                    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
                    ...(custody === 'account-owned-source' ? {} : { controller: { machineId: 'controller', installationId: 'installation' } }), optionStatus: 'current',
                    billing: { location: 'unknown', stoppedBilling: 'unknown' }, prerequisites: [],
                    retentionCapabilities: { supportedIntents: ['start', 'delete'] }, retention: { kind: 'until-delete' },
                    wakeOnAcceptedMessage: false, preset: { id: custody === 'foreign' ? 'substituted' : 'reviewed', revision: 1 }, setup: {},
                } }),
            }) });
        const envelope = sealManagedCreationActionCodecV1({ authorization: parent, actionId: 'machines.setup.plan', continuation,
            ...(custody.startsWith('foreign') ? {} : { reviewedParent }),
            // Every stamp in this box is the SOURCE's claim about the guest Account.
            invocation: { caller: { kind: 'host' }, surface: custody === 'foreign-surface-stamp' ? 'cli' : 'ui', authority: 'present_user',
                ...(custody === 'foreign-session-stamp' ? { defaultSessionId: 'guest-account-session' } : {}),
                ...(custody === 'foreign' ? { reviewedParent, presentUserConfirmation: { actionId: 'machines.setup.plan',
                    inputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', planInput),
                    requestId: 'creation', accountId: 'account', serverId: 'srv_home', target } } : {}) },
            envelope: ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'creation', target,
                input: planInput }),
            recipient: { machineId: 'guest', installationId: 'guest-installation',
                installationPublicKey: Buffer.from(keyPair.publicKey).toString('base64url') }, randomBytes: nacl.randomBytes });
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...parent, binding: { ...parent.binding,
            actionId: 'machines.setup.plan', target, machineId: 'guest', installationId: 'guest-installation',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            managedContinuation: { ...continuation, ...(custody === 'account-owned-source' ? {} : { controller: { machineId: 'controller', installationId: 'installation' } }),
                acquireRequestEnvelopeDigest: parent.binding.requestEnvelopeDigest } } });
        const result = await executeExternalAction({ actionId: 'machines.setup.plan', envelope, executionAuthorization: authorization,
            principal: { accountId: 'account', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 2 } },
            currentMachineId: 'guest', currentAccountId: 'account', currentServerId: 'home-profile', currentServerHttpBaseUrl: 'https://home.example',
            currentInstallationId: 'guest-installation', externalActionMachineRequestPrivateKey: keyPair.secretKey,
            verifyExecutionAuthorization: async () => true, resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor,
            prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
                purpose: { kind: 'external_action' }, machineId: 'guest', installationId: 'guest-installation',
                installationPrivateKey: keyPair.secretKey, serverId: 'home-profile', serverIdentityId: 'srv_home',
                serverHttpBaseUrl: 'https://home.example', ownCredentials: credentials, isCurrent: async () => true, createExecutor: () => executor }),
        });
        if (custody === 'account-owned-source') {
            // The native SOURCE codec requires its parent controller pair.
            // Account-owned creation uses the existing local Account origin.
            expect(result).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
            expect(artifacts).toEqual([]);
            expect(read.mock.calls.filter(([url]) => url.endsWith('/v1/machines/controller'))).toHaveLength(0);
            return;
        }
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true, result: custody === 'own'
            ? { desiredRevision: 3 } : { kind: 'approval_request_created', artifactId: 'child-ask' } } } });
        expect(artifacts).toEqual(custody === 'own' ? [] : ['machines.setup.plan']);
        expect(read.mock.calls.filter(([url]) => url.endsWith('/v1/machines/controller'))).toHaveLength(custody.startsWith('foreign') ? 0 : 1);
        // A named requesting Session opens the delegated decision path, which an
        // Ask without one refuses; another Account's packet cannot choose it.
        expect(JSON.stringify(askRequests)).not.toContain('guest-account-session');
    });

    it.each([
        { actionId: 'machines.setup.plan', mode: 'e2ee', foreign: true },
        { actionId: 'session.spawn_new', mode: 'e2ee', foreign: true },
        { actionId: 'machines.setup.plan', mode: 'e2ee', foreign: false },
        { actionId: 'machines.setup.plan', mode: 'plain', foreign: false },
    ] as const)('decrypts a fresh $actionId child on the guest with $mode Account custody (foreign=$foreign)', async ({ actionId, mode, foreign }) => {
        const currentness = await createRequesterCurrentnessSocketHarness();
        onTestFinished(() => currentness.close());
        const secret = new Uint8Array(32).fill(61);
        const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`,
            encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
        const parent = { ...root, binding: { ...root.binding, custodianAccountId: foreign ? 'company' : 'account', accountEncryptionMode: mode } };
        const ownMaterial = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
        const guest = new ApiMachineClient(credentials.token, { id: 'guest', encryptionMode: 'plain', metadataVersion: 0,
            daemonState: null, daemonStateVersion: 0, metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier', setup: { version: 1, revision: 3,
                    sources: [{ kind: 'direct', setup: {} }], exclusions: [] } } });
        // Socket.IO connectivity is the genuine system boundary; metadata and
        // its setup projection remain owned by the real ApiMachineClient.
        Reflect.set(guest, 'socket', createApiSessionSocketStub({ connected: true }));
        expect(await guest.getMachineSetupDesiredSnapshot()).toMatchObject({ status: 'ready' });
        const setupExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
            machineSetupPlan: createMachineSetupPlanAction({ homeId: 'srv_home', machineId: 'guest', apiMachine: guest }) });
        const preparedDirectories: unknown[] = [];
        const spawnExecutor = createCliActionExecutorHarness({ token: credentials.token, credentials, mode,
            ctx: mode === 'plain' ? null : { encryptionVariant: 'legacy', encryptionKey: secret }, sessionId: '', serverId: 'home-profile', serverIdentityId: 'srv_home',
            serverHttpBaseUrl: 'https://home.example', sessionSpawnDirectTargetTransport: { machineId: 'guest',
                // The actual directory/Agent process boundary is unavailable in
                // this test; all Session authoring and Action admission is real.
                prepare: async request => { preparedDirectories.push(request.directory); return { ok: false, code: 'invalid_directory' }; },
                spawnedSession: { spawn: async () => { throw new Error('Unexpected native spawn'); },
                    resolveSpawnSessionByNonce: async () => { throw new Error('Unexpected native spawn lookup'); } } } }).executor;
        const executor = actionId === 'machines.setup.plan' ? setupExecutor : spawnExecutor;
        const read = vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account' } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
            expect(url).toBe('https://home.example/v1/account/encryption/currentness');
            return { status: 200, data: { mode, version: 1, settingsVersion: 0,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        const keys: Uint8Array[] = [];
        const receivedInputs: unknown[] = [];
        let preparedAccount: string | undefined;
        let receiverResult: unknown;
        let boundaryFailure: string | undefined;
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (url.endsWith('/controller/context')) return { status: 200, data: { requestId: 'creation',
                enrollmentInstallation: { machineId: 'guest', installationId: 'guest-installation',
                    installationPublicKey: Buffer.from(keyPair.publicKey).toString('base64url') } } };
            expect(url).toBe(`https://home.example/v1/actions/${actionId}`);
            try {
            const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root, token: 'home-child-root', binding: {
                ...root.binding, accountEncryptionMode: mode, actionId, machineId: 'guest', installationId: 'guest-installation', target: carrier.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(carrier.envelope),
                managedContinuation: { ...continuation, controller: { machineId: 'controller', installationId: 'installation' },
                    acquireRequestEnvelopeDigest: parent.binding.requestEnvelopeDigest } } });
            const codec = openManagedCreationActionCodecV1({ authorization, envelope: carrier.envelope, machineId: 'guest',
                installationId: 'guest-installation', serverIdentityId: 'srv_home', installationPrivateKey: keyPair.secretKey, includeInvocation: true });
            expect(codec).not.toBeNull();
            if (!codec) throw new Error('Child codec did not open');
            if (foreign) {
                expect(codec.material).not.toBeNull();
                if (!codec.material) throw new Error('Foreign child requires its established codec material');
                keys.push(codec.material.machineKey);
                expect(codec.material.machineKey).not.toEqual(ownMaterial.machineKey);
                expect(codec.material.machineKey).not.toEqual(material.machineKey);
            } else expect(codec.material).toBeNull();
            receivedInputs.push(carrier.envelope.v === 1 ? carrier.envelope.input : openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: carrier.envelope,
                binding: authorization.binding, material: codec.material ?? ownMaterial })?.input);
            const result = await executeExternalAction({ actionId, envelope: carrier.envelope,
                principal: { accountId: 'account', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 2 } },
                currentMachineId: 'guest', currentAccountId: 'account', currentServerId: 'home-profile',
                currentServerHttpBaseUrl: 'https://home.example', currentInstallationId: 'guest-installation', executionAuthorization: authorization,
                externalActionMachineRequestPrivateKey: keyPair.secretKey, verifyExecutionAuthorization: async () => true,
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor,
                prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
                    purpose: { kind: 'external_action' }, machineId: 'guest', installationId: 'guest-installation',
                    installationPrivateKey: keyPair.secretKey, serverId: 'home-profile', serverIdentityId: 'srv_home',
                    serverHttpBaseUrl: 'https://home.example', ownCredentials: credentials, isCurrent: async () => true,
                    createExecutor: context => { preparedAccount = context.authorization.binding.accountId;
                        expect(context.credentials.encryption).toEqual(credentials.encryption); return executor; } }),
            });
            receiverResult = { kind: result.kind, ...(result.kind === 'invalid_request' ? { errorCode: result.errorCode } : {}) };
            expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response' });
            if (result.kind !== 'response') throw new Error('Child receiver refused');
            return { status: 200, data: result.response };
            } catch (error) { boundaryFailure = error instanceof Error ? error.message : String(error); throw error; }
        });
        const dispatch = { continuation, authorization: parent, installationId: 'installation', privateKey: keyPair.secretKey,
            ...(mode === 'e2ee' && !foreign ? { material: ownMaterial } : {}),
            serverHttpBaseUrl: 'https://home.example', invocation: { caller: { kind: 'host' as const }, surface: 'ui' as const, authority: 'present_user' as const } };
        const sessionInput = SessionSpawnNewActionInputV2Schema.parse({ executionTarget: input.executionTarget, directory: input.directory,
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            connectedServices: { v: 2, bindingsByServiceId: {} } });
        const invoke = (includeInvocation = true, surface: 'ui' | 'cli' = 'ui') => actionId === 'machines.setup.plan'
            ? dispatchManagedMachineSetupPlan({ ...dispatch, ...(includeInvocation ? { invocation: { ...dispatch.invocation, surface } } : { invocation: undefined }), serverId: 'home-profile', input: { homeId: 'srv_home', machineId: 'guest' } })
            : dispatchManagedSessionStart({ ...dispatch, ...(includeInvocation ? { invocation: { ...dispatch.invocation, surface } } : { invocation: undefined }), input: sessionInput });
        const expected = actionId === 'machines.setup.plan' ? { ok: true, result: { desiredRevision: 3 } }
            : { ok: true, result: { type: 'error', code: 'spawn_failed', retryable: false,
                launchError: { code: 'invalid_directory' } } };
        const first = await invoke();
        expect(first, JSON.stringify({ first, receiverResult, preparedAccount, boundaryFailure })).toMatchObject(expected);
        expect(await invoke()).toMatchObject(expected);
        expect(keys).toHaveLength(foreign ? 2 : 0);
        if (foreign) expect(keys[0]).not.toEqual(keys[1]);
        expect(preparedAccount).toBe('account');
        expect(read.mock.calls.every(([url]) => !url.includes('/v1/machines/'))).toBe(true);
        if (actionId === 'session.spawn_new') {
            expect(preparedDirectories).toEqual([{ kind: 'managed' }, { kind: 'managed' }]);
            // The existing Session creation-namespace owner refuses an
            // unstamped UI host at account_automation authority, before Ask or
            // native I/O. The identical decoded input remains valid for the
            // explicit human invocation; this is not a malformed input refusal.
            expect(await invoke(false)).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters', requestId: 'creation' });
            expect(preparedDirectories).toHaveLength(2);
            expect(receivedInputs[2]).toEqual(receivedInputs[0]);
            expect(await invoke()).toMatchObject(expected);
            expect(preparedDirectories).toHaveLength(3);
            expect(await invoke(true, 'cli')).toMatchObject(expected);
            expect(preparedDirectories).toHaveLength(4);
        }
    });

    it('uses an installation-sealed fresh child codec rather than requester or controller Account material', async () => {
        const parent = { ...root, binding: { ...root.binding, custodianAccountId: 'company', accountEncryptionMode: 'plain' as const } };
        let delivered: unknown;
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (url === 'https://home.example/v1/machines/managed/controller/context') return { status: 200, data: {
                requestId: 'creation', enrollmentInstallation: { machineId: 'guest', installationId: 'guest-installation',
                    installationPublicKey: Buffer.from(keyPair.publicKey).toString('base64url') },
            } };
            delivered = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body).envelope;
            return { status: 409, data: { code: 'action_not_admitted', requestId: 'creation' } };
        });
        await dispatchManagedSessionStart({ input: { ...input, initialTriggers: undefined }, continuation, authorization: parent, material,
            installationId: 'installation', privateKey: keyPair.secretKey, serverHttpBaseUrl: 'https://home.example' });
        expect(delivered).toMatchObject({ v: 1, input: { initialInput: input.initialInput } });
        await dispatchManagedSessionStart({ input: { ...input, initialTriggers: undefined }, continuation, authorization: parent, material,
            invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
            installationId: 'installation', privateKey: keyPair.secretKey, serverHttpBaseUrl: 'https://home.example' });
        expect(delivered).toHaveProperty('managedCreationCodec.kind', 'installation_sealed_v1');
    });

    it.each(['machines.setup.plan', 'machines.setup.remove'] as const)(
        'opens the unchanged %s root Plan through canonical Machine transport with retained requester custody and refuses changed operands', async rootActionId => {
        const currentness = await createRequesterCurrentnessSocketHarness();
        onTestFinished(() => currentness.close());
        let role: 'manage' | 'use' = 'manage';
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            if (url === 'https://home.example/v1/machines/guest') {
                expect(config?.headers).toMatchObject({ Authorization: 'Bearer requester-token' });
                return { status: 200, data: { machine: { id: 'guest', kind: 'persistent', storageMode: 'plain',
                    installationId: 'guest-installation', installationPublicKey: Buffer.from(keyPair.publicKey).toString('base64'),
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    access: { custodian: { accountId: 'guest-owner', displayName: 'Guest owner' }, role,
                        resourceMode: 'plain', accessState: 'ready' } } } };
            }
            if (url === 'https://home.example/v1/account/profile') return { status: 200, data: { id: 'account' } };
            if (url === 'https://home.example/v2/account/settings') return { status: 200,
                data: { content: { t: 'plain', v: {} }, version: 1 } };
            expect(url).toBe('https://home.example/v1/account/encryption/currentness');
            return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null,
                contentKeyFingerprint: null, updatedAt: 1 } };
        });
        const sourceMachineId = rootActionId === 'machines.setup.remove' ? 'guest' : 'controller';
        const sourceInstallationId = rootActionId === 'machines.setup.remove' ? 'guest-installation' : 'installation';
        const target = { kind: 'machine' as const, machineId: sourceMachineId };
        const child = { homeId: 'srv_home', machineId: 'guest', mode: 'effects' as const,
            sources: [{ kind: 'direct' as const, setup: { scripts: [{ body: 'echo reviewed' }] } }],
            ...(rootActionId === 'machines.setup.remove' ? { removeItemKeys: [] } : {}) };
        const rootInput = rootActionId === 'machines.setup.remove'
            ? { homeId: 'srv_home', machineId: sourceMachineId, sources: child.sources,
                removeItemKeys: [], desiredRevision: 3, removalPlans: [] }
            : { homeId: 'srv_home', machineId: sourceMachineId, targets: [child] };
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'plan', target,
            input: getActionSpec(rootActionId).inputSchema.parse(rootInput) });
        expect(readMachineSetupPlanChildInputV1({ rootActionId, rootInput: envelope.input,
            machineId: child.machineId, input: child })).toEqual(child);
        const originalEnvelope = structuredClone(envelope);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root, binding: { ...root.binding,
            actionId: rootActionId, machineId: sourceMachineId, installationId: sourceInstallationId,
            custodianAccountId: rootActionId === 'machines.setup.remove' ? 'guest-owner' : root.binding.custodianAccountId,
            requestId: envelope.requestId, accountEncryptionMode: 'plain',
            target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const admitted = await admitRequesterAccountActionContext({ authorization, serverIdentityId: 'srv_home',
            serverId: 'home-profile', credentials: { token: 'requester-token', encryption: null },
            serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true });
        if (!admitted) throw new Error('Requester custody was not established');
        onTestFinished(() => admitted.dispose());
        const request = { authorization: admitted.authorization, envelope, actionId: 'machines.setup.plan', machineId: 'guest',
            params: child, method: RPC_METHODS.MACHINE_SETUP_PLAN };
        expect(await isReviewedMachineSetupPlanChild(request)).toBe(true);
        expect(await isReviewedMachineSetupPlanChild({ ...request, params: { ...child, homeId: 'other' } })).toBe(false);
        expect(await isReviewedMachineSetupPlanChild({ ...request, params: { ...child,
            sources: [{ ...child.sources[0]!, setup: { scripts: [{ body: 'echo changed' }] } }] } })).toBe(false);
        expect(await isReviewedMachineSetupPlanChild({ ...request, envelope: { ...envelope,
            input: { ...rootInput, homeId: 'other' } } })).toBe(false);
        expect(await isReviewedMachineSetupPlanChild({ ...request, actionId: 'machines.setup.apply' })).toBe(false);
        const packets: unknown[] = [];
        const transportTokens: unknown[] = [];
        currentness.server.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, (packet, acknowledge) => {
            packets.push(packet);
            transportTokens.push(socket.handshake.auth.token);
            acknowledge({ ok: true, result: { desiredRevision: 3, sources: child.sources, exclusions: [], support: [], recipePlans: [] } });
        }));
        // Distinct daemon custody makes a missing requester selection observable;
        // no transport/domain owner is replaced beneath these public dependencies.
        const daemonCredentials = { token: 'daemon-owner-token', encryption: null };
        const deps = createCliActionDeps({ token: daemonCredentials.token, credentials: daemonCredentials, sessionId: '',
            serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example',
            externalActionMachineInstallationId: sourceInstallationId, externalActionMachineRequestPrivateKey: keyPair.secretKey });
        const invoke = (input = child) => runWithServerHttpBaseUrl('https://home.example', () => deps.machineSetupPlan!({ input, context: {
            surface: 'rpc', authority: 'present_user', serverId: 'home-profile',
            externalActionExecutionAuthorization: admitted.authorization, externalActionTarget: target, originalActionEnvelope: envelope } }));
        await expect(invoke({ ...child, sources: [{ ...child.sources[0]!, setup: { scripts: [{ body: 'echo changed' }] } }] }))
            .rejects.toMatchObject({ code: 'machine_target_not_current' });
        expect(packets).toEqual([]);
        expect(await invoke()).toMatchObject({ desiredRevision: 3 });
        expect(packets).toEqual([expect.objectContaining({ originalActionEnvelope: envelope,
            method: `guest:${RPC_METHODS.MACHINE_SETUP_PLAN}`,
            externalActionExecution: expect.objectContaining({ installationId: sourceInstallationId,
                authorization: expect.objectContaining({ requesterAccountContext: expect.any(Object) }) }) })]);
        expect(transportTokens).toEqual([admitted.credentials.token]);
        expect(envelope).toEqual(originalEnvelope);
        role = 'use';
        await expect(invoke()).rejects.toMatchObject({ code: 'machine_target_not_current' });
        expect(packets).toHaveLength(1);
        expect(envelope).toEqual(originalEnvelope);
    });

    it.each([['machines.setup.plan', 'plain'], ['machines.setup.plan', 'e2ee'],
        ['machines.setup.remove', 'plain'], ['machines.setup.remove', 'e2ee']] as const)(
        'delivers the unchanged %s root Plan to real receiving setup owners (%s)', async (rootActionId, mode) => {
        const currentness = await createRequesterCurrentnessSocketHarness();
        onTestFinished(() => currentness.close());
        const secret = new Uint8Array(32).fill(48);
        const credentials = { token: 'requester-token', encryption: mode === 'e2ee'
            ? { type: 'legacy' as const, secret } : null };
        // Only Home HTTP and the installed key file are substituted. Recipient
        // custody, root opening, RPC/Action admission and ApiMachine Plan stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account' } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
            expect(url).toBe('https://home.example/v1/account/encryption/currentness');
            return { status: 200, data: { mode, version: 1, settingsVersion: 0,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (url.endsWith('/admission/verify')) return { status: 200, data: { v: 1, ok: true } };
            expect(url).toMatch(/\/verify$/u);
            return { status: 200, data: { ok: true } };
        });
        const targets = ['guest', 'second'].map(machineId => ({ homeId: 'srv_home', machineId, mode: 'effects' as const,
            sources: [{ kind: 'direct' as const, setup: { scripts: [{ body: `echo ${machineId}`, affects: 'none' as const }],  } }],
            ...(rootActionId === 'machines.setup.remove' ? { removeItemKeys: [] } : {}) }));
        const installed = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync');
        for (const [index, child] of targets.entries()) {
            const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(51 + index));
            const installation = { version: 1 as const, createdAt: 1, installationId: `${child.machineId}-installation`,
                publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') };
            installed.mockReturnValue(installation);
            const sourceMachineId = rootActionId === 'machines.setup.remove' ? child.machineId : 'controller';
            const sourceInstallationId = rootActionId === 'machines.setup.remove' ? installation.installationId : 'installation';
            const target = { kind: 'machine' as const, machineId: sourceMachineId };
            const binding = { serverIdentityId: 'srv_home', accountId: 'account',
                authentication: { kind: 'account' as const, tokenEpoch: 2 }, actionId: rootActionId,
                requestId: `native-plan-${mode}`, target };
            const input = getActionSpec(rootActionId).inputSchema.parse(rootActionId === 'machines.setup.remove'
                ? { homeId: 'srv_home', machineId: child.machineId, sources: child.sources,
                    desiredRevision: 3, removeItemKeys: [], removalPlans: [] }
                : { homeId: 'srv_home', machineId: 'controller', targets });
            expect(readMachineSetupPlanChildInputV1({ rootActionId, rootInput: input,
                machineId: child.machineId, input: child })).toEqual(child);
            const envelope = mode === 'plain' ? ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId, target, input })
                : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input,
                    material: { type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) }, randomBytes: nacl.randomBytes });
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root, binding: { ...root.binding,
                ...binding, machineId: sourceMachineId, installationId: sourceInstallationId,
                custodianAccountId: rootActionId === 'machines.setup.remove' ? 'guest-owner' : root.binding.custodianAccountId,
                accountEncryptionMode: mode, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
            const machine = new ApiMachineClient('guest-owner-token', { id: child.machineId, encryptionMode: 'plain', metadataVersion: 0,
                daemonState: null, daemonStateVersion: 0, metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier',
                    setup: { version: 1, revision: 3, sources: [{ kind: 'direct', setup: {} }], exclusions: [] } } });
            Reflect.set(machine, 'socket', createApiSessionSocketStub({ connected: true }));
            const before = await machine.getMachineSetupDesiredSnapshot();
            expect(before).toMatchObject({ status: 'ready', policy: { revision: 3 } });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                machineSetupPlan: createMachineSetupPlanAction({ homeId: 'srv_home', machineId: child.machineId, apiMachine: machine }) });
            const diagnostics: unknown[] = [];
            const rpc = new RpcHandlerManager({ scopePrefix: child.machineId, localMachineId: child.machineId, encryptionMode: 'plain',
                logger: (_message, detail) => { diagnostics.push(detail); },
                authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: child.machineId,
                    resolveCustodianAccountId: async () => 'guest-owner', resolveInstallationId: () => installation.installationId,
                    verifyMachineAdmission: request => verifyMachineRpcAdmissionCurrent({ ...request, privateKey: keys.secretKey,
                        daemonToken: 'guest-owner-token', serverHttpBaseUrl: 'https://home.example' }) }),
                prepareRequesterAccountContext: request => prepareInstalledRequesterAccountActionContext({ ...request,
                    purpose: request.purpose ?? { kind: 'external_action' }, machineId: child.machineId, serverId: 'home-profile',
                    serverHttpBaseUrl: 'https://home.example',
                    resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: child.machineId, serverIdentityId: 'srv_home' }),
                    createExecutor: () => executor }) });
            registerActionSpecRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor,
                actionIds: ['machines.setup.plan'], targetMachineId: child.machineId, defaultMachineTarget: true });
            const receive = async (params = child, role: 'manage' | 'use' = 'manage') => {
                const method = `${child.machineId}:${RPC_METHODS.MACHINE_SETUP_PLAN}`;
                const sealed = sealExternalActionRequesterAccountContextV1({ authorization,
                    purpose: { kind: 'machine_rpc', method: RPC_METHODS.MACHINE_SETUP_PLAN, params,
                        recipient: { machineId: child.machineId, installationId: installation.installationId } },
                    credentials: { secret: null, ...encodeStoredCredentials(credentials) },
                    installationPublicKey: keys.publicKey, randomBytes: nacl.randomBytes });
                const execution = createExternalActionMachineRpcExecution({ context: {
                    externalActionExecutionAuthorization: sealed, externalActionTarget: target }, effectActionId: 'machines.setup.plan',
                    installationId: sourceInstallationId, method, requestId: 'native-plan-child', params,
                    privateKey: rootActionId === 'machines.setup.remove' ? keys.secretKey : keyPair.secretKey });
                if (!execution) throw new Error('Missing exact source signature');
                return rpc.handleRequest({ method, params, requestId: 'native-plan-child', originalActionEnvelope: envelope,
                    callerAuthority: 'present_user', callerInputAuthorization: sealed,
                    workspaceSyncSourceExecution: { method, params: StrictJsonValueSchema.parse(params), requestId: 'native-plan-child',
                        originalActionEnvelope: envelope, externalActionExecution: execution },
                    machineAdmission: { actorAccountId: 'account', custodianAccountId: 'guest-owner', machineId: child.machineId,
                        installationId: installation.installationId, role, encryptionMode: 'plain' } });
            };
            expect(await receive(), JSON.stringify(diagnostics)).toMatchObject({ desiredRevision: 3, sources: child.sources, recipePlans: [] });
            expect(await receive({ ...child, sources: [{ ...child.sources[0]!, setup: { scripts: [{ body: 'echo changed', affects: 'none' }],  } }] }))
                .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(await receive(child, 'use')).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(await machine.getMachineSetupDesiredSnapshot()).toEqual(before);
        }
    });

    it.each([true, false])('seals the administrator child with the existing creation correlation and verifies its retained policy before target execution (controller=%s)', async controllerPresent => {
        const policy = { version: 1 as const, mode: 'ask' as const, administratorUsername: 'operator' };
        const request = { serverId: 'srv_home', machineId: 'guest', expectedMetadataVersion: 0,
            expectedAdminAccess: { version: 1 as const, mode: 'none' as const }, adminAccess: policy, comparison: 'field' as const };
        const row = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            controller: controllerPresent ? { machineId: 'controller', installationId: 'installation' } : undefined,
            launch: { provider: { pluginId: 'native.provisioner', localId: 'guest' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'native.provisioner', localId: 'guest' }, schemaVersion: 1, value: { id: 'paid-guest' } },
            allocation: 'bound', creationState: 'active', enrolledMachineId: 'guest', desired: 'start', desiredWhen: 'now', intentRevision: 3,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget',
                adminAccessAtCreation: 'ask', administrator: { username: 'operator' } } };
        const child = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root, binding: { ...root.binding,
            actionId: 'machines.setup.adminAccess.set', machineId: 'guest', installationId: 'guest-installation',
            target: { kind: 'machine', machineId: 'guest' }, managedContinuation: { ...continuation,
                controller: row.controller, acquireRequestEnvelopeDigest: root.binding.requestEnvelopeDigest } } });
        const context = { surface: 'cli' as const, actionRequestId: 'creation', externalActionExecutionAuthorization: child,
            externalActionTarget: child.binding.target, signal: new AbortController().signal };
        let bootstrapRetry = false;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (url.endsWith('/v1/actions/machines.setup.adminAccess.set')) {
                const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(carrier.managedContinuation).toEqual(continuation);
                expect(carrier.envelope.requestId).toBe(bootstrapRetry ? 'retry' : 'creation');
                expect(carrier.envelope).not.toHaveProperty('sessionSpawnAdmission');
                if (carrier.envelope.v !== 2) throw new Error('Expected sealed administrator policy');
                const binding = { serverIdentityId: 'srv_home', accountId: 'account',
                    actionId: 'machines.setup.adminAccess.set', requestId: bootstrapRetry ? 'retry' : 'creation', target: { kind: 'machine' as const, machineId: 'guest' },
                    authentication: { kind: 'account' as const, tokenEpoch: 2 } };
                expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: carrier.envelope, material, binding })?.input).toEqual(request);
                expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
                return { status: 200, data: prepareExternalActionResponseV2({ binding, request: carrier.envelope, material,
                    randomBytes: length => new Uint8Array(length).fill(4), executedMachineId: 'guest',
                    execution: { ok: true, result: { status: 'applied', policy, metadataVersion: 1 } } }).response };
            }
            expect(url).toBe('https://home.example/v1/machines/managed/actions/get');
            expect(body).toEqual({ homeId: 'srv_home', managedId: 'managed' });
            expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: child.token });
            return { status: 200, data: row };
        });
        expect(await dispatchManagedMachineAdminAccess({ input: request, serverId: 'home-profile', continuation, authorization: root,
            material, installationId: 'installation', privateKey: keyPair.secretKey, serverHttpBaseUrl: 'https://home.example' }))
            .toMatchObject({ ok: true, result: { status: 'applied' } });
        const args = { request, context, serverIdentityId: 'srv_home', daemonToken: 'unused-host-credential',
            privateKey: keyPair.secretKey, installationId: 'guest-installation', serverHttpBaseUrl: 'https://home.example' };
        expect(await verifyManagedCreationAdminAccessInput(args)).toBe(true);
        post.mockResolvedValueOnce({ status: 200, data: { ...row, controller: controllerPresent ? undefined
            : { machineId: 'controller', installationId: 'installation' } } });
        expect(await verifyManagedCreationAdminAccessInput(args)).toBe(false);
        bootstrapRetry = true;
        const retryRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root,
            binding: { ...root.binding, actionId: 'machines.managed.bootstrap.retry', requestId: 'retry' } });
        expect(await dispatchManagedMachineAdminAccess({ input: request, serverId: 'home-profile', continuation, authorization: retryRoot,
            material, installationId: 'installation', privateKey: keyPair.secretKey, serverHttpBaseUrl: 'https://home.example' }))
            .toMatchObject({ ok: true, result: { status: 'applied' } });
        const retryChild = ExternalActionExecutionAuthorizationV1Schema.parse({ ...child,
            binding: { ...child.binding, requestId: 'retry' } });
        expect(await verifyManagedCreationAdminAccessInput({ ...args,
            context: { ...context, actionRequestId: 'retry', externalActionExecutionAuthorization: retryChild } })).toBe(true);
        bootstrapRetry = false;
        expect(await verifyManagedCreationAdminAccessInput({ ...args, request: { ...request,
            adminAccess: { ...policy, administratorUsername: 'different' } } })).toBe(false);
        expect(await verifyManagedCreationAdminAccessInput({ ...args, request: { ...request, machineId: 'other-guest' } })).toBe(false);
        expect(await verifyManagedCreationAdminAccessInput({ ...args, request: { ...request, serverId: 'srv_other' } })).toBe(false);
        post.mockResolvedValueOnce({ status: 200, data: { ...row, intentRevision: 4 } });
        expect(await verifyManagedCreationAdminAccessInput(args)).toBe(false);
        const isolationRequest = { serverId: 'srv_home', machineId: 'guest', enabled: true,
            expectedMetadataVersion: 2, expectedPolicy: { enabled: true }, expectedPlanDigest: 'reviewed-effects' };
        const isolationChild = ExternalActionExecutionAuthorizationV1Schema.parse({ ...child,
            binding: { ...child.binding, actionId: 'machines.agentIsolation.set', requestId: 'retry' } });
        const isolationContext = { ...context, actionRequestId: 'retry', externalActionExecutionAuthorization: isolationChild };
        const isolationArgs = { ...args, actionId: 'machines.agentIsolation.set' as const, request: isolationRequest, context: isolationContext };
        expect(await verifyManagedCreationAgentIsolationInput(isolationArgs)).toBe(true);
        expect(await verifyManagedCreationAgentIsolationInput({ ...isolationArgs, request: { ...isolationRequest, enabled: false } })).toBe(false);
        post.mockResolvedValueOnce({ status: 200, data: { ...row, enrollmentIdentity: { kind: 'existingUser', role: 'adopted' } } });
        expect(await verifyManagedCreationAgentIsolationInput(isolationArgs)).toBe(false);
        const currentness = await createRequesterCurrentnessSocketHarness();
        try {
            let mutations = 0;
            let rpcResult: unknown = { status: 'applied', policy, metadataVersion: 2 };
            currentness.server.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, (_packet, acknowledge) => {
                mutations++;
                acknowledge({ ok: true, result: rpcResult });
            }));
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url === 'https://home.example/v1/machines/guest') return { status: 200, data: { machine: {
                    id: 'guest', kind: 'persistent', storageMode: 'plain', installationId: 'guest-installation',
                    installationPublicKey: Buffer.from(keyPair.publicKey).toString('base64'),
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                } } };
                expect(url).toBe('https://home.example/v1/account/encryption/currentness');
                return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null,
                    contentKeyFingerprint: null, updatedAt: 1 } };
            });
            const http = await projectExternalActionRequesterHttpAuthorization({ authorization: { ...child,
                binding: { ...child.binding, accountEncryptionMode: 'plain' } }, serverId: 'home-profile', serverIdentityId: 'srv_home',
                serverHttpBaseUrl: 'https://home.example', target: child.binding.target, installationId: 'guest-installation',
                privateKey: keyPair.secretKey, isCurrent: async () => true });
            if (!http) throw new Error('Exact Home projection was not established');
            const credentials = { token: 'requester-token', encryption: null };
            const admitted = await projectRequesterAccountActionAuthorization({ authorization: http, serverIdentityId: 'srv_home',
                bootstrap: { credentials, serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true,
                    attribution: { serverId: 'home-profile', accountId: 'account', machineId: 'guest', installationId: 'guest-installation' } } });
            if (!admitted) throw new Error('Requester custody was not established');
            const deps = createCliActionDeps({ token: credentials.token, credentials, mode: 'plain', ctx: null, sessionId: '', serverId: 'home-profile',
                serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example',
                externalActionMachineInstallationId: 'guest-installation', externalActionMachineRequestPrivateKey: keyPair.secretKey });
            const invoke = (value: typeof request) => deps.machineAdminAccessAction!({ actionId: 'machines.setup.adminAccess.set',
                input: value, context: { ...context, serverId: 'home-profile', externalActionExecutionAuthorization: admitted }, signal: context.signal });
            expect(await invoke({ ...request, adminAccess: { ...policy, administratorUsername: 'different' } }))
                .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
            expect(mutations).toBe(0);
            expect(await invoke(request)).toMatchObject({ status: 'applied' });
            expect(mutations).toBe(1);
            const isolationHttp = await projectExternalActionRequesterHttpAuthorization({ authorization: { ...isolationChild,
                binding: { ...isolationChild.binding, accountEncryptionMode: 'plain' } }, serverId: 'home-profile', serverIdentityId: 'srv_home',
                serverHttpBaseUrl: 'https://home.example', target: isolationChild.binding.target, installationId: 'guest-installation',
                privateKey: keyPair.secretKey, isCurrent: async () => true });
            if (!isolationHttp) throw new Error('Isolation Home projection was not established');
            const isolationAdmitted = await projectRequesterAccountActionAuthorization({ authorization: isolationHttp, serverIdentityId: 'srv_home',
                bootstrap: { credentials, serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true,
                    attribution: { serverId: 'home-profile', accountId: 'account', machineId: 'guest', installationId: 'guest-installation' } } });
            if (!isolationAdmitted) throw new Error('Isolation requester custody was not established');
            rpcResult = { kind: 'accepted', operationId: 'isolation-operation', metadataVersion: 3,
                status: { kind: 'applying', phase: 'runtime_replacement' } };
            const invokeIsolation = (value: typeof isolationRequest) => deps.machineAgentIsolationAction!({ actionId: 'machines.agentIsolation.set',
                input: value, context: { ...isolationContext, serverId: 'home-profile', externalActionExecutionAuthorization: isolationAdmitted }, signal: context.signal });
            expect(await invokeIsolation({ ...isolationRequest, enabled: false })).toMatchObject({ ok: false, errorCode: 'managed_enrollment_policy_unverified' });
            expect(mutations).toBe(1);
            expect(await invokeIsolation(isolationRequest)).toMatchObject({ kind: 'accepted', status: { kind: 'applying' } });
            expect(mutations).toBe(2);
            post.mockClear();
            expect(await verifyManagedCreationAdminAccessInput({ ...args, context: { surface: 'cli' } })).toBe(true);
            expect(post).not.toHaveBeenCalled(); // Ordinary policy Actions do no creation-row read.
        } finally { await currentness.close(); }
    });

    it.each(['action_not_admitted', 'action_outcome_unknown', 'target_not_local', 'target_unavailable'] as const)('preserves managed child correlation for %s and refuses a mismatched reply', async code => {
        const response = (id: string) => {
            const refusal = projectExternalActionHttpError(code, id);
            return { status: refusal.statusCode, data: { ...refusal.payload,
                ...(code === 'action_not_admitted' ? { failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null } } : {}),
                ...(code === 'target_not_local' ? { phase: 'target_installation' } : {}),
                ...(code === 'target_unavailable' ? { diagnostic: { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' } } : {}),
                ...(code === 'action_outcome_unknown' ? { diagnostic: { reason: 'daemon_rpc_refused', errorCode: 'RPC_FORBIDDEN' } } : {}) } };
        };
        vi.spyOn(axios, 'post').mockResolvedValueOnce(response(root.binding.requestId)).mockResolvedValueOnce(response('other-request'));
        const request = { input, continuation, authorization: root, material, installationId: 'installation',
            privateKey: keyPair.secretKey, serverHttpBaseUrl: 'https://home.example', targetMachineId: 'guest' };
        expect(await dispatchManagedSessionStart(request))
            .toMatchObject({ ok: false, errorCode: code,
                ...(code === 'action_not_admitted' ? { failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null } } : {}),
                details: code === 'target_unavailable'
                ? { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' }
                : { requestId: root.binding.requestId,
                ...(code === 'target_not_local' ? { phase: 'target_installation' } : {}),
                ...(code === 'action_outcome_unknown' ? { diagnostic: { reason: 'daemon_rpc_refused', errorCode: 'RPC_FORBIDDEN' } } : {}) } });
        expect(await dispatchManagedSessionStart(request)).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    });

    it.each(['setup', 'adminAccess', 'isolationPreview', 'isolationSet'] as const)('originates %s for a genuine local host creation through the existing exact Account signer and refuses borrowed origins', async kind => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 2,
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
        const installedProfile = `local-creation-${randomUUID()}`;
        onTestFinished(() => removeStoredCredentialsForServerId(installedProfile));
        await writeStoredCredentialsForServerId(installedProfile, { token, encryption: null });
        const credentials = await readStoredCredentialsForServerId(installedProfile);
        if (!credentials) throw new Error('Expected persisted local terminal credentials');
        const setup = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: 'guest', targets: [{ homeId: 'srv_home', machineId: 'guest', sources: [
            { kind: 'accountPreset', presetId: 'preset', presetRevision: 4, setup: { scripts: [{ body: 'echo admitted', affects: 'none' }],  } },
            { kind: 'direct', setup: {} },
        ], desiredRevision: 0, recipePlans: [] }] });
        const isolation = { serverId: 'srv_home', machineId: 'guest', enabled: true };
        const isolationSet = { ...isolation, expectedMetadataVersion: 0, expectedPolicy: { enabled: false }, expectedPlanDigest: 'reviewed-isolation' };
        const adminAccess = { serverId: 'srv_home', machineId: 'guest', expectedMetadataVersion: 0,
            expectedAdminAccess: { version: 1 as const, mode: 'none' as const },
            adminAccess: { version: 1 as const, mode: 'preauthorized' as const }, comparison: 'field' as const };
        const actionId = kind === 'setup' ? 'machines.setup.apply' : kind === 'adminAccess' ? 'machines.setup.adminAccess.set'
            : kind === 'isolationPreview' ? 'machines.agentIsolation.preview' : 'machines.agentIsolation.set';
        const localInput = kind === 'setup' ? setup : kind === 'adminAccess' ? adminAccess : kind === 'isolationPreview' ? isolation : isolationSet;
        const isIsolation = kind === 'isolationPreview' || kind === 'isolationSet';
        const result = kind === 'setup' ? { operationId: 'actual-setup' }
            : kind === 'adminAccess' ? { status: 'applied', policy: adminAccess.adminAccess, metadataVersion: 1 }
            : kind === 'isolationSet' ? { kind: 'accepted', operationId: 'actual-isolation', metadataVersion: 1,
                status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } }
            : { kind: 'unavailable', status: { kind: 'unavailable', code: 'provisioning_unavailable' } };
        const machine = { id: 'guest', kind: 'persistent', active: true, installationId: 'guest-installation', revokedAt: null,
            replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/v1/account/encryption')
            ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
            : url.endsWith('/v1/machines/guest') ? { status: 200, data: { machine } } : { status: 200, data: [machine] });
        let delivered = 0;
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
            if (kind === 'adminAccess') {
                // Ordinary own-Account policy writes use the canonical raw
                // envelope; setup/isolation keep their exact proof carrier.
                expect(ExternalActionRequestEnvelopeSchema.parse(body)).toEqual({ v: 1, requestId: 'creation',
                    target: { kind: 'machine', machineId: 'guest' }, input: localInput });
                expect(url).toBe(`https://home.example/v1/actions/${actionId}`);
                delivered++;
                return { status: 200, data: { v: 1, actionId, requestId: 'creation', execution: { ok: true, result } } };
            }
            const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            if (isIsolation && url.endsWith('/execution-authorization')) expect(carrier.managedContinuation).toEqual(continuation);
            else expect(carrier).not.toHaveProperty('managedContinuation');
            expect(carrier.envelope).toMatchObject({ v: 1, requestId: 'creation', target: { kind: 'machine', machineId: 'guest' }, input: localInput });
            if (url.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'exact-local-setup-root', binding: {
                accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'terminal', tokenEpoch: 2 }, accountEncryptionMode: 'plain',
                serverIdentityId: 'srv_home', machineId: 'guest', installationId: 'guest-installation', actionId,
                requestId: 'creation', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(carrier.envelope), target: carrier.envelope.target,
                ...(isIsolation ? { managedContinuation: { ...continuation, controller: { machineId: 'controller', installationId: 'installation' },
                    acquireRequestEnvelopeDigest: root.binding.requestEnvelopeDigest } } : {}),
            } } };
            expect(url).toBe(`https://home.example/v1/actions/${actionId}`);
            if (!carrier.executionAuthorization) throw new Error('Missing exact local setup authorization');
            expect(carrier.executionAuthorization.token).toBe('exact-local-setup-root');
            delivered++;
            return { status: 200, data: { v: 1, actionId, requestId: 'creation', execution: { ok: true, result } } };
        });
        const args = { credentials,
            custodianAccountId: 'account', serverHttpBaseUrl: 'https://home.example',
            isCurrent: async () => sameStoredCredentials(credentials, await readStoredCredentialsForServerId(installedProfile)),
            context: { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
                actionRequestId: 'creation', serverIdentityId: 'srv_home', signal: new AbortController().signal } };
        const invoke = (value: Omit<Parameters<typeof dispatchLocalManagedMachineSetup>[0], 'input'>) => {
            if (kind === 'setup') return dispatchLocalManagedMachineSetup({ ...value, input: setup });
            if (kind === 'adminAccess') return dispatchLocalManagedMachineAdminAccess({ ...value, input: adminAccess, homeId: 'srv_home' });
            return kind === 'isolationPreview'
                ? dispatchLocalManagedMachineAgentIsolation({ ...value, input: isolation, homeId: 'srv_home',
                    actionId: 'machines.agentIsolation.preview', managedContinuation: continuation })
                : dispatchLocalManagedMachineAgentIsolation({ ...value, input: isolationSet, homeId: 'srv_home',
                    actionId: 'machines.agentIsolation.set', managedContinuation: continuation });
        };
        expect(await invoke(args)).toEqual({ ok: true, result });
        expect(delivered).toBe(1);
        post.mockClear();
        expect(await invoke({ ...args, custodianAccountId: 'other-account' })).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(await invoke({ ...args, context: { ...args.context, surface: 'agent',
            actionCaller: { kind: 'session', sessionId: 'source', starterDepth: 0, turnDepth: 0 } } })).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        if (kind === 'setup') {
            for (const context of [
                { ...args.context, serverIdentityId: 'other-home' },
                { ...args.context, runtimeAccountId: 'other-account' },
                { ...args.context, actionRequestId: undefined },
                { ...args.context, runtimeRunId: 'agent-run' },
                { ...args.context, executionRunWorkflowRunId: 'workflow-run' },
                { ...args.context, externalActionExecutionAuthorization: root },
            ]) expect(await invoke({ ...args, context })).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
            await withCliApiToken(`hap_v1_123e4567-e89b-42d3-a456-426614174000_${'A'.repeat(43)}`, async () => {
                const apiCredentials = await readStoredCredentials();
                if (!apiCredentials) throw new Error('Expected invocation API token credentials');
                expect(await invoke({ ...args, credentials: apiCredentials })).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
            });
            const custodyDir = await mkdtemp(join(tmpdir(), 'happier-local-creation-custody-'));
            onTestFinished(() => rm(custodyDir, { recursive: true, force: true }));
            const sessionId = `borrowed-${randomUUID()}`;
            const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: custodyDir, sessionId, credentials,
                attribution: { serverId: configuration.activeServerId, accountId: 'account', machineId: 'controller', installationId: 'installation' } });
            vi.stubEnv('HAPPIER_SESSION_REQUESTER_SESSION_ID', sessionId);
            try {
                const requesterCredentials = await readRequesterSessionCredentialsForChild(custody.path);
                if (!requesterCredentials) throw new Error('Expected real private requester credential custody');
                expect(await invoke({ ...args, credentials: requesterCredentials })).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
            } finally { vi.unstubAllEnvs(); }
        }
        expect(post).not.toHaveBeenCalled();
        await removeStoredCredentialsForServerId(installedProfile);
        expect(await invoke(args)).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it('executes an admitted Agent setup child as an ordinary Machine Action', async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 2,
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
        const profile = `reviewed-setup-${randomUUID()}`;
        onTestFinished(() => removeStoredCredentialsForServerId(profile));
        await writeStoredCredentialsForServerId(profile, { token, encryption: null });
        const credentials = await readStoredCredentialsForServerId(profile);
        if (!credentials) throw new Error('Expected stored terminal credentials');
        const target = { kind: 'machine' as const, machineId: 'guest' };
        const setup = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: 'guest', targets: [{
            homeId: 'srv_home', machineId: 'guest', sources: [{ kind: 'direct', setup: {} }], desiredRevision: 0, recipePlans: [],
        }] });
        const templateRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'template-root', binding: {
            serverIdentityId: 'srv_home', accountId: 'account', custodianAccountId: 'account',
            authentication: { kind: 'terminal', tokenEpoch: 2 }, accountEncryptionMode: 'plain',
            actionId: 'template.instantiate', requestId: 'copy-request', requestEnvelopeDigest: 'a'.repeat(43),
            machineId: 'guest', installationId: 'guest-installation', target,
        } });
        const machine = { id: 'guest', kind: 'persistent', active: true, installationId: 'guest-installation', revokedAt: null,
            replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/v1/account/encryption')
            ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
            : url.endsWith('/v1/machines/guest') ? { status: 200, data: { machine } }
                : { status: 200, data: [machine] });
        const delivered: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.envelope).toMatchObject({ requestId: 'copy-request', target, input: setup });
            if (url.endsWith('/execution-authorization')) {
                delivered.push('mint');
                return { status: 200, data: { v: 1, token: 'ordinary-setup-root', binding: {
                    serverIdentityId: 'srv_home', accountId: 'account', custodianAccountId: 'account',
                    authentication: { kind: 'terminal', tokenEpoch: 2 }, accountEncryptionMode: 'plain',
                    machineId: 'guest', installationId: 'guest-installation', actionId: 'machines.setup.apply',
                    requestId: 'copy-request', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target,
                } } };
            }
            expect(request.executionAuthorization?.token).toBe('ordinary-setup-root');
            delivered.push('apply');
            return { status: 200, data: { v: 1, actionId: 'machines.setup.apply', requestId: 'copy-request',
                execution: { ok: true, result: { operationId: 'actual-setup' } } } };
        });
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            actionCaller: { kind: 'session' as const, sessionId: 'source', starterDepth: 0, turnDepth: 0 },
            serverIdentityId: 'srv_home', runtimeAccountId: 'account', actionRequestId: 'copy-request',
            signal: new AbortController().signal, externalActionTarget: target,
            externalActionExecutionAuthorization: templateRoot,
            verifiedExternalActionRequester: { authorization: templateRoot, isCurrent: async () => true } };
        const result = await invokeHostReviewedChildV1({ parent: { actionId: 'template.instantiate', input: {} }, context,
            child: { action: 'machines.setup.apply', role: BOT_TEMPLATE_SETUP_APPLY_ROLE_V1, input: setup },
            admittedReview: { action: 'machines.setup.apply', role: BOT_TEMPLATE_SETUP_APPLY_ROLE_V1, surface: 'agent' },
            execute: async (_input, childContext) => {
                expect(readHostAdmittedReviewedChildV1(childContext)).toMatchObject({ actionId: 'machines.setup.apply', input: setup });
                return dispatchLocalManagedMachineSetup({ input: setup, context: childContext, credentials,
                    custodianAccountId: 'account', serverHttpBaseUrl: 'https://home.example', isCurrent: async () => true });
            } });
        expect(result).toEqual({ ok: true, result: { operationId: 'actual-setup' } });
        expect(delivered).toEqual(['mint', 'apply']);
    });

    it('seals setup for the exact joined guest using the existing creation proof without Session admission', async () => {
        const sources = [
            { kind: 'accountPreset' as const, presetId: 'preset', presetRevision: 4,
                setup: { scripts: [{ body: '\r\necho retained\r\n', affects: 'none' as const }],  } },
            { kind: 'direct' as const, setup: {} },
        ];
        const setup = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: 'guest',
            targets: [{ homeId: 'srv_home', machineId: 'guest', sources, desiredRevision: 3, recipePlans: [] }] });
        const effectsInput = { homeId: 'srv_home', machineId: 'guest', sources: setup.targets[0]!.sources, mode: 'effects' as const };
        let opened: unknown;
        const actions: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            const actionId = String(url).endsWith('/machines.setup.plan') ? 'machines.setup.plan' : 'machines.setup.apply';
            expect(url).toBe(`https://home.example/v1/actions/${actionId}`);
            actions.push(actionId);
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.managedContinuation).toEqual(continuation);
            expect(request.envelope.requestId).toBe('creation');
            expect(request.envelope).not.toHaveProperty('sessionSpawnAdmission');
            expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
            const binding = { serverIdentityId: 'srv_home', accountId: 'account', authentication: { kind: 'account' as const, tokenEpoch: 2 },
                actionId, requestId: 'creation', target: { kind: 'machine' as const, machineId: 'guest' } };
            if (request.envelope.v !== 2) throw new Error('Expected sealed setup');
            opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope, binding, material })?.input;
            if (actionId === 'machines.setup.plan') expect(opened).toEqual(actions.length === 1
                ? { homeId: 'srv_home', machineId: 'guest' } : effectsInput);
            return { status: 200, data: prepareExternalActionResponseV2({ binding, request: request.envelope, material,
                randomBytes: length => new Uint8Array(length).fill(4), executedMachineId: 'guest',
                execution: { ok: true, result: actionId === 'machines.setup.plan'
                    ? { desiredRevision: 3, sources: actions.length === 1 ? [setup.targets[0]!.sources[1]] : sources,
                        exclusions: [], support: [], ...(actions.length === 1 ? {} : { recipePlans: [] }) }
                    : { operationId: 'setup-operation' } } }).response };
        });
        const dispatch = { serverId: 'home-profile', continuation, authorization: root,
            serverHttpBaseUrl: 'https://home.example', installationId: 'installation', privateKey: keyPair.secretKey, material };
        expect(await dispatchManagedMachineSetupPlan({ ...dispatch, input: { homeId: 'srv_home', machineId: 'guest' } }))
            .toMatchObject({ ok: true, result: { desiredRevision: 3 } });
        const retainedCreationSetup = { preset: { id: 'preset', revision: 4 }, setup: sources[0]!.setup };
        const effectsDispatch = { ...dispatch, input: effectsInput, retainedCreationSetup };
        expect(await dispatchManagedMachineSetupPlan(effectsDispatch)).toMatchObject({ ok: true, result: { recipePlans: [] } });
        expect(await dispatchManagedMachineSetup({ ...dispatch, input: setup }))
            .toMatchObject({ ok: true, result: { operationId: 'setup-operation' } });
        expect(opened).toEqual(setup);
        expect(actions).toEqual(['machines.setup.plan', 'machines.setup.plan', 'machines.setup.apply']);
        expect(await dispatchManagedMachineSetupPlan({ ...dispatch, input: { ...effectsInput, mode: 'check' } })).toMatchObject({ ok: false });
        expect(await dispatchManagedMachineSetupPlan({ ...effectsDispatch, input: { ...effectsInput, sources: [
            { ...sources[0]!, setup: { scripts: [{ body: 'echo unreviewed' }] } }, sources[1]!,
        ] } })).toMatchObject({ ok: false });
        expect(actions).toHaveLength(3);
    });

    it('carries the captured Voice automation ceiling through signed managed setup', async () => {
        const setup = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: 'guest', targets: [{ homeId: 'srv_home', machineId: 'guest', sources: [
            { kind: 'accountPreset', presetId: 'preset', presetRevision: 4, setup: { scripts: [{ body: 'echo admitted', affects: 'none' }],  } },
            { kind: 'direct', setup: {} },
        ], desiredRevision: 0, recipePlans: [] }] });
        let capturedHeaders: unknown;
        vi.spyOn(axios, 'post').mockImplementation(async (_url, body, config) => {
            capturedHeaders = config?.headers;
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            return { status: 200, data: { v: 1, actionId: 'machines.setup.apply', requestId: request.envelope.requestId,
                execution: { ok: true, result: { operationId: 'setup-operation' } } } };
        });
        await expect(dispatchManagedMachineSetup({ input: setup, serverId: 'home-profile', continuation,
            authorization: { ...root, binding: { ...root.binding, accountEncryptionMode: 'plain' } },
            authority: 'account_automation', serverHttpBaseUrl: 'https://home.example',
            installationId: 'installation', privateKey: keyPair.secretKey })).resolves.toMatchObject({ ok: true });
        expect(capturedHeaders).toMatchObject({ [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' });
    });

    it('qualifies a real local profile to its exact Home before sealing guest input and admission facts', async () => {
        let emittedRequestId: string | undefined;
        let openedInput: unknown;
        let admissionFacts: unknown;
        const canonicalInput = { ...input, executionTarget: { ...input.executionTarget, serverId: root.binding.serverIdentityId } };
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            expect(url).toBe('https://home.example/v1/actions/session.spawn_new');
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.managedContinuation).toEqual(continuation);
            emittedRequestId = request.envelope.requestId;
            expect(request.envelope.v).toBe(2);
            if (request.envelope.v !== 2) throw new Error('Expected sealed request');
            expect(JSON.stringify(request)).not.toContain('private instructions');
            expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
            const binding = { serverIdentityId: root.binding.serverIdentityId, accountId: root.binding.accountId,
                authentication: { kind: 'account' as const, tokenEpoch: 2 }, actionId: 'session.spawn_new',
                requestId: request.envelope.requestId, target: { kind: 'machine' as const, machineId: 'guest' } };
            openedInput = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request.envelope, binding, material })?.input;
            admissionFacts = request.envelope.sessionSpawnAdmission;
            return { status: 200, data: prepareExternalActionResponseV2({ binding, request: request.envelope,
                material, randomBytes: length => new Uint8Array(length).fill(4), executedMachineId: 'guest',
                execution: { ok: true, result: { type: 'success', disposition: 'created', sessionId: 'real-session',
                    executionTarget: canonicalInput.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: 'accepted', localId: 'first-message' } } } }).response };
        });
        await expect(dispatchManagedSessionStart({ input, continuation, authorization: root,
            serverHttpBaseUrl: 'https://home.example', installationId: 'installation', privateKey: keyPair.secretKey,
            material })).resolves.toMatchObject({ ok: true, result: { sessionId: 'real-session' } });
        // Keep this outside the HTTP boundary: an assertion thrown inside an
        // HTTP adapter is correctly treated as a transport failure by callers.
        expect(emittedRequestId).toBe(root.binding.requestId);
        expect(openedInput).toEqual(canonicalInput);
        expect(admissionFacts).toEqual(projectApiTokenSessionSpawnAdmissionV1(canonicalInput));
    });

    it('refuses encrypted continuation without real material before transmitting, while keyless Plain uses V1', async () => {
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.envelope.v).toBe(1);
            return { status: 200, data: { v: 1, actionId: 'session.spawn_new', requestId: request.envelope.requestId,
                execution: { ok: true, result: { type: 'success', disposition: 'created', sessionId: 'plain-session',
                    executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: 'accepted', localId: 'first-message' } } } } };
        });
        const args = { input, continuation, authorization: root, serverHttpBaseUrl: 'https://home.example',
            installationId: 'installation', privateKey: keyPair.secretKey };
        await expect(dispatchManagedSessionStart(args)).resolves.toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        const { accountEncryptionMode: _mode, ...unknownMode } = root.binding;
        const retry = ExternalActionExecutionAuthorizationV1Schema.parse({ ...root,
            binding: { ...unknownMode, actionId: 'machines.managed.bootstrap.retry', requestId: 'retry' } });
        await expect(dispatchManagedMachineAgentIsolation({ ...args, actionId: 'machines.agentIsolation.preview',
            input: { serverId: 'srv_home', machineId: 'guest', enabled: true }, serverId: 'home-profile',
            authorization: retry, material })).resolves.toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
        await expect(dispatchManagedSessionStart({ ...args, authorization: { ...root,
            binding: { ...root.binding, accountEncryptionMode: 'plain' } } })).resolves.toMatchObject({ ok: true, result: { sessionId: 'plain-session' } });
    });

    it('preserves a genuine child grant refusal instead of reporting it as unavailable transport', async () => {
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 403, data: { error: 'credential_scope_denied' } });
        await expect(dispatchManagedSessionStart({ input, continuation, authorization: root,
            serverHttpBaseUrl: 'https://home.example', installationId: 'installation', privateKey: keyPair.secretKey,
            material })).resolves.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    });

    it('refuses a saved target from another Home before transmitting or rewriting it to the root Home', async () => {
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
            'other-profile': { id: 'other-profile', name: 'Other', serverUrl: 'https://other.example', webappUrl: 'https://other.example',
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_other', canonicalServerUrl: 'https://other.example',
                    revision: 1, endpoints: [{ kind: 'https', url: 'https://other.example' }] } },
        } }));
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { error: 'target_unavailable' } });
        await expect(dispatchManagedSessionStart({ input: { ...input,
            executionTarget: { ...input.executionTarget, serverId: 'other-profile' } }, continuation, authorization: root,
            serverHttpBaseUrl: 'https://home.example', installationId: 'installation', privateKey: keyPair.secretKey,
            material })).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });
});
