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
import { startAutomationWorker, type AutomationWorkerHandle } from '../automation/automationWorker';
import { startMemoryWorker, type MemoryWorkerHandle } from '../memory/memoryWorker';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from '../voiceInference/voiceInferenceWorker';
import { createDaemonPublicVoiceModelPackRuntime } from '../voiceInference/publicModelPacks/runtime';
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
import { MemorySettingsSecretsUnavailableError } from '@/settings/memorySettings';
import type { DaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
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
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readInstallationIdentityIfExistsSync } from '../identity/store';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';

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
    const sourceSignal = AbortSignal.any([params.ingress.signal, signal]);
    const assertSourceCurrent = async () => {
      if (sourceSignal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      if (!await params.isCurrent()) throw Object.assign(new Error('project_requester_credentials_unavailable'), { code: 'project_requester_credentials_unavailable' });
      if (sourceSignal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    };
    if (source.serverId !== params.serverId) throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
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
    await assertSourceCustody();
    const executor = createCliActionExecutorFromCredentials({
      credentials: params.credentials, serverId: params.serverId,
      serverApiUrl: params.serverHttpBaseUrl, machineId: source.machineId,
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
      result = await executor.execute('projects.inspect', { workspace: {
        serverId: source.serverId, workspaceId: source.id,
        machineId: source.machineId, rootPath: source.rootPath,
      } }, { ...context,
        ...(!params.ingress.localActionContext?.surface && !params.ingress.sessionActionOrigin ? { surface: 'api' as const } : {}),
        externalActionTarget: { kind: 'machine', machineId: source.machineId },
      });
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
    await assertSourceCustody();
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
    credentials: StoredCredentials;
    requesterServerId?: BootstrapRuntime['requesterServerId'];
    resolveCurrentMachineExecutionOriginContext?: BootstrapRuntime['resolveCurrentMachineExecutionOriginContext'];
    resolveRequesterSessionRuntimeContext?: BootstrapRuntime['resolveRequesterSessionRuntimeContext'];
    readRequesterSessionCredentialBindings?: BootstrapRuntime['readRequesterSessionCredentialBindings'];
    releaseRequesterSessionRuntimeContext?: BootstrapRuntime['releaseRequesterSessionRuntimeContext'];
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
    directTransferPromptAssetAdapterRegistry: BootstrapRuntime['directTransferPromptAssetAdapterRegistry'];
    directTransferPromptRegistryRegistry: BootstrapRuntime['directTransferPromptRegistryRegistry'];
    daemonServerWorkScheduler: BootstrapRuntime['daemonServerWorkScheduler'];
    cancelConnectedServiceRuntimeAuthRecovery?: BootstrapRuntime['cancelConnectedServiceRuntimeAuthRecovery'];
    retryTemporaryThrottleNow?: BootstrapRuntime['retryTemporaryThrottleNow'];
    readTemporaryThrottleRecovery?: BootstrapRuntime['readTemporaryThrottleRecovery'];
    cancelTemporaryThrottleRecovery?: BootstrapRuntime['cancelTemporaryThrottleRecovery'];
    setDaemonServerWorkOnline: BootstrapRuntime['setDaemonServerWorkOnline'];
    onMachineConnectionOnline: NonNullable<BootstrapRuntime['onMachineConnectionOnline']>;
    reconcileConnectedServicesProjection: Parameters<ApiMachineClient['onConnectedServicesProjection']>[0];
    subscribeConnectedAccountInvalidations?: BootstrapRuntime['subscribeConnectedAccountInvalidations'];
    isShuttingDown: BootstrapRuntime['isShuttingDown'];
    admissionDrain?: DaemonAdmissionDrain;
    managedActivity?: Pick<ManagedActivityRpcOwner, 'activity' | 'admissionDrain'>;
    isPublicationQuiescing?: () => boolean;
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
    managedCatalogRuntime?: BootstrapRuntime['managedCatalogRuntime'];
    resolveManagedPurposeBindingIntent?: BootstrapRuntime['resolveManagedPurposeBindingIntent'];
    openTeamDirect?: BootstrapRuntime['openTeamDirect'];
    prepareRunTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
    openAccountConnectionManagedConsumerSource?: ExecutionRunManagedProviderSourceOpener;
    createAgentCatalogObservation?: BootstrapRuntime['createAgentCatalogObservation'];
    onAutomationWorkerStarted?: (worker: AutomationWorkerHandle) => void;
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
  }>,
): BootstrapRuntime & Pick<ApiMachineClient, 'retireProjectFiniteExecution'> {
  // The same authenticated constructor facts used by Machine work-summary
  // composition. A later claim cannot choose its Account, Home or installation.
  const automationHomeId = params.requesterServerId ?? configuration.activeServerId;
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
    ...(params.requesterServerId ? { requesterServerId: params.requesterServerId } : {}),
    ...(params.resolveCurrentMachineExecutionOriginContext
      ? { resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext } : {}),
    ...(params.resolveRequesterSessionRuntimeContext
      ? { resolveRequesterSessionRuntimeContext: params.resolveRequesterSessionRuntimeContext } : {}),
    ...(params.readRequesterSessionCredentialBindings
      ? { readRequesterSessionCredentialBindings: params.readRequesterSessionCredentialBindings } : {}),
    ...(params.releaseRequesterSessionRuntimeContext
      ? { releaseRequesterSessionRuntimeContext: params.releaseRequesterSessionRuntimeContext } : {}),
    ...(params.daemonSessionMutationCustody
      ? { daemonSessionMutationCustody: params.daemonSessionMutationCustody }
      : {}),
    ...(params.deviceLocalSecretStorage
      ? { deviceLocalSecretStorage: params.deviceLocalSecretStorage }
      : {}),
    daemonServerWorkScheduler: params.daemonServerWorkScheduler,
    setDaemonServerWorkOnline: params.setDaemonServerWorkOnline,
    onMachineConnectionOnline: params.onMachineConnectionOnline,
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
      const apiMachine = params.api.machineSyncClient(registeredMachine, {
            runtimeId: params.runtimeId,
            cliVersion: packageJson.version,
            publicReleaseChannel: params.publicReleaseChannel,
            startupSource: params.startupSource,
            serviceManaged: params.startupSource === 'background-service',
            ...(params.serviceLabel ? { serviceLabel: params.serviceLabel } : null),
          }, {
            isDaemonQuiescing: params.isPublicationQuiescing ?? params.isShuttingDown,
            ...(params.requesterServerId && params.resolveRequesterSessionRuntimeContext && params.releaseRequesterSessionRuntimeContext ? {
              requesterSessionRuntime: { serverId: params.requesterServerId,
                resolve: params.resolveRequesterSessionRuntimeContext, release: params.releaseRequesterSessionRuntimeContext,
                ...(params.stopRequesterSessionForHandoff ? { stopForHandoff: params.stopRequesterSessionForHandoff } : {}) },
            } : {}),
            ...(params.managedActivity ? { managedActivity: params.managedActivity } : {}),
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
      const recoverWorkflowRuns = params.createWorkflowRecoveryForMachine?.({
        machineId: registeredMachine.id,
        machineAdmissionTransport: async (request, options) =>
          await apiMachine.enqueueSessionPendingByMachine(request, options),
      });
      workflowRecovery = recoverWorkflowRuns
        ? async (trigger) => {
            if (params.isWorkflowFeatureEnabled?.() !== true) return;
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
    startAutomationWorkerForMachine: (runtimeMachineId) => {
      const automationApiMachine = connectedApiMachine;
      const requesterWorkAttributionV1 = automationApiMachine && automationAccountId && automationInstallationId
        ? Object.freeze({ serverId: automationHomeId, accountId: automationAccountId,
          machineId: runtimeMachineId, installationId: automationInstallationId }) : undefined;
      const coordinateWorkflowRun = automationApiMachine && params.createWorkflowRunCoordinatorForMachine
        ? params.createWorkflowRunCoordinatorForMachine({
            machineId: runtimeMachineId,
            ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
            machineAdmissionTransport: async (request, options) =>
              await automationApiMachine.enqueueSessionPendingByMachine(request, options),
            machineActionDirectTargetTransport: {
              machineId: runtimeMachineId,
              invoke: async (method, request, options) => await automationApiMachine.invokeLocalMachineAction(
                method,
                request,
                options,
              ),
            },
          })
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
      if (resolveCliFeatureDecision({
        featureId: 'voice.daemonInference',
        env: process.env,
        serverSnapshot: params.getServerFeaturesSnapshot?.(),
      }).state !== 'enabled') {
        return null;
      }
      try {
        return await startVoiceInferenceWorker({
          ...(accountId
            ? {
                publicModelPacks: createDaemonPublicVoiceModelPackRuntime({
                  accountId,
                  machineId: runtimeMachineId,
                  happyHomeDir: configuration.happyHomeDir,
                  paths: resolveVoiceInferencePaths(),
                }),
              }
            : {}),
        });
      } catch (error) {
        logger.warn('[DAEMON RUN] Failed to start voice inference worker (best-effort)', error);
        return null;
      }
    },
    spawnSession: params.spawnSession,
    stopSession: params.stopSession,
    ...(params.sessionRunnerStatus ? { sessionRunnerStatus: params.sessionRunnerStatus } : {}),
    awaitAgentSessionOpen: params.awaitAgentSessionOpen,
    isSessionAlreadyRunning: params.isSessionAlreadyRunning,
    loadLocalSessionMetadataForHandoff: params.loadLocalSessionMetadataForHandoff,
    beforeShutdown: async () => {
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
    directTransferPromptAssetAdapterRegistry: params.directTransferPromptAssetAdapterRegistry,
    directTransferPromptRegistryRegistry: params.directTransferPromptRegistryRegistry,
    ...(params.cancelConnectedServiceRuntimeAuthRecovery
      ? { cancelConnectedServiceRuntimeAuthRecovery: params.cancelConnectedServiceRuntimeAuthRecovery }
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
    ...(params.managedCatalogRuntime
      ? { managedCatalogRuntime: params.managedCatalogRuntime }
      : {}),
    ...(params.resolveManagedPurposeBindingIntent
      ? {
          resolveManagedPurposeBindingIntent:
            params.resolveManagedPurposeBindingIntent,
        }
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
    ...(params.externalActionIngressOwner
      ? { externalActionIngressOwner: params.externalActionIngressOwner }
      : {}),
  };
}
