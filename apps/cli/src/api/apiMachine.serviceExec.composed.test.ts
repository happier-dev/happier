import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import axios, { AxiosHeaders } from 'axios';
import { expect, it, vi } from 'vitest';
import { ActionOperationSnapshotV1Schema, FeaturesResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentEnvironmentAccessInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1,
    managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    ExternalActionDaemonDispatchRequestSchema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    parseExternalActionDaemonDispatchResultV1,
    type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, decodeExternalActionResolvedTargetV1,
    verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { AUTHORITY_CEILING_HEADER_V1, resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationCancelV1ResponseSchema,
    ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineOperationProtocolCapabilitiesV1Schema,
    MachineUpdateOperationProtocolCapabilitiesRequestV1Schema, MachineUpdateOperationProtocolCapabilitiesResponseV1Schema,
} from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { configuration, reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor, useServerProfile } from '@/server/serverProfiles';
import { readStoredCredentials, writeCredentialsTokenOnly } from '@/persistence';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { withFiniteComposeFixture } from '@/daemon/local/services/launch/serviceExec.testkit';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { produceEnvironmentProjectServices } from '@/daemon/local/services/launch/projectDeclarations';
import type { RpcHandlerContext } from './rpc/types';
import { ApiClient } from './api';

// Only the private listener is replaced. Startup, signed ingress, requester
// custody, Action admission and the mounted native service remain real.
vi.mock('@/daemon/controlServer', () => ({
    startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }),
}));

async function exerciseCurrentService(scenario: 'defaultAsk' | 'finite' | 'cancel' | 'lost_native_ack' | 'lost_home_pending' | 'lost_home_completed',
    machineRole: 'use' | 'manage' = 'manage') {
    const signedReplyLoss = scenario === 'lost_home_pending' || scenario === 'lost_home_completed';
    // Match the enclosing native/process test budget in vitest.config.ts.
    const waitFor = <T,>(callback: () => T | Promise<T>) =>
        vi.waitFor(callback, { timeout: 30_000 });
    const home = await mkdtemp(join(tmpdir(), 'happier-public-service-exec-'));
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    reloadConfiguration();
    let releaseHome: (() => void) | undefined;
    let currentnessChannel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>> | undefined;
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    let client: ReturnType<ApiClient['machineSyncClient']> | undefined;
    try {
        const profile = await addServerProfile({ name: 'service-exec', serverUrl: 'https://service-exec.invalid', webappUrl: 'https://service-exec.invalid' });
        const target = { serverId: 'srv_machine_service_exec', machineId: 'machine' };
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: target.serverId, canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        await useServerProfile(profile.id);
        vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', profile.id);
        vi.stubEnv('HAPPIER_SERVER_URL', profile.serverUrl);
        reloadConfiguration();
        const installation = await readOrCreateInstallationIdentity();
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'requester', provenance: {
            v: 1, kind: 'terminal', authority: 'account_automation',
        }, ...(signedReplyLoss ? { tokenEpoch: 7 } : {}) })).toString('base64url')}.fixture`;
        await writeCredentialsTokenOnly({ token });
        const credentials = await readStoredCredentials();
        if (!credentials) throw new Error('Expected the real stored terminal credential');
        releaseHome = publishServerHttpRuntimeOrigin(profile.serverUrl, 'https');
        let actionSettings = ActionsSettingsV1Schema.parse({ v: 1 });
        const machineRow = { id: target.machineId, kind: 'persistent', active: true,
            revokedAt: null, replacedByMachineId: null, installationId: installation.installationId,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({}), operationProtocolCapabilitiesRevision: 0,
            installationPublicKey: Buffer.from(installation.publicKey, 'base64url').toString('base64'), storageMode: 'plain',
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, access: { custodian: { accountId: 'requester', displayName: 'Requester' },
                role: machineRole, resourceMode: 'plain', accessState: 'ready' } };
        let verifySignedHomeRequest: ((url: string, method: string, body: unknown, headers: AxiosHeaders) => boolean) | undefined;
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'requester' } };
            if (String(url).endsWith('/v1/account/encryption/currentness')) return signedReplyLoss
                ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null,
                    contentKeyFingerprint: null, updatedAt: 1,
                    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } }
                : { status: 404, data: {} };
            if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (signedReplyLoss && String(url).endsWith('/v1/machines')) return { status: 200, data: [machineRow] };
            if (signedReplyLoss && String(url).endsWith(`/v1/machines/${target.machineId}`)) return { status: 200, data: { machine: machineRow } };
            if (signedReplyLoss && String(url).endsWith('/v2/account/settings')) return { status: 200,
                data: { version: 1, content: { t: 'plain', v: { actionsSettingsV1: actionSettings } } } };
            throw new Error(`Unexpected Home GET ${url}`);
        });
        // Only Home transports and the native Docker executable are replaced.
        // The receiver still creates and verifies actual installation proofs.
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (!String(url).endsWith('/v1/machines/machine/admission/verify') || !body || typeof body !== 'object'
                || !('context' in body) || !('proof' in body) || !('method' in body)) throw new Error('Unexpected Home POST');
            const admission = SocketRpcMachineAdmissionContextV1Schema.parse(body.context);
            const proof = MachineInstallationProofV1Schema.parse(body.proof);
            const ok = admission.actorAccountId === 'requester' && admission.custodianAccountId === 'requester'
                && verifyMachineInstallationProof({ publicKey: installation.publicKey, proof, payload: {
                    version: 1, accountId: 'requester', machineId: target.machineId, installationId: installation.installationId,
                    rpcAdmission: { context: admission, method: String(body.method) },
                } });
            return { status: ok ? 200 : 403, data: ok ? { v: 1, ok: true } : { error: 'access_denied' } };
        });
        let deploy = true;
        const environmentHttp = vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (signedReplyLoss && new AxiosHeaders(request.headers).has(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)) {
                expect(verifySignedHomeRequest?.(String(request.url), String(request.method ?? 'GET').toUpperCase(),
                    request.data, new AxiosHeaders(request.headers))).toBe(true);
            } else expect(request.headers).toMatchObject({ Authorization: `Bearer ${token}` });
            if (new URL(String(request.url)).pathname === managedMachineActionEndpointPathV1('machines.managed.list')) {
                expect(request.method).toBe('POST');
                const input = ManagedMachineActionInputSchemasV1['machines.managed.list'].parse(request.data);
                expect(input).toMatchObject({ homeId: target.serverId, enrolledMachineId: target.machineId });
                return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
                    data: ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse({ machines: [] }) };
            }
            if (String(request.url).endsWith('/v1/deployments/environments/access')) {
                expect(request.method).toBe('POST');
                const input = DeploymentEnvironmentAccessInputV1Schema.parse(request.data);
                expect(input.environmentIds).toEqual(['finite-environment']);
                return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data: {
                    ok: true, items: [{ environmentId: 'finite-environment', read: true, deploy }],
                } };
            }
            return { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data: {
                ok: true, targetLinks: [], environment: {
                    v: 1, id: 'finite-environment', serverId: target.serverId, projectSourceId: 'source', revision: 1,
                    owner: { kind: 'account', accountId: 'different-owner' }, protection: 'nonProduction', purpose: 'standard',
                    deployerMode: 'managers', controllerMachineId: target.machineId, contentArtifactId: 'content',
                    contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'different-owner', createdAtMs: 1, updatedAtMs: 1,
                    capabilities: { role: deploy ? 'manager' : 'reader', read: true, deploy,
                        manage: deploy, manageBindings: deploy, manageTargets: deploy, delete: deploy },
                },
            } };
        });
        // Machine startup can acquire the shared Account observation. Redirect
        // its transport before that first holder captures the Home endpoint.
        if (signedReplyLoss) currentnessChannel = await createRequesterCurrentnessSocketHarness();
        const api = await ApiClient.create(credentials);
        api.setServerFeaturesSnapshotProvider(() => ({ status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { serverIdentity: { serverIdentityId: target.serverId } },
        }) }));
        client = await api.machineSyncClient({ id: target.machineId, encryptionMode: 'plain', metadata: {
            host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: home, happyHomeDir: home,
        }, metadataVersion: 1, daemonState: { status: 'running' }, daemonStateVersion: 0 });
        const installed = client;
        const snapshots: ActionOperationSnapshotV1[] = [];
        Reflect.set(installed, 'socket', createApiSessionSocketStub({ connected: true,
            emitWithAck: (event, payload) => {
                if (event !== MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) return resolveApiSessionSocketDefaultAck(event, payload);
                const request = MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(payload);
                expect(request.machineId).toBe(target.machineId);
                machineRow.operationProtocolCapabilities = request.capabilities;
                return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse({ v: 1, result: 'success',
                    revision: ++machineRow.operationProtocolCapabilitiesRevision });
            }, emit: (event, args) => {
                if (event !== 'action-operation-updated') return;
                const envelope = args[0];
                if (!envelope || typeof envelope !== 'object' || !('content' in envelope)) return;
                const content = envelope.content;
                if (!content || typeof content !== 'object' || !('t' in content) || content.t !== 'plain' || !('v' in content)) return;
                const parsed = ActionOperationSnapshotV1Schema.safeParse(content.v);
                if (parsed.success) snapshots.push(parsed.data);
            } }));
        runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
            runtimeOptions: { pluginIds: [] } });
        const owner = runtime.registry.projectManagedServices;
        installed.setRPCHandlers({ spawnSession: async () => { throw new Error('A service command must not create a Session'); },
            stopSession: async () => ({ status: 'not_found' }), requestShutdown() {} });
        if (!signedReplyLoss) installed.registerLocalServicesRoutes({ machineId: target.machineId, serverId: configuration.activeServerId,
            accountId: 'requester', projectManagedServices: owner, resolveLauncherActionExecutor: () => {
                const executor = createCliActionExecutor({ credentials, token, sessionId: 'cli-global',
                    // This independently constructed receiving executor needs
                    // the same captured Home fact as the installed ApiClient.
                    serverId: profile.id, serverIdentityId: target.serverId,
                    serverHttpBaseUrl: profile.serverUrl, mode: 'plain', ctx: null,
                    isCredentialCurrent: async () => (await readStoredCredentials())?.token === token,
                    actionsSettingsProvider: { getActionsSettings: () => actionSettings },
                    runActionOperation: request => installed.runActionOperation(request),
                    machineActionDirectTargetTransport: { machineId: target.machineId,
                        invoke: async () => { throw new Error('A mounted current service must not re-enter Machine RPC'); } },
                });
                return executor;
            } });
        const method = 'machines.services.exec';
        const lifetime = new AbortController();
        const admission = { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: target.machineId,
            installationId: installation.installationId, role: machineRole, encryptionMode: 'plain' as const };
        const context: RpcHandlerContext = { signal: lifetime.signal, callerAuthority: 'present_user', machineAdmission: admission,
            verifyMachineAdmissionCurrent: () => verifyMachineRpcAdmissionCurrent({ context: admission,
                method: `machine:${method}`, privateKey: Buffer.from(installation.privateKey, 'base64url'), daemonToken: token,
                serverHttpBaseUrl: profile.serverUrl, signal: lifetime.signal }),
            localActionContext: { surface: 'cli', authority: 'present_user' },
        };
        await withFiniteComposeFixture(async ({ project, docker, source, io }) => {
            const rendered = await project.render();
            const activated = await machineNativeEffectAdmission.run({ operation: { operationId: 'deploy-before-current-exec', kind: 'deploy' },
                keys: rendered.keys, settleNative: project.settleNative }, context => project.activate({ render: rendered, context }));
            await source.commit();
            // Native observations survive plugin reloads. Each fixture creates
            // a different installation and must not reuse the prior release.
            const handles = await produceEnvironmentProjectServices({ owner, ...target, release: source,
                specIdentity: `current-public-exec:${installation.installationId}`,
                isCurrent: () => true, nativeEffects: { keys: rendered.keys, settleNative: project.settleNative }, io, project: activated });
            const handle = handles[0];
            if (!handle) throw new Error('Expected the actual mounted Environment service');
            const command = { ...target, target: { kind: 'current', serviceId: handle.serviceId, expectedGeneration: handle.instanceId },
                mode: 'exec', argv: ['print', '$HOME', 'semi;colon', 'line\nbreak'] };
            const invoke = (input: unknown, signal = lifetime.signal) => installed.invokeLocalMachineAction(method, input, {
                signal, rpcContext: { ...context, signal }, localActionContext: context.localActionContext,
            });
            if (signedReplyLoss) {
                // Ordinary terminal sign-in uses the current signed admission
                // and requester-context carrier through the receiving owner.
                for (const surface of ['cli', 'ui'] as const) actionSettings = setScopedActionApprovalPreference({
                    actionId: method, scope: handle.actionScope, surface, mode: 'waived', settings: actionSettings });
                let routes: DaemonLocalServicesMachineRpcRoutes | undefined;
                let startup: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
                const post = vi.mocked(axios.post).getMockImplementation();
                if (!post) throw new Error('Expected the existing Home network boundary');
                const roots = new Map<string, ExternalActionExecutionAuthorizationV1>();
                const tasks: Promise<unknown>[] = [];
                let rejectHomeFailure!: (error: unknown) => void;
                const homeFailure = new Promise<never>((_resolve, reject) => { rejectHomeFailure = reject; });
                void homeFailure.catch(() => undefined);
                let serviceReply: ServerResponse | undefined;
                let serviceFrames = 0;
                const finiteInvocations = async () => (await docker.readInvocations()).filter(row => row.args.includes('exec') || row.args.includes('run'));
                const verifyHome = (url: string, httpMethod: string, body: unknown, headers: AxiosHeaders) => {
                    const rawToken = headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER);
                    const root = typeof rawToken === 'string' ? roots.get(rawToken) : undefined;
                    const signature = headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER);
                    const rawTarget = headers.get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER);
                    const effect = headers.get(EXTERNAL_ACTION_EFFECT_ACTION_HEADER);
                    const resolvedTarget = typeof rawTarget === 'string' ? decodeExternalActionResolvedTargetV1(rawTarget) : null;
                    return root !== undefined && typeof signature === 'string' && effect === root.binding.actionId
                        && resolvedTarget?.kind === 'machine' && resolvedTarget.machineId === target.machineId
                        && verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: effect,
                            target: resolvedTarget, installationId: installation.installationId, requestId: root.binding.requestId,
                            method: httpMethod, path: new URL(url).pathname, ...(body === undefined ? {} : { body }),
                            publicKey: installation.publicKey, signature });
                };
                verifySignedHomeRequest = verifyHome;
                const http = createServer((request, response) => {
                    const receive = async () => {
                        expect(request.headers.authorization).toBe(`Bearer ${token}`);
                        const claims = decodeJwtPayload(token);
                        const provenance = readAuthTokenProvenance(claims, { allowLegacyHome: true });
                        if (provenance?.provenance.kind !== 'terminal' || provenance.provenance.authority !== 'account_automation') {
                            throw new Error('Expected ordinary terminal sign-in authentication');
                        }
                        // Minting retains the terminal credential floor; delivery
                        // carries the person's sealed host invocation.
                        const mint = request.url?.endsWith('/execution-authorization') === true;
                        expect(request.headers[AUTHORITY_CEILING_HEADER_V1]).toBe(mint ? 'account_automation' : undefined);
                        const authentication = { kind: provenance.provenance.kind, tokenEpoch: claims?.tokenEpoch };
                        const authority = resolveInvocationAuthority({ credential: provenance.provenance.kind, surface: 'rpc' });
                        expect(authority).toBe('present_user');
                        const actionId = request.url?.slice(EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1.length)
                            .replace(/\/execution-authorization$/, '');
                        if (actionId !== method && actionId !== 'action.operations.get') throw new Error('Unexpected Home Action');
                        const chunks: Buffer[] = [];
                        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        const submitted = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
                        expect(submitted.machineId).toBe(target.machineId);
                        const { envelope } = submitted;
                        expect(envelope.v).toBe(1);
                        // Only Home's HTTP authentication/storage is substituted.
                        // Canonical public authority resolution and installation
                        // signatures/requester custody below stay real.
                        const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
                            token: `home-${envelope.requestId}`, binding: { serverIdentityId: target.serverId,
                                accountId: 'requester', custodianAccountId: 'requester', accountEncryptionMode: 'plain',
                                authentication, actionId, requestId: envelope.requestId,
                                machineId: target.machineId, installationId: installation.installationId,
                                target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
                        if (mint) {
                            roots.set(root.token, root);
                            response.setHeader('content-type', 'application/json');
                            response.end(JSON.stringify(root));
                            return;
                        }
                        const authorization = submitted.executionAuthorization;
                        if (!authorization) throw new Error('Expected the minted signed admission');
                        expect(roots.get(authorization.token)).toEqual(root);
                        expect(authorization.binding).toEqual(root.binding);
                        // Home's closed relay principal retains the signed
                        // credential floor. The installed receiver derives the
                        // person's invocation from this verified root instead.
                        const dispatch = ExternalActionDaemonDispatchRequestSchema.parse({ actionId, envelope, executionAuthorization: authorization,
                            principal: { accountId: 'requester', authentication, authority: provenance.provenance.authority },
                            placement: { machineId: target.machineId, target: envelope.target } });
                        const manager: unknown = Reflect.get(installed, 'rpcHandlerManager');
                        if (!(manager instanceof RpcHandlerManager)) throw new Error('Expected installed RPC owner');
                        if (actionId === method) { serviceFrames++; serviceReply = response; }
                        const received = await manager.handleRequest({ method: `${target.machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
                            params: dispatch, authorization: ACTION_API_SERVER_ORIGIN, machineAdmission: admission });
                        const result = parseExternalActionDaemonDispatchResultV1(received);
                        if (result?.kind !== 'response') throw new Error(`Receiving Action refused: ${JSON.stringify(received)}`);
                        if ('execution' in result.prepared.response && !result.prepared.response.execution.ok) {
                            throw new Error(`Receiving Action refused: ${result.prepared.response.execution.errorCode}`);
                        }
                        if (actionId !== method) { response.setHeader('content-type', 'application/json'); response.end(result.prepared.body); }
                        return result;
                    };
                    const pending = receive(); tasks.push(pending);
                    void pending.catch(error => {
                        rejectHomeFailure(error);
                        if (!response.destroyed) { response.statusCode = 500; response.end(); }
                    });
                });
                try {
                    startup = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: home,
                        activeServerDir: configuration.activeServerDir, serverId: profile.id, serverHttpBaseUrl: profile.serverUrl,
                        machineId: target.machineId, custodianAccountId: 'requester', credentials,
                        connectedServicesMaterializationBaseDir: join(home, 'connected-services'),
                        registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
                        getApiMachineForSessions: () => installed, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
                        startup: { pluginRuntimeController: pluginReloadController,
                            onLocalServicesRoutesReady: current => { routes = current; },
                            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                                serverUrl: profile.serverUrl, resolveCurrentMachineId: () => target.machineId,
                                resolveCurrentServerIdentityId: () => target.serverId }) },
                    });
                    const ingress = startup.runtime.externalActionIngressOwner;
                    if (!ingress || !routes) throw new Error('Missing genuine startup receiving owner');
                    installed.setRPCHandlers({ spawnSession: async () => { throw new Error('Unexpected Session'); },
                        stopSession: async () => ({ status: 'not_found' }), requestShutdown() {} }, { externalActionIngressOwner: ingress });
                    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
                    const address = http.address();
                    if (!address || typeof address === 'string') throw new Error('Missing Home HTTP boundary');
                    const network = axios.create();
                    vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
                        const path = new URL(String(url)).pathname;
                        if (path.startsWith(EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1) && !path.endsWith('/verify')) {
                            return network.post(`http://127.0.0.1:${address.port}${path}`, body, options);
                        }
                        if (path.endsWith('/execution-authorization/verify')) {
                            const valid = verifyHome(String(url), 'POST', body, new AxiosHeaders(options?.headers));
                            return { status: valid ? 200 : 403, data: valid ? { ok: true } : { error: 'access_denied' } };
                        }
                        return post(url, body, options);
                    });
                    const initiating = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                        serverId: profile.id, serverApiUrl: profile.serverUrl, serverIdentityId: target.serverId, machineId: target.machineId });
                    await docker.setCommandOutcome({ environmentKey: 'TOKEN', stdout: ' remote finite result', exitCode: 7 });
                    await docker.holdCommandReplies(true);
                    let initiatingResult: Awaited<ReturnType<typeof initiating.execute>> | undefined;
                    const pending = initiating.execute(method, command, { surface: 'cli', actionRequestId: 'service-http-ack-loss' })
                        .then(result => { initiatingResult = result; return result; });
                    try {
                        await Promise.race([waitFor(async () => {
                            expect(initiatingResult).toBeUndefined();
                            expect(await finiteInvocations()).toHaveLength(1);
                            expect(serviceReply).toBeDefined();
                            expect(snapshots.some(row => row.actionId === method)).toBe(true);
                        }), pending.then(result => {
                            throw new Error(`Current service settled before HTTP reply loss: ${JSON.stringify(result)}`);
                        }), homeFailure]);
                        const operation = snapshots.find(row => row.actionId === method)!;
                        const read = async () => {
                            const result = await initiating.execute('action.operations.get', { ...target, operationId: operation.operationId }, { surface: 'cli' });
                            if (!result.ok) throw new Error(`Observation refused: ${JSON.stringify(result)}`);
                            const observed = ActionOperationGetV1ResponseSchema.parse(result.result);
                            if (observed.kind !== 'found') throw new Error('Issued operation disappeared');
                            return observed.operation;
                        };
                        if (scenario === 'lost_home_completed') {
                            await docker.holdCommandReplies(false);
                            await waitFor(async () => expect(await read()).toMatchObject({ result: { exitCode: 7 } }));
                            await waitFor(() => expect(snapshots).toEqual(expect.arrayContaining([
                                expect.objectContaining({ operationId: operation.operationId,
                                    result: expect.objectContaining({ exitCode: 7 }) }),
                            ])));
                        } else expect(await read()).not.toHaveProperty('settledAt');
                        // Drop ONLY the owned HTTP reply. No command cancellation,
                        // synthetic disposition error or second execution is sent.
                        serviceReply!.socket!.destroy();
                        expect(await pending).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
                        if (scenario === 'lost_home_pending') expect(await read()).not.toHaveProperty('settledAt');
                        await docker.holdCommandReplies(false);
                        await waitFor(async () => expect(await read()).toMatchObject({ result: {
                            exitCode: 7, stdout: '[REDACTED] remote finite result', stderr: '' } }));
                        const settled = await read();
                        expect(settled).toHaveProperty('settledAt');
                        expect(settled).not.toHaveProperty('observation');
                        expect(serviceFrames).toBe(1);
                        expect(await finiteInvocations()).toHaveLength(1);
                        await Promise.all(tasks);
                    } finally {
                        await docker.holdCommandReplies(false);
                        serviceReply?.destroy();
                        await pending.catch(() => undefined);
                    }
                } finally {
                    serviceReply?.destroy();
                    vi.mocked(axios.post).mockImplementation(post);
                    verifySignedHomeRequest = undefined;
                    const settled = await Promise.allSettled(tasks);
                    if (http.listening) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
                    await startup?.dispose();
                    const failed = settled.find(result => result.status === 'rejected');
                    if (failed?.status === 'rejected') throw failed.reason;
                }
                return;
            }
            const finiteInvocations = async () => (await docker.readInvocations()).filter(row => row.args.includes('exec') || row.args.includes('run'));
            if (scenario === 'defaultAsk') {
                // Qualify Ask independently of the finite/cancel/lost-exit
                // cases, so a Home approval fixture failure cannot mask them.
                const refusal = ActionExecuteFailureSchema.parse(await invoke(command));
                expect(refusal, JSON.stringify(refusal)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
                expect(await finiteInvocations()).toHaveLength(0);
                return;
            }
            expect(await finiteInvocations()).toHaveLength(0);
            actionSettings = setScopedActionApprovalPreference({ actionId: 'machines.services.exec', scope: handle.actionScope,
                surface: 'cli', mode: 'waived', settings: actionSettings });
            if (scenario !== 'finite') {
                const controller = new AbortController();
                await docker.setCommandOutcome(scenario === 'cancel'
                    ? { hold: true, environmentKey: 'TOKEN', stdout: ' undisclosed command bytes' }
                    : { loseExitAcknowledgement: true });
                const pending = invoke({ ...command, argv: ['one-native-command'] }, controller.signal);
                if (scenario === 'cancel') {
                    await waitFor(async () => {
                        expect(await finiteInvocations()).toHaveLength(1);
                        expect(snapshots.find(snapshot => snapshot.actionId === method)).toBeDefined();
                    });
                    const operation = snapshots.find(snapshot => snapshot.actionId === method)!;
                    const cancelled = await installed.invokeLocalMachineAction(ACTION_OPERATION_RPC_METHODS_V1.cancel,
                        { operationId: operation.operationId }, { rpcContext: context, localActionContext: context.localActionContext });
                    expect(ActionOperationCancelV1ResponseSchema.parse(cancelled)).toEqual({ kind: 'requested' });
                }
                expect(await pending).toEqual({ kind: 'outcome_unknown' });
                expect(await finiteInvocations()).toHaveLength(1);
                // Legacy push preserves open state; the current V2 reader
                // consumes the complete observation from the same owner.
                const operation = snapshots.filter(snapshot => snapshot.actionId === method).at(-1);
                expect(operation).toMatchObject({ state: 'running' });
                expect(operation).not.toHaveProperty('settledAt');
                const observed = ActionOperationGetV1ResponseSchema.parse(await installed.invokeLocalMachineAction(
                    ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: operation!.operationId },
                    { rpcContext: context, localActionContext: context.localActionContext }));
                expect(observed).toMatchObject({ kind: 'found', operation: { state: 'running',
                    observation: { kind: 'outcome_uncertain' } } });
                if (observed.kind === 'found') expect(observed.operation).not.toHaveProperty('settledAt');
                expect(JSON.stringify(snapshots)).not.toContain('undisclosed command bytes');
                return;
            }
            await docker.setCommandOutcome({ environmentKey: 'TOKEN', stdout: ' ordinary output', stderr: '', exitCode: 7 });
            const received = await invoke(command);
            expect(received).toEqual({ exitCode: 7, stdout: '[REDACTED] ordinary output', stderr: '',
                stdoutTruncated: false, stderrTruncated: false });
            await waitFor(() => expect(snapshots).toEqual(expect.arrayContaining([
                expect.objectContaining({ actionId: 'machines.services.exec', result: received }),
            ])));
            const executed = (await docker.readInvocations()).filter(row => row.args.includes('exec'));
            expect(executed).toHaveLength(1);
            expect(executed[0].dockerHostMatchesExpected).toBe(true);
            expect(executed[0].args.slice(executed[0].args.indexOf('exec'))).toEqual(['exec', '-T', 'worker', ...command.argv]);
            expect(executed[0].environmentKeys).not.toContain('TOKEN');
            expect(environmentHttp).toHaveBeenCalled();
            deploy = false;
            expect(await invoke(command)).toMatchObject({ errorCode: 'service_exec_denied' });
            deploy = true;
            expect(await invoke({ ...command, target: { ...command.target, expectedGeneration: 'retired-generation' } }))
                .toMatchObject({ errorCode: 'service_generation_changed' });
            expect(await invoke({ ...command, mode: 'run' })).toMatchObject({ errorCode: 'service_admission_unavailable' });
            expect(await finiteInvocations()).toHaveLength(1);
            const aborted = new AbortController();
            aborted.abort();
            await invoke(command, aborted.signal).catch(() => undefined);
            expect(await finiteInvocations()).toHaveLength(1);
            await writeCredentialsTokenOnly({ token: 'retired-requester-credential' });
            const retiredBefore = await invoke(command).then(result => result, error => error);
            expect(retiredBefore).not.toHaveProperty('exitCode');
            expect(await finiteInvocations()).toHaveLength(1);
            await writeCredentialsTokenOnly({ token });
            await docker.setCommandOutcome({ stdout: 'post-dispatch-private-output', stderr: 'post-dispatch-private-error', exitCode: 7 });
            await docker.holdCommandReplies(true);
            const revoked = invoke({ ...command, argv: ['complete-after-credential-replacement'] });
            try {
                await waitFor(async () => expect(await finiteInvocations()).toHaveLength(2));
                await writeCredentialsTokenOnly({ token: 'retired-after-native-dispatch' });
            } catch (error) {
                await docker.holdCommandReplies(false);
                await revoked.catch(() => undefined);
                throw error;
            } finally { await docker.holdCommandReplies(false); }
            const withdrawn = await revoked;
            // This finite command was admitted before credential replacement.
            // Withdrawal applies at the next admission, not at each read.
            expect(withdrawn).toEqual({ exitCode: 7, stdout: 'post-dispatch-private-output', stderr: 'post-dispatch-private-error',
                stdoutTruncated: false, stderrTruncated: false });
            const next = await invoke(command).then(result => result, error => error);
            expect(next).not.toHaveProperty('exitCode');
            expect(await finiteInvocations()).toHaveLength(2);
        }, { machineId: target.machineId, installationId: installation.installationId,
            installationPrivateSeed: Buffer.from(installation.privateKey, 'base64url').subarray(0, 32) });
    } finally {
        await client?.shutdown();
        await runtime?.dispose();
        await currentnessChannel?.close();
        releaseHome?.();
        vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration();
        await rm(home, { recursive: true, force: true });
    }
}

it('refuses default Ask without dispatch when the fixture has no Account approval carrier', async () => {
    await exerciseCurrentService('defaultAsk');
});

it('executes the current service with Machine Use and fences Environment access, generation and next-admission credential retirement', async () => {
    await exerciseCurrentService('finite', 'use');
});

it('keeps a cancelled current service command uncertain without replay or native termination claims', async () => {
    await exerciseCurrentService('cancel');
});

it('keeps lost native exit acknowledgement uncertain with exactly one dispatch through installed person ingress', async () => {
    await exerciseCurrentService('lost_native_ack');
});

it.each(['lost_home_pending', 'lost_home_completed'] as const)(
    'observes one ordinary signed current command after HTTP reply loss without replay (%s)', async scenario => {
        await exerciseCurrentService(scenario);
    });
