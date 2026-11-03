import type { ApiClient } from '@/api/api';
import type { DaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import type {
  ApiMachineClient,
  ApiMachineClientLifecycleDependencies,
} from '@/api/apiMachine';
import type { DaemonState } from '@/api/types';
import type { ConnectedServiceQuotasLoopHandle } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import type { MachineLiveStreamControlLeaseV1, WorkspaceSyncRuntimeReadinessV1, WorkspaceSyncStatusV1 } from '@happier-dev/protocol';
import { doesRunnerBrokerReadinessResponseMatchRequestV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';
import { logger } from '@/ui/logger';
import type { AutomationWorkerHandle, startAutomationWorker } from '../automation/automationWorker';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
import type { VoiceInferenceWorkerHandle } from '../voiceInference/voiceInferenceWorker';
import type { DaemonPublicVoiceModelPackRuntime } from '../voiceInference/publicModelPacks/runtime';
import { resolveVoiceInferencePaths } from '../voiceInference/voiceInferencePaths';
import { configuration } from '@/configuration';
import { watchLastCliUpdateResult } from '@happier-dev/cli-common/firstPartyRuntime';
import { readCliUpdateFactsForThisCli } from '@/cli/runtime/update/cliUpdateFacts';
import type { startDaemonMachineRegistration } from '../machine/startDaemonMachineRegistration';
import {
  createDaemonMachineLiveStreamCaptureAdapter,
  type MachineLiveStreamCaptureRegistry,
} from '../peer/mediation/stream';
import type { DaemonPeerMediationObservabilityEmitter } from '../peer/mediation/observability/events';
import type { StoredCredentials } from '@/persistence';
import type { NormalizedLocalServiceInventorySnapshot } from '../local/services/inventory/scanner';
import type { LocalServicesDaemonRuntime } from '../local/services/runtime';
import type { MachineResourceSummary } from '../resources/machineResourceSummary';
import packageJson from '../../../package.json';
import type { PersistedTakeoverAdmissionWaiter } from '../spawn/persistedTakeoverAdmission';
import type {
  ExternalSessionPersistedTakeoverAdmissionOwner,
} from '@/session/actions/externalSessions/persistedTakeoverAdmission';
import type {
  ExternalSessionHostOperationInstallation,
  ExternalSessionHostOperationSet,
} from '@/session/external/hostOperationOwner';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { MemorySettingsSecretsUnavailableError } from '@/settings/memorySettingsErrors';
import type { DaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import type { createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';
import type { WorkflowRecoveryTrigger } from '@/daemon/workflows/recovery';
import { createRunnerBrokerReadinessApplicationLifecycle } from '../peer/mediation/loopback/runnerBrokerReadinessApplication';
import type { StartPeerMediationLoopbackInput } from '../peer/mediation/rpc/startLoopback';
import type { DaemonProviderBrokerRuntime } from '@/providers/broker/daemonProviderBrokerRuntime';
import type { ExecutionRunTeamCredentialProviderBindingPreparer } from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';
import type { ExecutionRunManagedProviderSourceOpener } from '@/agent/runtime/bridges/executionRun/runtime/managedProvider';
import type { DirectRouteGrantTrustRoot } from '../peer/mediation/verifyDirectRouteGrant';
import type { ManagedActivityRpcOwner } from '@/api/machine/rpcHandlers.managedActivity';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readInstallationIdentityIfExistsSync } from '../identity/store';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import type { prepareRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';
import { readRequesterHomeWithinActionLifetime } from '../sessionEncryption/requesterCurrentness';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';

/** The installed host's passive source Action composition; it never reads a remote OS path. */
export function createProjectFiniteSourceManifestInspector(params: Readonly<{
  api: Pick<ApiClient, 'getMachine'>;
  credentials: StoredCredentials;
  serverId: string;
  serverHttpBaseUrl: string;
  accountId: string;
  ingress: RpcHandlerContext;
  isCurrent(): Promise<boolean>;
}>): NonNullable<ProjectFiniteActionRuntime['inspectSourceProjectManifest']> {
  return async ({ source, signal }) => {
    const phase = async <T>(name: string, read: () => T | Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      let status: 'completed' | 'failed' = 'failed';
      try { const result = await read(); status = 'completed'; return result; }
      finally { logger.debug('[ProjectDefinition] source inspection phase', { phase: name, status,
        requestId: params.ingress.callerInputAuthorization?.binding.requestId,
        transportRequestId: params.ingress.transportRequestId, machineId: source.machineId,
        durationMs: Math.round(performance.now() - startedAt) }); }
    };
    const [
      { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId },
      { ProjectDefinitionInspectOutputSchema },
      { buildActionExecutorContextForRpc },
    ] = await Promise.all([
      import('@/server/serverProfiles'),
      import('@happier-dev/protocol/actions/projectDefinitionActionFamily'),
      import('@/rpc/handlers/_actionDispatchAdapter'),
    ]);
    const sourceSignal = AbortSignal.any([params.ingress.signal, signal]);
    const assertSourceCurrent = async () => {
      if (sourceSignal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      if (!await params.isCurrent()) throw Object.assign(new Error('project_requester_credentials_unavailable'), { code: 'project_requester_credentials_unavailable' });
      if (sourceSignal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    };
    if (!await isServerProfileHomeIdentity(params.serverId, source.serverId)) throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
    const assertSourceCustody = async () => {
      await assertSourceCurrent();
      let machine: Awaited<ReturnType<ApiClient['getMachine']>>;
      try {
        machine = await runWithServerHttpBaseUrl(params.serverHttpBaseUrl,
          () => params.api.getMachine(source.machineId, { signal: sourceSignal }));
      } catch {
        await assertSourceCurrent();
        throw Object.assign(new Error('project_source_declaration_unavailable'), { code: 'project_source_declaration_unavailable' });
      }
      await assertSourceCurrent();
      if (machine?.id !== source.machineId || machine.access?.custodian.accountId !== params.accountId) {
        throw Object.assign(new Error('project_requester_credentials_unavailable'), { code: 'project_requester_credentials_unavailable' });
      }
    };
    await phase('custody_before', assertSourceCustody);
    const serverIdentityId = await resolveServerProfileHomeIdentityId(params.serverId);
    const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: params.credentials, serverId: params.serverId,
      serverApiUrl: params.serverHttpBaseUrl, machineId: source.machineId,
      ...(serverIdentityId ? { serverIdentityId } : {}),
      pluginActionExecutionOwner: 'current_process',
      readCredentials: async () => { await assertSourceCurrent(); return params.credentials; },
    });
    const context = buildActionExecutorContextForRpc({
      serverId: params.serverId, signal: sourceSignal,
      callerAuthority: params.ingress.callerAuthority, sessionActionOrigin: params.ingress.sessionActionOrigin,
      localActionContext: params.ingress.localActionContext, runtimeAccountId: params.accountId,
    });
    let result: Awaited<ReturnType<typeof executor.execute>>;
    try {
      result = await phase('source_action', () => runTracedExternalActionStage('projects.inspect',
        params.ingress.callerInputAuthorization?.binding.requestId ?? params.ingress.transportRequestId,
        'source_inspection', () => executor.execute('projects.inspect', { workspace: {
        serverId: source.serverId, workspaceId: source.id,
        machineId: source.machineId, rootPath: source.rootPath,
      } }, { ...context,
        ...(!params.ingress.localActionContext?.surface && !params.ingress.sessionActionOrigin ? { surface: 'api' as const } : {}),
        externalActionTarget: { kind: 'machine', machineId: source.machineId },
      })));
    } catch (error) {
      await assertSourceCurrent();
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'project_source_declaration_unavailable';
      throw Object.assign(new Error(code), { code });
    }
    await assertSourceCurrent();
    if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
    const output = ProjectDefinitionInspectOutputSchema.safeParse(result.result);
    if (!output.success) throw Object.assign(new Error('project_source_declaration_unavailable'), { code: 'project_source_declaration_unavailable' });
    await phase('custody_after', assertSourceCustody);
    return { ...output.data.definition, commands: output.data.commands,
      environmentExecutionInputs: output.data.environmentExecutionInputs };
  };
}

type BootstrapRuntime = Omit<
  Parameters<typeof startDaemonMachineRegistration>[0]['bootstrapRuntime'],
  | 'preferredHost'
  | 'happyHomeDir'
  | 'happyLibDir'
  | 'filesystemAccessPolicy'
  | 'takeoverRequested'
  | 'connectedServiceRefreshLoopHandle'
  | 'connectedServiceQuotasLoopHandle'
>;

type MachineSyncRuntime = Parameters<typeof startDaemonMachineRegistration>[0]['onMachineSyncRuntime'] extends (
  runtime: infer Runtime,
) => void
  ? Runtime
  : never;

export function createDaemonMachineBootstrapRuntime(
  params: Readonly<{
    api: ApiClient;
    controlPort: number;
    onMachineControlReadinessChange?: ApiMachineClientLifecycleDependencies['onMachineControlReadinessChange'];
    credentials: StoredCredentials;
    requesterServerId?: BootstrapRuntime['requesterServerId'];
    resolveCurrentMachineExecutionOriginContext?: BootstrapRuntime['resolveCurrentMachineExecutionOriginContext'];
    resolveRequesterSessionRuntimeContext?: BootstrapRuntime['resolveRequesterSessionRuntimeContext'];
    readRequesterSessionCredentialBindings?: BootstrapRuntime['readRequesterSessionCredentialBindings'];
    releaseRequesterSessionRuntimeContext?: BootstrapRuntime['releaseRequesterSessionRuntimeContext'];
    dispatchSessionFollowOccurrence?: BootstrapRuntime['dispatchSessionFollowOccurrence'];
    stopRequesterSessionForHandoff?: (sessionId: string, expectedSpawnNonce: string) => Promise<'stopped' | 'already_inactive' | 'failed'>;
    daemonSessionMutationCustody?: DaemonSessionMutationCustody;
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
    workspaceSyncHandoffAdapter?: WorkspaceSyncHandoffAdapter;
    workspaceSync?: ApiMachineClientLifecycleDependencies['workspaceSync'];
    onMachineMetadataChanged?: ApiMachineClientLifecycleDependencies['onMachineMetadataChanged'];
    onProjectOperationInspection?: ApiMachineClientLifecycleDependencies['onProjectOperationInspection'];
    createWorkspaceSyncRuntime?: (input: Readonly<{
      machineId: string;
      onReadinessPublished(readiness: WorkspaceSyncRuntimeReadinessV1): void;
      onStatusPublished(status: WorkspaceSyncStatusV1): void;
    }>) => Promise<Readonly<{
      handoffAdapter: WorkspaceSyncHandoffAdapter;
      workspaceSync: NonNullable<ApiMachineClientLifecycleDependencies['workspaceSync']>;
      createProjectFiniteRuntime?: ApiMachineClientLifecycleDependencies['createProjectFiniteRuntime'];
      readProjectFiniteLoad?: ApiMachineClientLifecycleDependencies['readProjectFiniteLoad'];
    }>> | Readonly<{
      handoffAdapter: WorkspaceSyncHandoffAdapter;
      workspaceSync: NonNullable<ApiMachineClientLifecycleDependencies['workspaceSync']>;
      createProjectFiniteRuntime?: ApiMachineClientLifecycleDependencies['createProjectFiniteRuntime'];
      readProjectFiniteLoad?: ApiMachineClientLifecycleDependencies['readProjectFiniteLoad'];
    }>;
    runtimeId: string;
    publicReleaseChannel: NonNullable<DaemonState['publicReleaseChannel']>;
    startupSource: string;
    serviceLabel: string | undefined;
    transferRuntimeStatePublisher: Readonly<{
      attachApiMachine: (connectedApiMachine: NonNullable<MachineSyncRuntime['apiMachine']>) => Promise<void>;
    }> | null;
    spawnSession: BootstrapRuntime['spawnSession'];
    spawnSessionForInternalResume: BootstrapRuntime['spawnSessionForInternalResume'];
    onActivationRejected?: BootstrapRuntime['onActivationRejected'];
    stopSession: BootstrapRuntime['stopSession'];
    sessionRunnerStatus?: BootstrapRuntime['sessionRunnerStatus'];
    awaitAgentSessionOpen: BootstrapRuntime['awaitAgentSessionOpen'];
    isSessionAlreadyRunning: BootstrapRuntime['isSessionAlreadyRunning'];
    loadLocalSessionMetadataForHandoff: BootstrapRuntime['loadLocalSessionMetadataForHandoff'];
    resolveHostedSessionWorkingDirectory?: (sessionId: string) => Promise<string | null>;
    beforeShutdown: BootstrapRuntime['beforeShutdown'];
    requestShutdown: BootstrapRuntime['requestShutdown'];
    directPeerServerLifecycle: BootstrapRuntime['directPeerServerLifecycle'];
    machineIrohRuntime?: BootstrapRuntime['machineIrohRuntime'];
    prepareServerTransportForReconnect?: BootstrapRuntime['prepareServerTransportForReconnect'];
    acquireWorkspaceSyncMachineIngress?: BootstrapRuntime['acquireWorkspaceSyncMachineIngress'];
    acquireLocalServicePreviewApplication?: BootstrapRuntime['acquireLocalServicePreviewApplication'];
    directTransferRegistryHost: BootstrapRuntime['directTransferRegistryHost'];
    daemonServerWorkScheduler: BootstrapRuntime['daemonServerWorkScheduler'];
    publicProfileRefreshHandle?: BootstrapRuntime['publicProfileRefreshHandle'];
    cancelConnectedServiceRuntimeAuthRecovery?: BootstrapRuntime['cancelConnectedServiceRuntimeAuthRecovery'];
    checkRuntimeAuthUsageLimitRecovery?: BootstrapRuntime['checkRuntimeAuthUsageLimitRecovery'];
    retryTemporaryThrottleNow?: BootstrapRuntime['retryTemporaryThrottleNow'];
    readTemporaryThrottleRecovery?: BootstrapRuntime['readTemporaryThrottleRecovery'];
    cancelTemporaryThrottleRecovery?: BootstrapRuntime['cancelTemporaryThrottleRecovery'];
    setDaemonServerWorkOnline: BootstrapRuntime['setDaemonServerWorkOnline'];
    onMachineConnectionOnline: NonNullable<BootstrapRuntime['onMachineConnectionOnline']>;
    orphanedDeadDaemonSessions?: BootstrapRuntime['orphanedDeadDaemonSessions'];
    reconcileConnectedServicesProjection: Parameters<ApiMachineClient['onConnectedServicesProjection']>[0];
    subscribeConnectedAccountInvalidations?: BootstrapRuntime['subscribeConnectedAccountInvalidations'];
    isShuttingDown: BootstrapRuntime['isShuttingDown'];
    admissionDrain?: DaemonAdmissionDrain;
    managedActivity?: Pick<ManagedActivityRpcOwner, 'activity' | 'admissionDrain'>;
    machineReboot?: ApiMachineClientLifecycleDependencies['machineReboot'];
    isPublicationQuiescing?: () => boolean;
    readSpawnFailureLimits?: ApiMachineClientLifecycleDependencies['readSpawnFailureLimits'];
    ownerRemainder?: ApiMachineClientLifecycleDependencies['ownerRemainder'];
    getServerFeaturesSnapshot?: BootstrapRuntime['getServerFeaturesSnapshot'];
    resolvePeerMediationTrustRoots?: () => readonly DirectRouteGrantTrustRoot[];
    refreshServerFeaturesSnapshot?: ApiMachineClientLifecycleDependencies['resolveServerFeaturesSnapshot'];
    liveStreamCaptureRegistry?: MachineLiveStreamCaptureRegistry;
    readActiveLiveStreamControlLease?: (leaseInput: Readonly<{
      streamId: string;
      sourceId: string;
      nowMs: number;
    }>) => MachineLiveStreamControlLeaseV1 | null;
    // PMS-WIRE: shared observability emitter whose store is published on the Api provider bridge.
    peerMediationObservabilityEmitter?: DaemonPeerMediationObservabilityEmitter;
    readLocalServiceInventorySnapshot?: () => Promise<NormalizedLocalServiceInventorySnapshot | null>;
    localServiceSummary?: Pick<LocalServicesDaemonRuntime, 'getSummary' | 'subscribeSummary' | 'refreshInventoryNow'>;
    machineResourceSummary?: MachineResourceSummary;
    resolveManagedPurposeBindingIntent?: BootstrapRuntime['resolveManagedPurposeBindingIntent'];
    resolveManagedPurposeBindingIntentSelection?: BootstrapRuntime['resolveManagedPurposeBindingIntentSelection'];
    mcpServers?: BootstrapRuntime['mcpServers'];
    openTeamDirect?: BootstrapRuntime['openTeamDirect'];
    prepareRunTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
    openAccountConnectionManagedConsumerSource?: ExecutionRunManagedProviderSourceOpener;
    createAgentCatalogObservation?: BootstrapRuntime['createAgentCatalogObservation'];
    onAutomationWorkerStarted?: (worker: AutomationWorkerHandle) => void;
    onPublicVoiceModelPackRuntimeReady?: (runtime: DaemonPublicVoiceModelPackRuntime | null) => void;
    /** Live canonical Workflow feature decision. Missing/unknown remains disabled. */
    isWorkflowFeatureEnabled?: () => boolean;
    prepareApiMachineForSessions?: (apiMachine: ApiMachineClient) => void;
    persistedTakeoverAdmissionWaiter?: PersistedTakeoverAdmissionWaiter;
    attachPersistedTakeoverAdmissionOwner?: (
      owner: ExternalSessionPersistedTakeoverAdmissionOwner,
    ) => () => void;
    installExternalSessionHostOperations?: (
      operations: ExternalSessionHostOperationSet,
    ) => Promise<ExternalSessionHostOperationInstallation>;
    readMaterializedStateObservationBinding?: BootstrapRuntime['readMaterializedStateObservationBinding'];
    resolveExecutionRunLiveBrokerAuthority?: BootstrapRuntime['resolveExecutionRunLiveBrokerAuthority'];
    externalActionIngressOwner?: ExternalActionIngressOwner;
    createWorkflowRunCoordinatorForMachine?: (input: Readonly<{
      machineId: string;
      requesterWorkAttributionV1?: RequesterWorkAttributionV1;
      machineAdmissionTransport: NonNullable<Parameters<typeof startAutomationWorker>[0]['machineAdmissionTransport']>;
      machineActionDirectTargetTransport: import('@/session/actions/createCliActionDeps').MachineActionDirectTargetTransport;
    }>) => ReturnType<typeof createProductionWorkflowRunCoordinator>;
    createWorkflowRecoveryForMachine?: (input: Readonly<{
      machineId: string;
      machineAdmissionTransport: NonNullable<Parameters<typeof startAutomationWorker>[0]['machineAdmissionTransport']>;
      machineActionDirectTargetTransport: import('@/session/actions/createCliActionDeps').MachineActionDirectTargetTransport;
    }>) => (trigger: WorkflowRecoveryTrigger) => Promise<void>;
    /** Starts the provider-broker application against the authoritative
     * registered Machine identity. A successful installation — never a
     * manifest or schema — is what makes the daemon advertise
     * `providerBrokerIngress`. */
    startProviderBrokerApplication?: (input: Readonly<{
      machineId: string;
      apiMachine: ApiMachineClient;
    }>) => Promise<Readonly<{
      accountConnectionIngress?: boolean;
      resolveProviderBrokerApplicationTarget: NonNullable<NonNullable<
        StartPeerMediationLoopbackInput['irohMachineAdmission']
      >['resolveProviderBrokerApplicationTarget']>;
      resolveExternalProviderBrokerApplicationTarget:
        DaemonProviderBrokerRuntime['resolveExternalProviderBrokerApplicationTarget'];
      checkRunnerCredentialSelectionCurrentness:
        DaemonProviderBrokerRuntime['checkRunnerCredentialSelectionCurrentness'];
      close(): Promise<void>;
    }>>;

agentIsolation?: ApiMachineClientLifecycleDependencies['agentIsolation'];
}>,
): BootstrapRuntime & Pick<ApiMachineClient, 'retireProjectFiniteExecution'> {
  // The same authenticated constructor facts used by Machine work-summary
  // composition. A later claim cannot choose its Account, Home or installation.
  const automationHomeId = params.requesterServerId ?? configuration.activeServerId;
  const machineSkillHomeUrl = resolveServerHttpBaseUrl();
  const automationAccountId = readAccountIdFromToken(params.credentials.token);
  const automationInstallationId = readInstallationIdentityIfExistsSync()?.installationId;
  const runnerBrokerReadinessApplication = createRunnerBrokerReadinessApplicationLifecycle({
    authorize: async (request, signal) => await params.api.authorizeRunnerBrokerReadiness(request, signal),
    checkLocalCurrentness: async (currentness, signal) => await providerBrokerApplication
      ?.checkRunnerCredentialSelectionCurrentness(currentness, signal) ?? 'update_required',
  });
  let connectedApiMachine: ApiMachineClient | null = null;
  let unsubscribeLocalServiceSummary: (() => void) | null = null;
  let unsubscribeLocalServiceConnection: (() => void) | null = null;
  let unsubscribeResourcePublication: (() => void) | null = null;
  let providerBrokerApplication: Awaited<ReturnType<NonNullable<
    typeof params.startProviderBrokerApplication
  >>> | null = null;
  let providerBrokerApplicationMachineId: string | null = null;
  let providerBrokerApplicationApiMachine: ApiMachineClient | null = null;
  let workflowRecovery: ((trigger: WorkflowRecoveryTrigger) => Promise<void>) | null = null;
  let workspaceSyncReadiness: WorkspaceSyncRuntimeReadinessV1 | null = null;
  let workspaceSyncPublicationTail = Promise.resolve();
  const publishWorkspaceSyncEvent = (): void => {
    workspaceSyncPublicationTail = workspaceSyncPublicationTail.catch(() => undefined).then(async () => {
      const apiMachine = connectedApiMachine;
      const readiness = workspaceSyncReadiness;
      if (!apiMachine || !readiness || (params.isPublicationQuiescing ?? params.isShuttingDown)()) return;
      await apiMachine.updateDaemonState((state) => ({
        ...(state ?? { status: 'running' as const }),
        workspaceSync: {
          v: 1 as const,
          readiness,
        },
      }));
    });
    void workspaceSyncPublicationTail.catch(() => undefined);
  };
  const publishWorkspaceSyncStatus = (): void => {
    // A daemon-state version advance invalidates demanded private reads. The
    // admitted relationship owner, never this share-wide blob, supplies detail.
    publishWorkspaceSyncEvent();
  };
  const publishWorkspaceSyncReadiness = (readiness: WorkspaceSyncRuntimeReadinessV1): void => {
    workspaceSyncReadiness = readiness;
    publishWorkspaceSyncEvent();
  };
  let workspaceSyncService: ApiMachineClientLifecycleDependencies['workspaceSync'];
  return {
    // Routing attachment may fail after this client has accepted finite work.
    // Retire its existing custody even while attempt cleanup is still awaiting
    // another resource and the session-facing routing projection is null.
    retireProjectFiniteExecution: async () => await connectedApiMachine?.retireProjectFiniteExecution(),
    cliVersion: packageJson.version,
    // K5 (plan R13): published with the daemon-owned metadata and republished on each update outcome.
    readCliUpdateFacts: readCliUpdateFactsForThisCli,
    watchCliUpdateRecord: (onChange) => watchLastCliUpdateResult({
      channel: configuration.publicReleaseRing,
      processEnv: { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir },
      onChange,
      onError: (error) => logger.warn('[DAEMON RUN] Stopped watching the CLI update record; the next daemon start republishes it', error),
    }),
    credentials: params.credentials,
    publicProfileRefreshHandle: params.publicProfileRefreshHandle,
    ...(params.requesterServerId ? { requesterServerId: params.requesterServerId } : {}),
    ...(params.resolveCurrentMachineExecutionOriginContext
      ? { resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext } : {}),
    ...(params.resolveRequesterSessionRuntimeContext
      ? { resolveRequesterSessionRuntimeContext: params.resolveRequesterSessionRuntimeContext } : {}),
    ...(params.readRequesterSessionCredentialBindings
      ? { readRequesterSessionCredentialBindings: params.readRequesterSessionCredentialBindings } : {}),
    ...(params.releaseRequesterSessionRuntimeContext
      ? { releaseRequesterSessionRuntimeContext: params.releaseRequesterSessionRuntimeContext } : {}),
    ...(params.dispatchSessionFollowOccurrence
      ? { dispatchSessionFollowOccurrence: params.dispatchSessionFollowOccurrence } : {}),
    ...(params.daemonSessionMutationCustody
      ? { daemonSessionMutationCustody: params.daemonSessionMutationCustody }
      : {}),
    ...(params.deviceLocalSecretStorage
      ? { deviceLocalSecretStorage: params.deviceLocalSecretStorage }
      : {}),
    daemonServerWorkScheduler: params.daemonServerWorkScheduler,
    setDaemonServerWorkOnline: params.setDaemonServerWorkOnline,
    onMachineConnectionOnline: params.onMachineConnectionOnline,
    orphanedDeadDaemonSessions: params.orphanedDeadDaemonSessions,
    isPublicationQuiescing: params.isPublicationQuiescing,
    reconcileConnectedServicesProjection: params.reconcileConnectedServicesProjection,
    recoverWorkflowRuns: async (trigger) => {
      await workflowRecovery?.(trigger);
    },
    ...(params.subscribeConnectedAccountInvalidations
      ? { subscribeConnectedAccountInvalidations: params.subscribeConnectedAccountInvalidations }
      : {}),
    ...(params.openTeamDirect ? { openTeamDirect: params.openTeamDirect } : {}),
    ...(params.prepareRunTeamCredentialProviderBinding
      ? { prepareRunTeamCredentialProviderBinding: params.prepareRunTeamCredentialProviderBinding }
      : {}),
    ...(params.openAccountConnectionManagedConsumerSource
      ? { openAccountConnectionManagedConsumerSource: params.openAccountConnectionManagedConsumerSource }
      : {}),
    isShuttingDown: params.isShuttingDown,
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
    ...(params.machineIrohRuntime ? { machineIrohRuntime: params.machineIrohRuntime } : {}),
    ...(params.prepareServerTransportForReconnect
      ? { prepareServerTransportForReconnect: params.prepareServerTransportForReconnect }
      : {}),
    ...(params.acquireWorkspaceSyncMachineIngress
      ? { acquireWorkspaceSyncMachineIngress: params.acquireWorkspaceSyncMachineIngress }
      : {}),
    ...(params.acquireLocalServicePreviewApplication
      ? { acquireLocalServicePreviewApplication: params.acquireLocalServicePreviewApplication }
      : {}),
    ...(params.getServerFeaturesSnapshot
      ? { getServerFeaturesSnapshot: params.getServerFeaturesSnapshot }
      : {}),
    ...(params.resolvePeerMediationTrustRoots
      ? { resolvePeerMediationTrustRoots: params.resolvePeerMediationTrustRoots }
      : {}),
    createConnectedApiMachine: async (registeredMachine) => {
      const { createMachineSkillHostService, resolveMachineSkillInstallTarget } = await import('@/prompts/skills/machineInstall/machineSkillHost');
      const workspaceRuntime = params.createWorkspaceSyncRuntime
          ? await params.createWorkspaceSyncRuntime({
            machineId: registeredMachine.id,
            onReadinessPublished: publishWorkspaceSyncReadiness,
            onStatusPublished: publishWorkspaceSyncStatus,
          })
        : null;
      const workspaceSyncHandoffAdapter = workspaceRuntime?.handoffAdapter
        ?? params.workspaceSyncHandoffAdapter;
      const workspaceSync = workspaceRuntime?.workspaceSync ?? params.workspaceSync;
      workspaceSyncService = workspaceSync;
      // Optional Skills demand is bound before connection; unavailable Home identity
      // does not prevent unrelated daemon startup. The next existing bootstrap may recover it.
      const machineSkillTarget = await resolveMachineSkillInstallTarget({ serverId: automationHomeId,
        serverHttpBaseUrl: machineSkillHomeUrl, machineId: registeredMachine.id }).catch(error => {
          logger.debug('[DAEMON RUN] Machine Skill install Home unavailable', { message: String(error) });
          return null;
        });
      if (!machineSkillTarget) logger.debug('[DAEMON RUN] Machine Skill installs require the current Home identity');
      const apiMachine = params.api.machineSyncClient(registeredMachine, {
            runtimeId: params.runtimeId,
            cliVersion: packageJson.version,
            publicReleaseChannel: params.publicReleaseChannel,
            startupSource: params.startupSource,
            serviceManaged: params.startupSource === 'background-service',
            ...(params.serviceLabel ? { serviceLabel: params.serviceLabel } : null),
          }, {
agentIsolation: params.agentIsolation,

            controlPort: params.controlPort,
            onMachineControlReadinessChange: params.onMachineControlReadinessChange,
            isDaemonQuiescing: params.isPublicationQuiescing ?? params.isShuttingDown,
            readSpawnFailureLimits: params.readSpawnFailureLimits,
            ownerRemainder: params.ownerRemainder,
            ...(machineSkillTarget ? { machineSkillInstalls: {
              target: machineSkillTarget, libraryServerIdentityId: machineSkillTarget.serverIdentityId,
              refresh: async ({ signal, artifactIds }) => {
                const { readStoredCredentialsForServerId, sameStoredCredentials } = await import('@/persistence');
                signal.throwIfAborted();
                if (params.isShuttingDown() || !sameStoredCredentials(params.credentials,
                  await readStoredCredentialsForServerId(automationHomeId))) return;
                signal.throwIfAborted();
                const currentTarget = await resolveMachineSkillInstallTarget({ serverId: automationHomeId,
                  serverHttpBaseUrl: machineSkillHomeUrl, machineId: registeredMachine.id, signal });
                if (!currentTarget || currentTarget.serverIdentityId !== machineSkillTarget.serverIdentityId) return;
                const service = createMachineSkillHostService({ credentials: params.credentials, serverId: automationHomeId,
                  serverHttpBaseUrl: machineSkillHomeUrl, target: currentTarget });
                const outcome = await service.refresh({ signal, ...(artifactIds ? { artifactIds } : {}) });
                if (outcome.row.status === 'conflict' || outcome.row.status === 'unavailable') {
                  logger.warn('[DAEMON RUN] Machine Skill refresh receipt unavailable', { status: outcome.row.status });
                }
              },
            } } : {}),
            ...(params.requesterServerId && params.resolveRequesterSessionRuntimeContext && params.releaseRequesterSessionRuntimeContext ? {
              requesterSessionRuntime: { serverId: params.requesterServerId,
                resolve: params.resolveRequesterSessionRuntimeContext, release: params.releaseRequesterSessionRuntimeContext,
                ...(params.stopRequesterSessionForHandoff ? { stopForHandoff: params.stopRequesterSessionForHandoff } : {}) },
            } : {}),
            ...(params.managedActivity ? { managedActivity: params.managedActivity } : {}),
            ...(params.machineReboot ? { machineReboot: params.machineReboot } : {}),
            ...(params.onMachineMetadataChanged ? { onMachineMetadataChanged: params.onMachineMetadataChanged } : {}),
            ...(params.onProjectOperationInspection ? { onProjectOperationInspection: params.onProjectOperationInspection } : {}),
            ...(params.directPeerServerLifecycle ? { directPeerServerLifecycle: params.directPeerServerLifecycle } : {}),
            ...(params.liveStreamCaptureRegistry ? { liveStreamCaptureRegistry: params.liveStreamCaptureRegistry } : {}),
            resolveHostedSessionWorkingDirectory: params.resolveHostedSessionWorkingDirectory,
            ...(workspaceSyncHandoffAdapter
              ? { workspaceSyncHandoffAdapter }
              : {}),
            ...(workspaceSync ? { workspaceSync } : {}),
            ...(workspaceRuntime?.createProjectFiniteRuntime
              ? { createProjectFiniteRuntime: workspaceRuntime.createProjectFiniteRuntime }
              : {}),
            ...(workspaceRuntime?.readProjectFiniteLoad
              ? { readProjectFiniteLoad: workspaceRuntime.readProjectFiniteLoad }
              : {}),
            ...(params.refreshServerFeaturesSnapshot || params.getServerFeaturesSnapshot
              ? {
                  resolveServerFeaturesSnapshot: async () =>
                    params.refreshServerFeaturesSnapshot
                      ? await params.refreshServerFeaturesSnapshot()
                      : params.getServerFeaturesSnapshot?.(),
                }
              : {}),
      });
      connectedApiMachine = apiMachine;
      unsubscribeResourcePublication?.();
      unsubscribeResourcePublication = params.machineResourceSummary?.attachPublication(apiMachine,
        () => connectedApiMachine !== apiMachine || (params.isPublicationQuiescing ?? params.isShuttingDown)()) ?? null;
      unsubscribeLocalServiceSummary?.();
      unsubscribeLocalServiceConnection?.();
      const localServices = params.localServiceSummary;
      if (localServices) {
        let online = false;
        const publishSummary = (): void => {
          if (!online || connectedApiMachine !== apiMachine || (params.isPublicationQuiescing ?? params.isShuttingDown)()) return;
          // The existing transport may defer/retry this handler. Read the live projection
          // at that boundary so an older attempt cannot restore a superseded count.
          void apiMachine.updateDaemonState((state) => ({
            ...(state ?? { status: 'running' as const }),
            localServices: localServices.getSummary(),
          })).catch((error) => logger.warn('[DAEMON RUN] Local-service summary publication failed', error));
        };
        unsubscribeLocalServiceSummary = localServices.subscribeSummary(publishSummary);
        unsubscribeLocalServiceConnection = apiMachine.onConnectionStateChange((state) => {
          const wasOnline = online;
          online = state.phase === 'online';
          if (!online || wasOnline) return;
          publishSummary();
          void localServices.refreshInventoryNow().catch((error) => {
            logger.debug('[DAEMON RUN] Local-service summary refresh failed', error);
          });
        });
      }
      const createWorkflowRecovery = params.createWorkflowRecoveryForMachine;
      let recoverWorkflowRuns: ReturnType<NonNullable<typeof createWorkflowRecovery>> | undefined;
      workflowRecovery = createWorkflowRecovery
        ? async (trigger) => {
            if (params.isWorkflowFeatureEnabled?.() !== true) return;
            recoverWorkflowRuns ??= createWorkflowRecovery({
              machineId: registeredMachine.id,
              machineAdmissionTransport: async (request, options) =>
                await apiMachine.enqueueSessionPendingByMachine(request, options),
              machineActionDirectTargetTransport: {
                machineId: registeredMachine.id,
                machineServiceAction: request => apiMachine.executeMachineServiceAction(request),
                invoke: async (method, request, options) => await apiMachine.invokeLocalMachineAction(method, request, options),
              },
            });
            await recoverWorkflowRuns(trigger);
          }
        : null;
      publishWorkspaceSyncEvent();
      params.prepareApiMachineForSessions?.(apiMachine);
      if (
        providerBrokerApplication
        && providerBrokerApplicationMachineId !== registeredMachine.id
      ) {
        try {
          await providerBrokerApplicationApiMachine?.setProviderBrokerIngressLive(false);
        } finally {
          await providerBrokerApplication.close();
          providerBrokerApplication = null;
          providerBrokerApplicationMachineId = null;
          providerBrokerApplicationApiMachine = null;
        }
      }
      if (params.startProviderBrokerApplication && !providerBrokerApplication) {
        providerBrokerApplication = await params.startProviderBrokerApplication({
          machineId: registeredMachine.id,
          apiMachine,
        });
        providerBrokerApplicationMachineId = registeredMachine.id;
      }
      if (providerBrokerApplication) {
        providerBrokerApplicationApiMachine = apiMachine;
        await apiMachine.setProviderBrokerIngressLive(true, providerBrokerApplication.accountConnectionIngress);
      }
      return apiMachine;
    },
    prepareWorkspaceSyncSeedExport: async (request) => {
      if (!workspaceSyncService?.prepareSourceSeedExport) throw new Error('Workspace sync source seed is unavailable');
      return await workspaceSyncService.prepareSourceSeedExport(request);
    },
    prepareWorkspaceSyncResolutionExport: async (request) => {
      if (!workspaceSyncService?.prepareConflictResolutionExport) throw new Error('Reviewed workspace conflict export is unavailable');
      return await workspaceSyncService.prepareConflictResolutionExport(request);
    },
    attachTransferRuntimeStatePublisher: async (connectedApiMachine) => {
      if (!params.transferRuntimeStatePublisher) return;
      await params.transferRuntimeStatePublisher.attachApiMachine(connectedApiMachine);
    },
    startAutomationWorkerForMachine: async (runtimeMachineId) => {
      const { startAutomationWorker } = await import('../automation/automationWorker');
      if (params.isShuttingDown()) return null;
      const automationApiMachine = connectedApiMachine;
      const requesterWorkAttributionV1 = automationApiMachine && automationAccountId && automationInstallationId
        ? Object.freeze({ serverId: automationHomeId, accountId: automationAccountId,
          machineId: runtimeMachineId, installationId: automationInstallationId }) : undefined;
      const coordinateWorkflowRun = automationApiMachine && params.createWorkflowRunCoordinatorForMachine
        ? async (claim: Parameters<ReturnType<typeof createProductionWorkflowRunCoordinator>>[0]) => {
          const { readStoredCredentialsForServerId, sameStoredCredentials } = await import('@/persistence');
          // Each claim owns its requester lifetime, including parallel leaves.
          // Ordinary local controls remain unprivileged; only this captured
          // Workflow transport can carry freshly verified Account custody.
          let requester: ReturnType<typeof prepareRequesterSessionBootstrap> | undefined;
          let authorizationCurrent: ((signal?: AbortSignal) => Promise<boolean>) | undefined;
          const isCurrent = async () => Boolean(requesterWorkAttributionV1
            && connectedApiMachine === automationApiMachine && !params.isShuttingDown()
            && configuration.activeServerId === automationHomeId
            && readInstallationIdentityIfExistsSync()?.installationId === automationInstallationId
            && sameStoredCredentials(params.credentials, await readStoredCredentialsForServerId(automationHomeId))
            && authorizationCurrent && await authorizationCurrent(claim.signal));
          const coordinate = params.createWorkflowRunCoordinatorForMachine!({
            machineId: runtimeMachineId,
            ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
            machineAdmissionTransport: async (request, options) =>
              await automationApiMachine.enqueueSessionPendingByMachine(request, options),
            machineActionDirectTargetTransport: {
              machineId: runtimeMachineId,
              machineServiceAction: request => automationApiMachine.executeMachineServiceAction(request),
              invoke: async (method, request, options) => {
                const local = options?.localActionContext;
                if (!local?.executionRunWorkflowRunId) return await automationApiMachine.invokeLocalMachineAction(method, request, options);
                const { withExecutionRunStartFailureDetails } = await import('@happier-dev/protocol/execution/runs/responseSchemas');
                const unavailable = { ok: false, errorCode: 'project_requester_credentials_unavailable',
                  error: 'Workflow requester authority unavailable',
                  ...(method === SESSION_RPC_METHODS.EXECUTION_RUN_START
                    ? { details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') } : {}) };
                const stamp = local.requesterWorkAttributionV1;
                if (!requesterWorkAttributionV1 || local.executionRunWorkflowRunId !== claim.runId
                  || stamp?.accountId !== requesterWorkAttributionV1.accountId || stamp.serverId !== automationHomeId
                  || stamp.machineId !== runtimeMachineId || stamp.installationId !== automationInstallationId
                  || !await isCurrent()) return unavailable;
                const { prepareRequesterSessionBootstrap } = await import('../sessionEncryption/requesterSessionCredentials');
                requester ??= readRequesterHomeWithinActionLifetime(() => prepareRequesterSessionBootstrap({ credentials: params.credentials, attribution: requesterWorkAttributionV1,
                  boundary: { serverId: automationHomeId, serverHttpBaseUrl: machineSkillHomeUrl, happyHomeDir: configuration.happyHomeDir },
                  verifyMachineAdmissionCurrent: isCurrent, ...(claim.signal ? { signal: claim.signal } : {}) }), claim.signal);
                const prepared = await requester;
                if (!prepared || !await prepared.admitted.isCurrent()) return unavailable;
                return await automationApiMachine.invokeLocalMachineAction(method, request, { ...options,
                  rpcContext: { requesterSessionBootstrap: prepared.admitted, callerAuthority: 'account_automation',
                    verifyMachineAdmissionCurrent: isCurrent } });
              },
            },
          });
          try { return await coordinate({ ...claim, registerAuthorizationCurrentnessCheck: check => {
            authorizationCurrent = check;
            claim.registerAuthorizationCurrentnessCheck?.(check);
          } }); }
          finally { await (await requester)?.cleanupOnFailure(); }
        }
        : null;
      const worker = startAutomationWorker({
        admissionDrain: params.admissionDrain,
        token: params.credentials.token,
        credentials: params.credentials,
        machineId: runtimeMachineId,
        ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
        ...(coordinateWorkflowRun
          ? {
              coordinateWorkflowRun: async (...args: Parameters<typeof coordinateWorkflowRun>) => {
                if (params.isWorkflowFeatureEnabled?.() !== true) {
                  throw new Error('Workflow Run coordinator is unavailable');
                }
                return await coordinateWorkflowRun(...args);
              },
            }
          : {}),
        recoverWorkflowRuns: async () => await workflowRecovery?.('control'),
        ...(connectedApiMachine
          ? {
              machineAdmissionTransport: async (request, options) =>
                await connectedApiMachine!.enqueueSessionPendingByMachine(request, options),
            }
          : {}),
      });
      params.onAutomationWorkerStarted?.(worker);
      return worker;
    },
    startMemoryWorkerForMachine: async (runtimeMachineId) => {
      try {
        const { startMemoryWorker } = await import('../memory/memoryWorker');
        return await startMemoryWorker({
          credentials: params.credentials,
          machineId: runtimeMachineId,
        });
      } catch (error) {
        if (error instanceof MemorySettingsSecretsUnavailableError) {
          throw error;
        }
        logger.warn('[DAEMON RUN] Failed to start memory worker (best-effort)', error);
        return null;
      }
    },
    startVoiceInferenceWorkerForMachine: async (runtimeMachineId, accountId) => {
      const { resolveCliFeatureDecision } = await import('@/features/featureDecisionService');
      if (resolveCliFeatureDecision({
        featureId: 'voice.daemonInference',
        env: process.env,
        serverSnapshot: params.getServerFeaturesSnapshot?.(),
      }).state !== 'enabled') {
        params.onPublicVoiceModelPackRuntimeReady?.(null);
        return null;
      }
      try {
        const [{ startVoiceInferenceWorker }, { createDaemonPublicVoiceModelPackRuntime }] = await Promise.all([
          import('../voiceInference/voiceInferenceWorker'),
          import('../voiceInference/publicModelPacks/runtime'),
        ]);
        const publicModelPacks = accountId ? createDaemonPublicVoiceModelPackRuntime({
          accountId, machineId: runtimeMachineId, happyHomeDir: configuration.happyHomeDir,
          paths: resolveVoiceInferencePaths(),
        }) : undefined;
        params.onPublicVoiceModelPackRuntimeReady?.(publicModelPacks ?? null);
        return await startVoiceInferenceWorker({
          ...(publicModelPacks ? { publicModelPacks } : {}),
        });
      } catch (error) {
        params.onPublicVoiceModelPackRuntimeReady?.(null);
        logger.warn('[DAEMON RUN] Failed to start voice inference worker (best-effort)', error);
        return null;
      }
    },
    spawnSession: params.spawnSession,
    spawnSessionForInternalResume: params.spawnSessionForInternalResume,
    ...(params.onActivationRejected ? { onActivationRejected: params.onActivationRejected } : {}),
    stopSession: params.stopSession,
    ...(params.sessionRunnerStatus ? { sessionRunnerStatus: params.sessionRunnerStatus } : {}),
    awaitAgentSessionOpen: params.awaitAgentSessionOpen,
    isSessionAlreadyRunning: params.isSessionAlreadyRunning,
    loadLocalSessionMetadataForHandoff: params.loadLocalSessionMetadataForHandoff,
    beforeShutdown: async () => {
      params.onPublicVoiceModelPackRuntimeReady?.(null);
      unsubscribeResourcePublication?.();
      unsubscribeResourcePublication = null;
      unsubscribeLocalServiceSummary?.();
      unsubscribeLocalServiceSummary = null;
      unsubscribeLocalServiceConnection?.();
      unsubscribeLocalServiceConnection = null;
      if (providerBrokerApplication) {
        try {
          await providerBrokerApplicationApiMachine?.setProviderBrokerIngressLive(false);
        } finally {
          await providerBrokerApplication.close();
          providerBrokerApplication = null;
          providerBrokerApplicationMachineId = null;
          providerBrokerApplicationApiMachine = null;
        }
      }
      await runnerBrokerReadinessApplication.stop();
      await params.beforeShutdown();
    },
    requestShutdown: params.requestShutdown,
    directPeerServerLifecycle: params.directPeerServerLifecycle,
    directTransferRegistryHost: params.directTransferRegistryHost,
    ...(params.cancelConnectedServiceRuntimeAuthRecovery
      ? { cancelConnectedServiceRuntimeAuthRecovery: params.cancelConnectedServiceRuntimeAuthRecovery }
      : {}),
    ...(params.checkRuntimeAuthUsageLimitRecovery
      ? { checkRuntimeAuthUsageLimitRecovery: params.checkRuntimeAuthUsageLimitRecovery }
      : {}),
    ...(params.retryTemporaryThrottleNow
      ? { retryTemporaryThrottleNow: params.retryTemporaryThrottleNow }
      : {}),
    ...(params.readTemporaryThrottleRecovery
      ? { readTemporaryThrottleRecovery: params.readTemporaryThrottleRecovery }
      : {}),
    ...(params.cancelTemporaryThrottleRecovery
      ? { cancelTemporaryThrottleRecovery: params.cancelTemporaryThrottleRecovery }
      : {}),
    peerMediationMachineRpc: {
      ...(params.startProviderBrokerApplication
        ? {
            resolveProviderBrokerApplicationTarget: async (input) =>
              await providerBrokerApplication?.resolveProviderBrokerApplicationTarget(input) ?? null,
            resolveExternalProviderBrokerApplicationTarget: async (input) =>
              await providerBrokerApplication?.resolveExternalProviderBrokerApplicationTarget(input) ?? null,
          }
        : {}),
      resolveRunnerBrokerReadinessApplicationTarget: async ({ request, signal }) => {
        try {
          const authorization = await params.api.authorizeRunnerBrokerReadiness(request, signal);
          if (
            authorization.readiness.kind !== 'available'
            || !doesRunnerBrokerReadinessResponseMatchRequestV1(request, authorization)
          ) return null;
          signal.throwIfAborted();
          return { port: await runnerBrokerReadinessApplication.ensureListening() };
        } catch {
          return null;
        }
      },
      stream: {
        captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(params.liveStreamCaptureRegistry),
        ...(params.readActiveLiveStreamControlLease
          ? { readActiveControlLease: params.readActiveLiveStreamControlLease }
          : {}),
      },
      ...(params.peerMediationObservabilityEmitter
        ? { observability: params.peerMediationObservabilityEmitter }
        : {}),
    },
    ...(params.readLocalServiceInventorySnapshot
      ? { readLocalServiceInventorySnapshot: params.readLocalServiceInventorySnapshot }
      : {}),
    ...(params.resolveManagedPurposeBindingIntent
      ? {
          resolveManagedPurposeBindingIntent:
            params.resolveManagedPurposeBindingIntent,
        }
      : {}),
    ...(params.resolveManagedPurposeBindingIntentSelection
      ? { resolveManagedPurposeBindingIntentSelection: params.resolveManagedPurposeBindingIntentSelection }
      : {}),
    ...(params.createAgentCatalogObservation
      ? { createAgentCatalogObservation: params.createAgentCatalogObservation }
      : {}),
    ...(params.persistedTakeoverAdmissionWaiter
      ? {
          persistedTakeoverAdmissionWaiter:
            params.persistedTakeoverAdmissionWaiter,
        }
      : {}),
    ...(params.attachPersistedTakeoverAdmissionOwner
      ? {
          attachPersistedTakeoverAdmissionOwner:
            params.attachPersistedTakeoverAdmissionOwner,
        }
      : {}),
    ...(params.installExternalSessionHostOperations
      ? {
          installExternalSessionHostOperations:
            params.installExternalSessionHostOperations,
        }
      : {}),
    ...(params.readMaterializedStateObservationBinding
      ? { readMaterializedStateObservationBinding: params.readMaterializedStateObservationBinding }
      : {}),
    ...(params.resolveExecutionRunLiveBrokerAuthority
      ? { resolveExecutionRunLiveBrokerAuthority: params.resolveExecutionRunLiveBrokerAuthority }
      : {}),
    ...(params.externalActionIngressOwner
      ? { externalActionIngressOwner: params.externalActionIngressOwner }
      : {}),
  };
}
