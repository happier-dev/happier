import { expect } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { io } from 'socket.io-client';
import { ACTION_SPECS } from '@happier-dev/protocol/actions/actionSpecs';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    encodeBase64, signMachineInstallationProof, readMachineAdminAccessV1, type ActionExecutorDeps } from '@happier-dev/protocol';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, type ActionOperationRevisionEphemeralV1 } from '@happier-dev/protocol/actions/operations/v1';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { DeploymentSocketHomeFixture } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { createHostActionOperationRuntime, registerActionOperationRpcHandlers } from '@/daemon/actionOperations';
import { createDaemonExternalActionContributedInvoker } from '@/daemon/externalActions/createDaemonExternalActionContributedInvoker';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { registerExternalActionRpcHandler, type ExternalActionRpcRegistrationOptions, type ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import type { DaemonExternalActionExecutorFactory } from '@/daemon/externalActions/execution';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { APPROVAL_RPC_SCOPES, collectActionSpecRpcMethodsForScopes } from '@/rpc/handlers/actionSpecRpcRegistration';
import { prepareInstalledRequesterAccountActionContext, resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createCredentialedTargetActionCurrentIntent } from '@/session/actions/approvals/credentialedTargetActionCurrentIntent';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { decodeStoredCredentials, encodeStoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import * as installationStore from '@/daemon/identity/store';
import { ApiClient } from '@/api/api';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { readPublishedMachineRow } from '@/api/machine/readPublishedMachineRow';
import { CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1 } from '@/api/apiMachine';
import { publishMachineOperationProtocolCapabilitiesOnSocket } from '@/api/machine/publishMachineOperationProtocolCapabilities';
import { createActionOperationSnapshotPublisher, emitActionOperationSnapshotV1 } from '@/api/machine/actionOperationSnapshotPublisher';
import { readOpenedMachineMetadataSnapshot, publishMachineMetadataOnce } from '@/api/machine/machineMetadataPublication';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { registerDaemonMachineAdminAccessRpcHandlers } from '@/rpc/handlers/daemonMachineAdminAccess';
import { createMachineAdminAccessObserver } from '@/machines/adminAccess/observeMachineAdminAccess';
import { createMachineAdminAccessHost } from '@/machines/adminAccess/machineAdminAccessHost';
import { createMachineRolesRuntime } from '@/daemon/roles/machineRolesRuntime';
import { machineRoleCatalogFromPluginsV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { bindMachineRoleAdmission } from '@/plugins/projection/registry/builtIn/machineRoles';
import { createMachineDaemonStatePublication } from '@/api/machine/machineDaemonStatePublication';
import { registerDaemonMachineRolesRpcHandlers } from '@/rpc/handlers/daemonMachineRoles';
import { readAgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { createDaemonAgentIsolationEffects } from '@/daemon/agentIsolation/createDaemonAgentIsolationEffects';
import type { AgentIsolationReadinessSystem } from '@/daemon/agentIsolation/agentIsolationReadiness';
import { createEnrollmentJourneyProviderAuthority, type EnrollmentJourneyNativeBoundary } from '@/machines/managed/enrollmentJourney.testkit';
import { createDaemonManagedMachineActionAdapter } from '@/daemon/startup/managedMachineActionAdapter';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCredentialedWorkflowAcceptedAuthorizationCurrentness } from '@/daemon/workflows/daemonRuntime';
import { registerDaemonDeploymentChildRpcHandler } from './daemonDeploymentChildRpc';
import type { DeploymentSourceRequesterIdentityResolver } from './readDeploymentSourceIntentForHost';

export function readS0ControllerCredentials(home: DeploymentSocketHomeFixture) {
    const credentials = decodeStoredCredentials(encodeStoredCredentials({ token: home.token, encryption: home.encryption }));
    if (!credentials) throw new Error('The controller must use canonical stored sign-in credentials');
    return credentials;
}

// Real daemon compositions share a test process, not an installation file.
export const installationBoundary = new AsyncLocalStorage<NonNullable<ReturnType<typeof installationStore.readInstallationIdentityIfExistsSync>>>();
export function readS0Installation(home: DeploymentSocketHomeFixture) {
    return { version: 1 as const, installationId: home.installationId, createdAt: 1,
        publicKey: encodeBase64(home.keys.publicKey, 'base64url'), privateKey: encodeBase64(home.keys.secretKey, 'base64url') };
}

/** The incumbent receiving daemon ingress, shared by composed deployment journeys. */
export type S0DeploymentDaemonIngress = Readonly<{
    actionOperations: ReturnType<typeof createHostActionOperationRuntime>;
    executor: ReturnType<typeof createCliActionExecutorFromCredentials>;
    externalActionIngressOwner: ExternalActionIngressOwner;
    machineActionDirectTargetTransport: NonNullable<Parameters<typeof createCliActionExecutorFromCredentials>[0]['machineActionDirectTargetTransport']>;
    readReceivedMethods(): readonly string[];
    observeRecordedApprovalExecution: ReturnType<typeof createCliActionExecutorFromCredentials>['observeRecordedApprovalExecution'];
    readIsolation(): ReturnType<typeof readAgentIsolationSnapshot> | null;
    isolationNative: ReturnType<typeof createAgentIsolationEffectsBoundary> | null;
    publishDaemonState: ReturnType<typeof createMachineDaemonStatePublication> | null;
    close(): Promise<void>;
}>;

export async function createS0DeploymentDaemonIngress(input: Readonly<{
    home: DeploymentSocketHomeFixture;
    createDeploymentActionDeps?(requester: RequesterAccountActionContext | undefined,
        operations: ReturnType<typeof createHostActionOperationRuntime>): Pick<ActionExecutorDeps,
        'deploymentAction' | 'deploymentTelemetrySet' | 'prepareDeploymentAction' | 'prepareDeploymentTeardown' | 'prepareDeploymentEnvironmentCreate' | 'prepareHostReviewedChildren'>;
    projectManagedServices?: NonNullable<NonNullable<Parameters<typeof registerDaemonLocalServicesMachineRpcHandlers>[1]>['projectManagedServices']>;
    managedMachineAction?: ActionExecutorDeps['managedMachineAction'];
    createExternalActionExecutor?(input: Readonly<{
        credentials: ReturnType<typeof readS0ControllerCredentials>;
        controllerCredentials: ReturnType<typeof readS0ControllerCredentials>;
        requester: RequesterAccountActionContext | undefined;
        ingress: Pick<ExternalActionIngressOwner, 'prepareRequesterAccountContext' | 'resolveEncryption' | 'resolveTarget'>;
    }>): ReturnType<DaemonExternalActionExecutorFactory>;
    machineServiceAction?: NonNullable<Parameters<typeof createCliActionExecutorFromCredentials>[0]['machineActionDirectTargetTransport']>['machineServiceAction'];
    resolveDeploymentRequesterIdentity?: DeploymentSourceRequesterIdentityResolver;
    nativeBoundary?: EnrollmentJourneyNativeBoundary;
    isolationWorkspace?: Readonly<{ rootId: string; path: string }>;
    isolationReadinessSystem?: AgentIsolationReadinessSystem;
    /** A guest with an unavailable optional roles receiver exercises enrollment recovery. */
    installRolesReceiver?: boolean;
    /** Support published only by compositions that install the corresponding handlers. */
    operationProtocolCapabilities?: import('@happier-dev/protocol/machines/operationProtocolCapabilitiesV1').MachineOperationProtocolCapabilitiesV1;
    configureRpc?(rpc: RpcHandlerManager, context: Readonly<{
        isolationNative: ReturnType<typeof createAgentIsolationEffectsBoundary> | null;
        readIsolation: () => ReturnType<typeof readAgentIsolationSnapshot> | null;
        captureMetadataPort: () => import('@happier-dev/protocol/machines/machineMetadataFieldV1').MachineMetadataFieldPortV1;
    }>): readonly string[] | Promise<readonly string[]>;
    /** Observe the actual socket frame without replacing admission or dispatch. */
    observeReceivedRequest?(request: SocketRpcRequestPayload): Promise<void>;
    /** Exercise the installed daemon's owner-scoped Activity publisher. */
    observeOperationPublication?(content: ActionOperationRevisionEphemeralV1['content']): void;
}>): Promise<S0DeploymentDaemonIngress> {
    const { home } = input;
    if (home.encryptionMode === 'e2ee' && (!home.machineEncryptionKey || !home.encryption)) {
        throw new Error('The E2EE daemon requires its owning fixture encryption material');
    }
    const daemonToken = home.daemonToken ?? home.token;
    const credentials = readS0ControllerCredentials({ ...home, token: daemonToken });
    const workflowAcceptedAuthorizationCurrentness = createCredentialedWorkflowAcceptedAuthorizationCurrentness({
        credentials, accountId: home.accountId, serverId: home.serverId, serverHttpBaseUrl: home.baseUrl });
    const daemonLifetime = new AbortController();
    const managedProviderOperationAuthority = createEnrollmentJourneyProviderAuthority(home.baseDir);
    const actionOperationPublisher = input.observeOperationPublication ? createActionOperationSnapshotPublisher({
        resolveAccountId: async () => home.accountId, serverBaseUrl: home.baseUrl,
        readCredentials: async () => credentials,
        publishContent: content => {
            input.observeOperationPublication?.(content);
            emitActionOperationSnapshotV1({ socket: machineSocket, machineId: home.machineId, content });
        },
        publishContentAcknowledged: async content => {
            input.observeOperationPublication?.(content);
            return await emitActionOperationSnapshotV1({ socket: machineSocket, machineId: home.machineId, content, acknowledge: true }) === true;
        },
    }) : undefined;
    const actionOperations = createHostActionOperationRuntime({
        serverId: home.serverId, machineId: home.machineId,
        custodyBinding: { serverId: home.serverId, installationId: home.installationId },
        resolveAccountId: async () => home.accountId,
        ...(actionOperationPublisher ? { publishSnapshot: actionOperationPublisher,
            publishSnapshotAcknowledged: actionOperationPublisher.acknowledge } : {}),
    });
    const invokeContributedAction = createDaemonExternalActionContributedInvoker({
        managedProviderOperationAuthority,
        observePluginExecution: actionOperations.observePluginExecution,
        requestCurrentIntent: createCredentialedTargetActionCurrentIntent(credentials),
    });
    async function prepareRequesterAccountContext(
        request: Parameters<NonNullable<ExternalActionRpcRegistrationOptions['prepareRequesterAccountContext']>>[0],
    ): ReturnType<NonNullable<ExternalActionRpcRegistrationOptions['prepareRequesterAccountContext']>> {
        let resolveTarget: ExternalActionRpcRegistrationOptions['resolveTarget'] | undefined;
        const prepared = await prepareInstalledRequesterAccountActionContext({ ...request,
            purpose: request.purpose ?? { kind: 'external_action' },
            machineId: home.machineId, serverId: home.serverId, serverHttpBaseUrl: home.baseUrl,
            ownCredentials: credentials, resolveCurrentMachineExecutionOriginContext,
            createExecutor: admitted => {
                resolveTarget = createDaemonExternalActionTargetResolver({
                    credentials: admitted.credentials, serverApiUrl: admitted.serverHttpBaseUrl,
                });
                return createExecutor(admitted.credentials, admitted);
            },
        });
        return prepared ? { ...prepared, ...(resolveTarget ? { resolveTarget } : {}) } : null;
    }
    const createExecutor = (scopedCredentials: typeof credentials, requester?: RequesterAccountActionContext) => {
        const deployment = input.createDeploymentActionDeps?.(requester, actionOperations);
        const executor = createCliActionExecutorFromCredentials({
            credentials: scopedCredentials, readCredentials: async () => scopedCredentials,
            pluginActionExecutionOwner: 'current_process',
            invokeContributedAction,
            machineId: home.machineId, serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl,
            externalActionMachineInstallationId: home.installationId,
            externalActionMachineRequestPrivateKey: home.keys.secretKey,
            workflowAcceptedAuthorizationCurrentness,
            runActionOperation: actionOperations.runActionOperation,
            deploymentAction: deployment?.deploymentAction,
            deploymentTelemetrySet: deployment?.deploymentTelemetrySet,
            prepareDeploymentAction: deployment?.prepareDeploymentAction,
            prepareDeploymentTeardown: deployment?.prepareDeploymentTeardown,
            prepareDeploymentEnvironmentCreate: deployment?.prepareDeploymentEnvironmentCreate,
            prepareHostReviewedChildren: deployment?.prepareHostReviewedChildren,
            ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}),
            managedMachineAction: input.managedMachineAction ?? createDaemonManagedMachineActionAdapter({
                credentials: scopedCredentials, controllerCredentials: credentials,
                machineId: home.machineId, serverId: home.serverId, serverBaseUrl: home.baseUrl,
                installationIdentity: { installationId: home.installationId, privateKey: home.keys.secretKey },
                resolveCurrentMachineExecutionOriginContext, managedProviderOperationAuthority,
                acquireRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
            }),
            prepareApprovalExecutionAuthorization: createDaemonApprovalExecutionAuthorizationPreparer({
                machineId: home.machineId, serverId: home.serverId, serverBaseUrl: home.baseUrl,
                resolveCurrentMachineExecutionOriginContext, requesterAccountContext: requester,
                prepareRequesterAccountContext, daemonWorkSignal: daemonLifetime.signal,
            }),
            machineActionDirectTargetTransport: { machineId: home.machineId,
                ...(input.machineServiceAction ? { machineServiceAction: input.machineServiceAction } : {}),
                invoke: (method, request, options) => rpc.invokeLocal(method, request, options) },
        });
        const installed = input.createExternalActionExecutor?.({
            credentials: scopedCredentials, controllerCredentials: credentials, requester,
            ingress: { prepareRequesterAccountContext, resolveEncryption, resolveTarget },
        });
        return installed ? { ...executor, ...installed } : executor;
    };
    const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
        serverUrl: home.baseUrl, resolveCurrentMachineId: () => home.machineId,
        resolveCurrentServerIdentityId: () => home.serverId,
    });
    const resolveEncryption: NonNullable<ExternalActionRpcRegistrationOptions['resolveEncryption']> = async () =>
        home.encryptionMode === 'e2ee' && home.encryption
            ? { serverIdentityId: home.serverId, material: home.encryption }
            : null;
    const resolveTarget = createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: home.baseUrl });
    const executor = createExecutor(credentials);
    const machineContent = home.encryptionMode === 'e2ee' && home.machineEncryptionKey
        ? { encryptionMode: 'e2ee' as const, encryptionKey: home.machineEncryptionKey, encryptionVariant: 'dataKey' as const }
        : { encryptionMode: 'plain' as const };
    const rpc = new RpcHandlerManager({
        scopePrefix: home.machineId, localMachineId: home.machineId, ...machineContent,
        resolveExternalActionEncryption: resolveEncryption,
        prepareRequesterAccountContext,
        authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, {
            machineId: home.machineId,
            resolveCustodianAccountId: async () => home.accountId,
            resolveInstallationId: () => home.installationId,
            verifyMachineAdmission: admission => verifyMachineRpcAdmissionCurrent({
                ...admission, privateKey: home.keys.secretKey, daemonToken, serverHttpBaseUrl: home.baseUrl,
            }),
        }, source),
    });
    registerExternalActionRpcHandler(rpc, {
        machineId: home.machineId, currentServerId: home.serverId, currentServerHttpBaseUrl: home.baseUrl,
        resolveAccountId: async () => home.accountId,
        resolveInstallationId: () => home.installationId,
        verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({
            ...request, installationId: home.installationId, privateKey: home.keys.secretKey, serverHttpBaseUrl: home.baseUrl,
        }),
        resolveTarget,
        prepareRequesterAccountContext,
        resolveEncryption, executor, externalActionMachineRequestPrivateKey: home.keys.secretKey,
    });
    if (input.resolveDeploymentRequesterIdentity) {
        registerDaemonDeploymentChildRpcHandler(rpc, {
            machineId: home.machineId, signal: daemonLifetime.signal,
            resolveRequesterIdentity: input.resolveDeploymentRequesterIdentity,
            resolveRequesterRuntime: ingress => resolveAdmittedRequesterAccountReadRuntime({
                ingress, serverId: home.serverId, machineId: home.machineId, installationId: home.installationId,
                isInstalledCurrent: () => !daemonLifetime.signal.aborted,
            }),
            resolveInstalledRuntime: async (signal, accountId) => signal.aborted || accountId !== home.accountId ? null : {
                serverId: home.serverId, machineId: home.machineId, accountId: home.accountId,
                credentials: readS0ControllerCredentials(home), serverHttpBaseUrl: home.baseUrl,
                isCurrent: async () => !signal.aborted && !daemonLifetime.signal.aborted,
            },
            acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
        });
    }
    registerActionOperationRpcHandlers(rpc, actionOperations.handlers);
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor });
    registerDaemonLocalServicesMachineRpcHandlers(rpc, { machineId: home.machineId, serverId: home.serverId,
        accountId: home.accountId, projectManagedServices: input.projectManagedServices,
        resolveLauncherActionExecutor: () => executor });
    const methods: string[] = [EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
        ...(input.resolveDeploymentRequesterIdentity ? [RPC_METHODS.DAEMON_DEPLOYMENT_CHILD] : []),
        ...collectActionSpecRpcMethodsForScopes(ACTION_SPECS, APPROVAL_RPC_SCOPES),
        RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE,
        ...Object.values(ACTION_OPERATION_RPC_METHODS_V1), ...Object.values(ACTION_OPERATION_RPC_METHODS_V2),
        ...(input.projectManagedServices ? [RPC_METHODS.DAEMON_SERVICE_MOVE_START_CLAIM, RPC_METHODS.MACHINES_SERVICE_LOGS_READ] : [])];
    const machineSocket = io(home.baseUrl, {
        path: '/v1/updates', transports: ['websocket'], autoConnect: false, reconnection: false,
        auth: {
            token: daemonToken, clientType: 'machine-scoped', machineId: home.machineId, installationId: home.installationId,
            installationPublicKey: encodeBase64(home.keys.publicKey, 'base64url'),
            installationProof: signMachineInstallationProof({
                payload: { version: 1, installationId: home.installationId, machineId: home.machineId, accountId: home.accountId },
                privateKey: home.keys.secretKey,
            }),
            ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        },
    });
    const receivedMethods: string[] = [];
    const isolationMachine = input.isolationWorkspace || input.installRolesReceiver === true ? await runWithServerHttpBaseUrl(home.baseUrl, async () => {
        const api = await ApiClient.create(credentials);
        const machine = await api.getMachine(home.machineId);
        if (!machine) throw new Error('S0 requires this same enrolled Machine publication');
        return machine;
    }) : null;
    const isolationCodec = createMachineContentCodec(machineContent);
    const readIsolation = () => isolationMachine ? readAgentIsolationSnapshot({
        metadata: readOpenedMachineMetadataSnapshot(isolationMachine, true), daemonState: isolationMachine.daemonState,
        runtimeId: 's0-daemon', platform: 'linux',
    }) : null;
    const isolationNative = isolationMachine && input.isolationWorkspace ? createAgentIsolationEffectsBoundary({
        ...(input.nativeBoundary ? { backend: input.nativeBoundary.backend } : {}),
        installationId: home.installationId, installedCli: '/opt/happier/cli/current/happier',
        readRoots: () => [input.isolationWorkspace!], readSessionsToReplace: () => 0,
        publishStatus: async status => { isolationMachine.daemonState = {
            ...(isolationMachine.daemonState ?? { status: 'running' }), runtimeId: 's0-daemon', agentIsolation: status,
        }; },
    }) : null;
    const captureMetadataPort = () => {
        if (!isolationMachine) throw new Error('Machine isolation metadata is unavailable');
        return { read: async () => readOpenedMachineMetadataSnapshot(isolationMachine, true),
            compareAndSwap: (mutation: Parameters<typeof publishMachineMetadataOnce>[1]) => publishMachineMetadataOnce({ getMachine: () => isolationMachine,
                socket: machineSocket, codec: isolationCodec, expectedDataEncryptionKey: isolationMachine.dataEncryptionKey ?? null,
                isContentCurrent: () => true, retireAndRefreshContent: async () => {}, notifyMetadataChanged() {},
            }, mutation) };
    };
    const roles = isolationMachine && input.installRolesReceiver !== false ? createMachineRolesRuntime({
        port: captureMetadataPort(), readPluginCatalog: () => machineRoleCatalogFromPluginsV1(
            (pluginReloadController.getState().activeRegistry?.contributes.machineRoles ?? [])
                .map(entry => ({ pluginId: entry.pluginId, declaration: entry.definition }))),
    }) : null;
    const releaseRoleAdmission = input.installRolesReceiver === true && roles
        ? bindMachineRoleAdmission(() => roles.appliedMetadata()) : undefined;
    const releaseRoleCatalog = roles ? pluginReloadController.subscribe(() => roles.refreshCatalog()) : undefined;
    if (roles) {
        await roles.reload();
        registerDaemonMachineRolesRpcHandlers(rpc, { roles, target: () => ({ serverId: home.serverId,
            machineId: home.machineId, installationId: home.installationId, custodianAccountId: home.accountId }) });
        methods.push(RPC_METHODS.MACHINES_ROLES_SET);
    }
    const daemonStatePublication = isolationMachine ? createMachineDaemonStatePublication({
        getMachine: () => isolationMachine, shouldSuppress: () => daemonLifetime.signal.aborted,
        prepareWrite: async () => ({ socket: machineSocket, codec: isolationCodec,
            expectedDataEncryptionKey: isolationMachine.dataEncryptionKey ?? null, isCurrent: () => !daemonLifetime.signal.aborted }),
        retireAndRefreshContent: async () => {}, needsPersistedIrohEndpointWithdrawal: () => false,
        acknowledgeDaemonStatePublication() {}, discardUnverifiedIrohEndpoint: state => state,
        synchronizeIrohMachineEndpointAuthority: async () => {},
    }) : null;
    if (isolationNative && isolationMachine) {
        if (!input.nativeBoundary || !input.isolationReadinessSystem) throw new Error('S0 isolation must consume its enrolled guest OS boundary and readiness system');
        const adminObserver = createMachineAdminAccessObserver({ ...input.nativeBoundary.admin, onChanged: async () => {} });
        const elevation = { ...isolationNative.effects.elevation,
            observe: async () => (await adminObserver.inspect()).observation,
            readPolicy: async () => {
                const state = readMachineAdminAccessV1(isolationMachine.metadata);
                if (state.status !== 'ready') throw new Error('The enrolled administrator policy is unavailable');
                return state.policy;
            },
        };
        const adminHost = createMachineAdminAccessHost(elevation);
        const productionIsolation = createDaemonAgentIsolationEffects({ getMachineClient: () => null,
            adminAccess: { target: () => ({ serverId: home.serverId, machineId: home.machineId,
                installationId: home.installationId, custodianAccountId: home.accountId }), observer: adminObserver },
            readRoots: isolationNative.effects.readRoots,
            trackedSessions: new Map(),
            protectedRoots: [], privateRoots: [configuration.happyHomeDir],
        });
        if (!productionIsolation.nativeReadiness) throw new Error('The production daemon must wire native isolation qualification');
        registerDaemonMachineAdminAccessRpcHandlers(rpc, {
            target: () => ({ serverId: home.serverId, machineId: home.machineId,
                installationId: home.installationId, custodianAccountId: home.accountId }),
            observer: adminObserver, reconcile: adminHost.reconcile, captureMetadataPort,
            runActionOperation: actionOperations.runActionOperation,
        });
        registerDaemonMachineAgentIsolationRpcHandlers(rpc, {
            runActionOperation: actionOperations.runActionOperation,
            target: () => ({ serverId: home.serverId, machineId: home.machineId,
                installationId: home.installationId, custodianAccountId: home.accountId }),
            read: () => readIsolation()!, effects: { ...isolationNative.effects, elevation,
                nativeReadiness: { ...productionIsolation.nativeReadiness, system: input.isolationReadinessSystem } },
            captureMetadataPort,
        });
        methods.push('machines.agentIsolation.preview', 'machines.agentIsolation.set', 'machines.setup.adminAccess.inspect', 'machines.setup.adminAccess.set');
    }
    methods.push(...await input.configureRpc?.(rpc, { isolationNative, readIsolation, captureMetadataPort }) ?? []);
    machineSocket.on('disconnect', () => rpc.onSocketDisconnect());
    machineSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request: SocketRpcRequestPayload, acknowledge: (response: unknown) => void) => {
        receivedMethods.push(request.method);
        void (async () => {
            await input.observeReceivedRequest?.(request);
            return installationBoundary.run(readS0Installation(home), () => rpc.handleRequest(request, undefined, 'authenticated_home_socket'));
        })().then(acknowledge);
    });
    let closed = false;
    let presenceInterval: ReturnType<typeof setInterval> | undefined;
    const close = async () => {
        if (closed) return;
        closed = true;
        clearInterval(presenceInterval);
        daemonLifetime.abort();
        releaseRoleCatalog?.();
        releaseRoleAdmission?.();
        roles?.stop();
        rpc.cancelTransportRequests();
        for (const method of methods) rpc.unregisterHandler(method);
        machineSocket.close();
        rpc.onSocketDisconnect();
    };
    try {
        await new Promise<void>((resolve, reject) => {
            machineSocket.once('connect', resolve);
            machineSocket.once('connect_error', reject);
            machineSocket.connect();
        });
        rpc.onSocketConnect(machineSocket);
        // Same machine-control registration budget used by ApiMachineClient;
        // this fixture does not impose a shorter Action or operation deadline.
        const readiness = await rpc.waitForRegisteredHandlers(methods, { timeoutMs: 10_000 });
        expect(readiness, JSON.stringify(readiness)).toMatchObject({ status: 'ready' });
        // Advertise only the signed ingress actually installed above, through
        // the same authenticated publisher as the production Machine client.
        await publishMachineOperationProtocolCapabilitiesOnSocket({ socket: machineSocket, machineId: home.machineId,
            capabilities: { ...input.operationProtocolCapabilities, externalActionExecutionAuthorization:
                CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1.externalActionExecutionAuthorization } });
        // This raw process boundary stands in for ApiMachineClient, including
        // its authenticated alive publication. Registration alone is not an
        // online observation for a newly enrolled (initially inactive) row.
        const publishPresence = () => machineSocket.emit('machine-alive', { machineId: home.machineId, time: Date.now() });
        publishPresence();
        // Mirror ApiMachineClient's existing 20-second process heartbeat for
        // the retained enrollment controller as well as the guest transport.
        presenceInterval = setInterval(publishPresence, 20_000);
        await expect.poll(async () => runWithServerHttpBaseUrl(home.baseUrl,
            async () => (await readPublishedMachineRow(home.machineId, credentials))?.active), { timeout: 300_000 }).toBe(true);
        return { actionOperations, executor, publishDaemonState: daemonStatePublication,
            externalActionIngressOwner: { currentServerId: home.serverId, currentServerHttpBaseUrl: home.baseUrl,
                prepareRequesterAccountContext, resolveEncryption, executor,
                resolveTarget,
                externalActionMachineRequestPrivateKey: home.keys.secretKey },
            machineActionDirectTargetTransport: { machineId: home.machineId,
                invoke: (method: string, request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => rpc.invokeLocal(method, request, options) },
            readReceivedMethods: (): readonly string[] => [...receivedMethods],
            observeRecordedApprovalExecution: executor.observeRecordedApprovalExecution,
            readIsolation, isolationNative, close };
    } catch (error) { await close(); throw error; }
}
