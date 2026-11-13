import type { CliActionDepsParams, ResolvedSessionTransport } from './cliActionDeps/types';
import { actionStartTargetUnavailableV1, measureActionStartPhaseV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import type { logger } from '@/ui/logger';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readRequesterAccountEncryptionMaterialSnapshot } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import type { readProjectAccountRows, ProjectAccountRowsSelection } from '@/workspaces/projectAccountRows';
import type { ResolvedSessionPullRequestBindingInputV1 } from './createCliActionDeps';
import type { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { isExecutionRunTerminalStatus } from '@happier-dev/protocol/execution/runs/waitForTerminal';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { resolveWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { resolveWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionResolverV1';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import type { ActionExecutorDeps, ActionExecutorContext, WorkflowActionExecuteArgs, PersistedBackendTargetRefV2 } from '@happier-dev/protocol';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { WorkflowStepExecutionSelectionSchema, WorkflowIngressContextV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { resolveExplicitSessionSpawnMachineTarget } from '@happier-dev/protocol/actions/sessionSpawnMachineTarget';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { createWorkflowHostActionContractReader, type ReadLocalWorkflowActionSpec } from './workflowHostActionContract';
import type { requestDaemonSignedRootActionExecution } from '@/daemon/controlClient';
import type { doesWorkflowImmediateEligibleStepTargetSession } from '@/daemon/workflows/coordinator';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecisionEnvironment } from '@/features/featureDecisionInputs';
import type { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import type { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createWorkflowDefinitionActions } from './workflowDefinitions';
import { createCliWorkflowTriggerActions } from './workflowTriggers';
import type { RoleSourceReader } from '@/session/roles/roleSources';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { createSessionRunReportPolicyReader } from '@/api/sessionFollowCreationPreferences';
import type { createWorkflowActionExecutor, normalizeWorkflowActionThrownError } from './workflowActionExecutor';
import type { createWorkflowRunActionOwner } from './workflowRunActions';
import type { WorkflowCombinedRunStartV1 } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import type { createCommittedInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createCredentialedWorkflowMaterializationHostV1, projectWorkflowConversationRoleSelection } from './workflowMaterializationHost';
import { createWorkflowApprovedOperationReader } from '@/daemon/workflows/workflowApprovedOperation';
import { createCredentialedWorkflowRunEncryptionResolver, createWorkflowActionAdmissionReader } from '@/daemon/workflows/workflowActionAdmission';
import { createWorkflowActionContextResolver, readWorkflowActionPolicyContext } from '@/daemon/workflows/workflowActionContext';
import type { createWorkflowInvocationRecoveryObserver, observeWorkflowInvocationRecoveryEvidence, resolveWorkflowSessionConversation } from '@/daemon/workflows/invocationRecoveryObserver';
import type { createWorkflowInvocationRecoveryFactWriter } from '@/daemon/workflows/recovery';
import type { createWorkflowRunPushNotificationClient } from '@/daemon/workflows/production';
import type { createWorkflowRunReviewEntryNotificationHandler } from '@/notifications/activity/dispatchWorkflowRunUpdateNotification';
import type { getWorkflowRuntimeFeatureDecision } from '@/daemon/automation/workflowFeatureGate';
import type { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import type { prepareWorkflowAcceptedWorkspaceTarget, restoreRecordedWorkflowWorkspace } from '@/daemon/workflows/resolveWorkflowWorkspace';
import { createAutomationAccountEncryptionMaterialSnapshotV1, resolveValidatedAutomationAccountEncryptionV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import type { fetchChangesAccountId } from '@/api/changes';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { readObservedAccountEncryptionCurrentnessWitness } from '@/api/client/accountEncryptionCurrentnessObservation';
import type { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import type { resolveWorkflowDiscussionOrigin } from '@/daemon/workflows/workflowDiscussion';
import { type createCliBoundSessionMetadataReader, type resolveCliActionCallerSession, resolveCliActionCallerWorkflowTarget } from './resolveCliActionCallerSession';
import type { getExecutionRun } from '@/session/services/executionRuns';
import type { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import type { isServerFeaturesProbeRetryable, CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { ExecutionRunActionTransportOptions } from './cliActionDeps/types';
import type { CliMachineActionCall } from './cliActionDeps/machineTransport';
import type { CliWorkflowRunStorage } from './workflowRunStorage';
import type { SessionPullRequestBindingResultV1 } from '@happier-dev/channels-protocol/v1';
import type { WorkflowIngressContextV1 } from '@happier-dev/protocol';

export type CliWorkflowFamilyHost = Readonly<{
  readLocalActionSpec: ReadLocalWorkflowActionSpec;
  nativeAccount?: Parameters<typeof createCliWorkflowTriggerActions>[0]['nativeAccount'];
  deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']>;
  roleArtifactStore: ReturnType<typeof createCredentialedAccountArtifactStore> | undefined;
  readRoleSources: RoleSourceReader;
  projectHomeId: string;
  actionHomeId: string;
  callMachineAction: CliMachineActionCall;
  sessionList: ActionExecutorDeps['sessionList'];
  sessionRead?: ActionExecutorDeps['sessionRead'];
  approvalsStore: ReturnType<typeof createCliApprovalsArtifactStore> | null;
  readCurrentSessionMetadata: ReturnType<typeof createCliBoundSessionMetadataReader>;
  resolveAgentStartContext: NonNullable<ActionExecutorDeps['resolveAgentStartContext']>;
  isSameActionHomeId: (serverId: string) => boolean;
  resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
  resolveCurrentSessionValue: (key: 'path' | 'host' | 'machineId', signal?: AbortSignal) => Promise<string | null>;
  readProjectRows: (selection: ProjectAccountRowsSelection, signal?: AbortSignal, context?: ActionExecutorContext, effectActionId?: string) => ReturnType<typeof readProjectAccountRows>;
  resolveProjectHomeIdentity: () => Promise<string>;
  readServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined>;
  resolveActionCallerSession: (context: ActionExecutorContext) => ReturnType<typeof resolveCliActionCallerSession>;
  resolveSessionAgentIdentity: (metadata: Record<string, unknown> | null | undefined, backendTarget?: PersistedBackendTargetRefV2 | null) => Promise<Extract<NonNullable<WorkflowIngressContextV1['agentTarget']>, { kind: 'agent' }>['identity'] | undefined>;
  invokeSessionPullRequestBinding: (input: ResolvedSessionPullRequestBindingInputV1, caller?: ActionExecutorContext) => Promise<SessionPullRequestBindingResultV1>;
  resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
  readTransportSessionOwnerMetadata: (transport: ResolvedSessionTransport) => ReturnType<typeof tryDecryptSessionOwnerMetadataView>;
  callSessionRpcForTransport: (transport: ResolvedSessionTransport, methodSuffix: string, request: unknown, signal?: AbortSignal, timeoutMs?: number | null) => Promise<unknown>;
  callDetachedExecutionRunRpc: (sessionId: string | null, method: string, request: unknown, opts?: ExecutionRunActionTransportOptions) => Promise<unknown>;
  accountCallerContext: (context: ActionExecutorContext) => ActionExecutorContext;
  callerSessionResolution: (context: ActionExecutorContext) => Parameters<typeof resolveCliActionCallerSession>[0];
  normalizeStringValue: (value: unknown) => string | null;
  readExecutionRunTransportMachineId: (transport: ResolvedSessionTransport) => string | null;
}>;
export type CliWorkflowFamily = Readonly<{
  workflowTriggers: ReturnType<typeof createCliWorkflowTriggerActions> | null;
  resolveWorkflowMaterializer: ReturnType<typeof createCredentialedWorkflowMaterializationHostV1> | null;
  readWorkflowApprovedOperation: ReturnType<typeof createWorkflowApprovedOperationReader> | undefined;
  readWorkflowActionStartContext: (context: ActionExecutorContext) => Promise<ActionExecutorContext['agentStartContext'] | null>;
  workflowAction: ActionExecutorDeps['workflowAction'] | null;
  workflowActionPort: NonNullable<ActionExecutorDeps['workflowAction']>;
  prepareWorkflowRunStartApproval: (request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    presentationDeps: Pick<ActionExecutorDeps, 'homeDomainAction'>) => ReturnType<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>;
  startCombinedWorkflow: (request: WorkflowCombinedRunStartV1) => Promise<unknown>;
  waitForCombinedWorkflow: (request: WorkflowCombinedRunStartV1, runId: string) => Promise<unknown>;
  readCombinedWorkflowInvocations: (request: WorkflowCombinedRunStartV1, input: WorkflowActionExecuteArgs<'workflow.run.invocations.list'>['input']) => Promise<unknown>;
}>;
export type CliWorkflowTriggerList = NonNullable<CliWorkflowFamily['workflowTriggers']>['list'];
export function createCliWorkflowFamily(
  params: CliActionDepsParams,
  host: CliWorkflowFamilyHost,
  runStorage: CliWorkflowRunStorage,
): CliWorkflowFamily {
  const { roleArtifactStore, readRoleSources, projectHomeId, actionHomeId, callMachineAction, sessionList, sessionRead, approvalsStore, readCurrentSessionMetadata, resolveAgentStartContext, isSameActionHomeId, resolveServerRequestHeaders, resolveCurrentSessionValue, readProjectRows, resolveProjectHomeIdentity, readServerFeaturesSnapshot, resolveActionCallerSession, resolveSessionAgentIdentity, invokeSessionPullRequestBinding, resolveTransportForSession, readTransportSessionOwnerMetadata, callSessionRpcForTransport, callDetachedExecutionRunRpc, accountCallerContext, callerSessionResolution, normalizeStringValue, readExecutionRunTransportMachineId } = host;
  const { workflowRunServerHttpBaseUrl, createWorkflowRunStorage, workflowRunStorage } = runStorage;

  const workflowDefinitions: ReturnType<typeof createWorkflowDefinitionActions> | null = params.credentials
    ? createWorkflowDefinitionActions({ artifactStore: roleArtifactStore!,
      readWorkflowTriggerSummaries: (definitionIds) => {
        if (!workflowTriggers) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        return workflowTriggers.readWorkflowSummaries(definitionIds);
      },
      resolveMaterializer: (target) => {
        if (!resolveWorkflowMaterializer) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        return resolveWorkflowMaterializer(target);
      },
      removeWorkflowTriggers: async (definitionId, signal) => {
        if (!workflowTriggers) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
        await workflowTriggers.removeForWorkflow(definitionId, signal);
      } })
    : null;

  const resolveWorkflowMaterializer: ReturnType<typeof createCredentialedWorkflowMaterializationHostV1> | null = params.credentials && workflowDefinitions
    ? createCredentialedWorkflowMaterializationHostV1({
      credentials: params.credentials, readRoleSources,
      serverId: projectHomeId, serverIdentityId: params.serverIdentityId,
      savedSecretOperationContext: params.savedSecretOperationContext,
      ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
      callMachineAction,
      readHostActionContract: createWorkflowHostActionContractReader({ ...params, credentials: params.credentials }, host.readLocalActionSpec),
      readWorkflowDefinition: (ref, signal) => resolveWorkflowDefinitionRefV1(formatWorkflowDefinitionRefV1(ref), {
        readPluginWorkflows: workflowDefinitions.readPluginWorkflows,
        readArtifact: (definitionId, readSignal) => workflowDefinitions.get({ definitionId, ...(readSignal ? { signal: readSignal } : {}) }),
        ...(signal ? { signal } : {}),
      }),
    }) : null;
  const workflowTriggers: ReturnType<typeof createCliWorkflowTriggerActions> | null = params.credentials && workflowDefinitions
    ? createCliWorkflowTriggerActions({ credentials: params.credentials,
      ...(params.workflowRequesterCustody ? { workflowRequesterCustody: params.workflowRequesterCustody } : {}),
      ...(host.nativeAccount ? { nativeAccount: host.nativeAccount } : {}),
      deploymentAction: host.deploymentAction,
      sessionList,
      sessionRead,
      pullRequests: {
        listLinks: async (sessionId, caller) => {
          const result = await invokeSessionPullRequestBinding({ kind: 'list', sessionId }, caller);
          if (result.kind !== 'links') throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
          return [...result.pullRequestLinks];
        },
        attach: async ({ sessionId, pullRequest, ...target }, caller) => {
          const result = await invokeSessionPullRequestBinding({ kind: 'attach', sessionId, pullRequest, target }, caller);
          if (result.kind !== 'attached') throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        },
        removeTrigger: async (input, caller) => {
          const result = await invokeSessionPullRequestBinding({ kind: 'removeTrigger', ...input }, caller);
          if (result.kind !== 'removed') throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        },
      },
      ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
      resolveWorkflow: async (ref) => {
        const resolved = await resolveWorkflowDefinitionRefV1(ref, {
          readPluginWorkflows: workflowDefinitions.readPluginWorkflows,
          readArtifact: (definitionId, signal) => workflowDefinitions.get({ definitionId, ...(signal ? { signal } : {}) }),
        });
        if (!resolved) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
        return resolved;
      },
      resolveSession: async (sessionId, caller, options) => {
        const transport = await resolveTransportForSession(sessionId, caller?.signal);
        if (!transport.ok) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        const metadata = readTransportSessionOwnerMetadata(transport);
        const machineId = normalizeStringValue(transport.rawSession.machineId) ?? normalizeStringValue(metadata?.machineId);
        const directory = normalizeStringValue(metadata?.path) ?? normalizeStringValue(transport.rawSession.path);
        if (!machineId || !directory) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        let nativeGoalOwner: boolean | null = transport.rawSession.active === true ? null : false;
        if (options?.checkNativeGoalOwner === true && transport.rawSession.active === true) {
          const result = await callSessionRpcForTransport(transport, SESSION_RPC_METHODS.SESSION_GOAL_GET,
            { capabilitiesOnly: true }, caller?.signal, null);
          if (result !== null && typeof result === 'object' && 'nativeGoalOwner' in result && typeof result.nativeGoalOwner === 'boolean') {
            nativeGoalOwner = result.nativeGoalOwner;
          }
        }
        const { resolveBackendTargetFromSessionMetadata } = await import("@/session/backendTargets/resolveBackendTargetFromSessionMetadata");
        const identity = await resolveSessionAgentIdentity(metadata, resolveBackendTargetFromSessionMetadata(metadata));
        const selection = identity ? WorkflowStepExecutionSelectionSchema.safeParse({
          agentTarget: { kind: 'agent', identity }, ...(metadata?.permissionMode ? { permissionMode: metadata.permissionMode } : {}),
        }) : null;
        return { project: { machineId, directory }, nativeGoalOwner,
          ...(selection?.success ? { executionSelection: selection.data } : {}) };
      },
      resolveMaterializer: async (target, caller) => {
        if (!resolveWorkflowMaterializer) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        return resolveWorkflowMaterializer({ ...target, signal: caller.signal });
      },
      resolveRunTrigger: async (runId) => {
        const raw = await workflowRunStorage.execute({ operation: 'get', runId });
        const run = raw !== null && typeof raw === 'object' && 'run' in raw ? WorkflowRunSummaryV1Schema.safeParse(raw.run) : null;
        if (!run?.success || run.data.id !== runId || run.data.origin.kind !== 'automation') return null;
        const origin = run.data.origin;
        return origin.originSessionId && origin.cause && 'triggerId' in origin.cause && origin.cause.triggerId
          ? { sessionId: origin.originSessionId, triggerId: origin.cause.triggerId, automationId: origin.automationId } : null;
      },
      resolveRunSource: async (source, caller) => {
        if (source.kind === 'workflow_run') {
          const raw = await workflowRunStorage.execute({ operation: 'get', runId: source.runId,
            ...(caller?.signal ? { signal: caller.signal } : {}) });
          const run = raw !== null && typeof raw === 'object' && 'run' in raw ? WorkflowRunSummaryV1Schema.safeParse(raw.run) : null;
          if (!run?.success || run.data.id !== source.runId) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
          return { terminal: isTerminalAutomationRunStateV3(run.data.state) };
        }
        let raw: unknown;
        if (source.sessionId) {
          const transport = await resolveTransportForSession(source.sessionId, caller?.signal);
          if (!transport.ok || readExecutionRunTransportMachineId(transport) !== source.machineId) {
            throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
          }
          const { getExecutionRun } = await import("@/session/services/executionRuns");
          const observed = await getExecutionRun({ ...transport, token: params.token, sessionId: transport.sessionId,
            request: { runId: source.runId }, ...(caller?.signal ? { signal: caller.signal } : {}) });
          if (!observed.ok) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
          raw = observed.data;
        } else {
          raw = await callDetachedExecutionRunRpc(null, SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            { runId: source.runId }, { targetMachineId: source.machineId, ...(caller?.signal ? { signal: caller.signal } : {}) });
        }
        const result = ExecutionRunGetResponseSchema.safeParse(raw);
        if (!result.success || result.data.run.runId !== source.runId) {
          throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
        }
        return { terminal: isExecutionRunTerminalStatus(result.data.run.status) };
      },
    })
    : null;

  const resolveWorkflowIngressContext = async (
    context: ActionExecutorContext,
  ): Promise<ReturnType<typeof WorkflowIngressContextV1Schema.parse> | undefined> => {
    const session = await resolveActionCallerSession(context);
    if (!session) return undefined;

    // The live Session client is the canonical current Agent authority for the
    // hosting Session. The synced Session record is a fallback for a field the
    // live context does not supply, never an unconditional prerequisite.
    const agentIdentity = await resolveSessionAgentIdentity(session.metadata, session.backendTarget);
    const { machineId, directory } = session;
    return WorkflowIngressContextV1Schema.parse({
      ...(agentIdentity ? { agentTarget: { kind: 'agent', identity: agentIdentity } } : {}),
      ...(machineId ? { machineId } : {}),
      ...(directory ? { directory } : {}),
    });
  };
  const resolveWorkflowEncryption = async (context: ActionExecutorContext, signal?: AbortSignal, actionId?: string) => {
    const authorization = context.externalActionExecutionAuthorization;
    const requester = readRequesterAccountActionContext(authorization);
    const requesterHttp = requester ? undefined : authorization?.requesterHttpProjection;
    const credentials = requester?.credentials ?? params.credentials;
    if (!credentials) {
      throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
    }
    return await resolveValidatedAutomationAccountEncryptionV1({
      signal: signal ?? context.signal ?? new AbortController().signal,
      resolveAccountEncryptionCurrentness: currentnessSignal => {
        if (requester) return Promise.resolve(requester.accountEncryptionCurrentness);
        // Session birth keeps its existing signed requester transport. It has
        // no finite Account context and cannot borrow Machine custody instead.
        if (authorization && actionId) {
          const authorizationHeaders = resolveServerRequestHeaders(context, actionId, {
            method: 'GET', path: '/v1/account/encryption/currentness',
          });
          if (!authorizationHeaders) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
          // The signed proof selects authority; only its admitted requester
          // projection may supply content material, never the receiver Account.
          return fetchAccountEncryptionCurrentness({ token: requesterHttp ? authorization.token : credentials.token,
            ...(requesterHttp ? {} : { credentials }),
            serverBaseUrl: requesterHttp?.serverHttpBaseUrl ?? workflowRunServerHttpBaseUrl, authorizationHeaders, signal: currentnessSignal });
        }
        const scope = { token: credentials.token, serverBaseUrl: workflowRunServerHttpBaseUrl,
          ...(currentnessSignal ? { signal: currentnessSignal } : {}) };
        return readObservedAccountEncryptionCurrentnessWitness(scope)
          ?? fetchAccountEncryptionCurrentness({ ...scope, credentials });
      },
      resolveAccountEncryptionMaterial: async () => requesterHttp
        ? readRequesterAccountEncryptionMaterialSnapshot(authorization)
        : createAutomationAccountEncryptionMaterialSnapshotV1(credentials),
    });
  };
  const readWorkflowApprovedOperation = params.credentials ? createWorkflowApprovedOperationReader({
    storage: workflowRunStorage,
    readSavedTriggerConsent: input => workflowTriggers?.readSavedConsent(input, input.context) ?? Promise.resolve(null),
    resolveEncryption: createCredentialedWorkflowRunEncryptionResolver({ credentials: params.credentials,
      serverHttpBaseUrl: workflowRunServerHttpBaseUrl }),
  }) : undefined;
  const readWorkflowActionAdmission = params.credentials ? createWorkflowActionAdmissionReader({
    nativeAccountId: readAccountIdFromToken(params.credentials.token) ?? undefined,
    storage: workflowRunStorage,
    resolveEncryption: createCredentialedWorkflowRunEncryptionResolver({ credentials: params.credentials,
      serverHttpBaseUrl: workflowRunServerHttpBaseUrl }),
  }) : null;
  const resolveWorkflowActionContext = resolveWorkflowMaterializer
    ? createWorkflowActionContextResolver(resolveWorkflowMaterializer) : null;
  const readWorkflowActionStartContext: CliWorkflowFamily['readWorkflowActionStartContext'] = async context => {
    if (!context.approvedActionReplay || context.actionCaller?.kind !== 'workflowRun'
      || !readWorkflowActionAdmission || !resolveWorkflowActionContext) return null;
    const admission = await readWorkflowActionAdmission({ runId: context.actionCaller.runId, context, phase: 'approval_replay' });
    if (!admission) return null;
    const policy = await readWorkflowActionPolicyContext({ admission, context, phase: 'approval_replay',
      resolveContext: resolveWorkflowActionContext });
    return policy?.agentStartContext ?? null;
  };
  const resolveWorkflowRunEncryption = async (
    caller: Readonly<{ actionId: string; context: ActionExecutorContext }>,
    signal?: AbortSignal,
  ) => {
    const resolved = await resolveWorkflowEncryption(caller.context, signal, caller.actionId);
    const { classifyServerEndpointError } = await import('@/api/client/classifyServerEndpointError');
    if (resolved.kind === 'unavailable' && 'cause' in resolved
      && classifyServerEndpointError(resolved.cause).retryable) throw resolved.cause;
    if (resolved.kind !== 'available') throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
    return resolved;
  };

  const createOwnedWorkflowExecutor = workflowDefinitions && params.credentials
    ? async (args: Parameters<NonNullable<ActionExecutorDeps['workflowAction']>>[0], combined?: WorkflowCombinedRunStartV1) => {
      // Each invocation retains its original proof; concurrent Session calls
      // must never spend another caller's authority through a shared closure.
      // A combined Run spends its retained parent's currentness purpose, not
      // the internal workflow.run.start/wait effect under that parent's proof.
      const encryptionCaller = { actionId: combined?.parent.actionId ?? args.actionId, context: args.context };
      const workflowRunStorage = createWorkflowRunStorage(combined
        ? { parent: combined.parent, context: args.context } : args);
      const [{ createWorkflowActionExecutor }, { logger }, { createWorkflowRunActionOwner }, { createCommittedInputTypeDeps }, { doesWorkflowImmediateEligibleStepTargetSession }] = await Promise.all([import("./workflowActionExecutor"), import("@/ui/logger"), import("./workflowRunActions"), import("@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps"), import("@/daemon/workflows/coordinator")]);
      const execute = createWorkflowActionExecutor({
        onFailureDiagnostic: diagnostic => logger.infoFile(JSON.stringify(diagnostic)),
        isWorkflowFeatureEnabled: async () => {
          const snapshot = await readServerFeaturesSnapshot();
          const [{ getWorkflowRuntimeFeatureDecision }, { isServerFeaturesProbeRetryable }] = await Promise.all([import("@/daemon/automation/workflowFeatureGate"), import("@/features/serverFeaturesClient")]);
          const decision = getWorkflowRuntimeFeatureDecision(resolveCliFeatureDecisionEnvironment(), snapshot);
          if (decision.state === 'unknown' && (!snapshot || isServerFeaturesProbeRetryable(snapshot))) {
            throw Object.assign(new Error('storage_unavailable'), { code: 'storage_unavailable' });
          }
          return decision.state === 'enabled';
        },
        resolveIngressContext: async (args) => {
          if (args.actionId === 'workflow.run.start') {
            // Admission materializes the current executable catalog. Refuse a
            // non-daemon process before Account/source reads or Run storage.
            const { acquireAuthoritativePluginRuntimeRegistryLease } = await import("@/plugins/runtime/reload/runtimeLease");
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
            await lease.release();
          }
          return await resolveWorkflowIngressContext(args.context);
        },
        resolveTargetValidation: async (args) => {
          try {
            const { listCurrentAccountMachines } = await import("@/api/machine/resolveCurrentAccountMachineTarget");
            const machines = await listCurrentAccountMachines({
              token: params.token,
              ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
              ...(args.context.signal ? { signal: args.context.signal } : {}),
            });
            const target = resolveExplicitSessionSpawnMachineTarget({
              machineId: args.input.target?.machineId,
              machines: machines.map((machine) => ({ machineId: machine.id })),
            });
            if (target.kind === 'resolved') return { targetValidation: 'checked' as const };
          } catch {
            // The canonical inventory owner reported an unavailable observation.
          }
          return {
            targetValidation: 'unavailable' as const,
            targetIssues: [{
              code: 'target_unavailable' as const,
              path: '/target/machineId',
              message: 'The requested Workflow target is unavailable.',
              severity: 'error' as const,
            }],
          };
        },
        definitions: workflowDefinitions,
        ...(workflowTriggers ? { triggers: workflowTriggers } : {}),
        runs: (() => {
          const owner = createWorkflowRunActionOwner({
          ...(params.workflowRequesterCustody ? { workflowRequesterCustody: params.workflowRequesterCustody } : {}),
          resolveServerProfileScopeId: identifier => isSameActionHomeId(identifier) ? actionHomeId : null,
          resolveDiscussionOrigin: async ({ origin, context }) => {
            const [{ readRequesterAccountActionContext }, { resolveWorkflowDiscussionOrigin }] = await Promise.all([import("@/daemon/sessionEncryption/requesterAccountActionContext"), import("@/daemon/workflows/workflowDiscussion")]);
            const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
            const credentials = requester?.credentials ?? params.credentials;
            if (!credentials || context.externalActionExecutionAuthorization && !requester) {
              throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
            }
            if (requester && !await requester.isCurrent()) throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
            const discussionAction = createDiscussionActionDeps({ credentials,
              serverId: projectHomeId, serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? workflowRunServerHttpBaseUrl,
              ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
              ...(params.externalActionMachineRequestPrivateKey ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey } : {}),
              ...(params.externalActionMachineInstallationId ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId } : {}),
              ...(params.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
            }).discussionAction!;
            const result = await resolveWorkflowDiscussionOrigin({ origin,
              context: { ...context, ...(!context.serverIdentityId && params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}) },
              discussionAction, signal: context.signal }).catch(error => {
              context.signal?.throwIfAborted();
              const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
              throw Object.assign(new Error(code === 'invalid_reference_scope' ? 'invalid_reference_scope' : 'content_unavailable'), {
                code: code === 'invalid_reference_scope' ? 'invalid_reference_scope' : 'content_unavailable',
              });
            });
            if (requester && !await requester.isCurrent()) throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
            return result;
          },
          resolveRunReportPolicy: async ({ context }) => {
            const [{ readRequesterAccountActionContext }, { createSessionRunReportPolicyReader }] = await Promise.all([import("@/daemon/sessionEncryption/requesterAccountActionContext"), import("@/api/sessionFollowCreationPreferences")]);
            const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
            const credentials = requester?.credentials ?? params.credentials;
            const accountId = context.externalActionExecutionAuthorization?.binding.accountId
              ?? (credentials ? readAccountIdFromToken(credentials.token) : null);
            if (!accountId || context.externalActionCredential && !requester) {
              throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
            }
            return await createSessionRunReportPolicyReader({ serverId: projectHomeId,
              serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? workflowRunServerHttpBaseUrl,
              accountId, readCredentials: async () => credentials ?? null,
              isCurrent: requester ? () => requester.isCurrent() : () => params.isCredentialCurrent?.() ?? true,
            })(context.signal);
          },
          resolveAgentStartContext,
          sessionList,
          sessionRead,
          inputTypeDeps: createCommittedInputTypeDeps(),
          resolveMaterializationContext: async (args, target, readAgentStartContext) => {
            if (!resolveWorkflowMaterializer) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
            if (args.context.surface !== 'agent'
              && (!args.context.actionCaller || args.context.actionCaller.kind === 'host')) {
              if (!args.context.defaultSessionId) return await resolveWorkflowMaterializer({ ...target, signal: args.context.signal });
              const sessionId = args.context.defaultSessionId;
              const [{ readRequesterAccountActionContext }, { resolveWorkflowSessionConversation }] = await Promise.all([import("@/daemon/sessionEncryption/requesterAccountActionContext"), import("@/daemon/workflows/invocationRecoveryObserver")]);
              const requester = readRequesterAccountActionContext(args.context.externalActionExecutionAuthorization);
              const credentials = requester?.credentials ?? params.credentials;
              if (!credentials || args.context.externalActionCredential && !requester) {
                throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
              }
              const origin = await runWithServerHttpBaseUrl(requester?.serverHttpBaseUrl ?? workflowRunServerHttpBaseUrl,
                () => resolveWorkflowSessionConversation({ credentials, sessionId,
                  ...(args.context.signal ? { signal: args.context.signal } : {}),
                }));
              if (!origin || requester && !await requester.isCurrent()) {
                throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
              }
              return await resolveWorkflowMaterializer({ ...target, signal: args.context.signal,
                roleSelection: projectWorkflowConversationRoleSelection(origin, target.machineId) });
            }
            return resolveWorkflowMaterializer({ ...target, signal: args.context.signal,
              roleSelection: async () => {
                const metadata = await readCurrentSessionMetadata();
                const startContext = await readAgentStartContext();
                if (startContext && 'ok' in startContext) throw Object.assign(new Error(startContext.error), {
                  code: startContext.errorCode, details: startContext.details,
                });
                const baseline = startContext?.baseline.configuration;
                const sameMachine = startContext?.baseline.machineId === target.machineId;
                return {
                  sessionRoles: readSessionRolesV1(metadata) ?? undefined,
                  ...(sameMachine && baseline?.profileId ? { defaultProfileId: baseline.profileId } : {}),
                  defaultConnectedServices: sameMachine ? baseline?.connectedServices : undefined,
                  ...(baseline?.agentTarget ? { defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(baseline.agentTarget),
                    ...(baseline.modelSelection ? { modelId: 'ref' in baseline.modelSelection
                      ? baseline.modelSelection.ref.modelId : baseline.modelSelection.modelId } : {}) } } : {}),
                };
              },
            });
          },
          doesImmediateEligibleStepTargetSession: doesWorkflowImmediateEligibleStepTargetSession,
          resolveAccountId: async (signal) => {
            const { fetchChangesAccountId } = await import("@/api/changes");
            return args.context.externalActionExecutionAuthorization?.binding.accountId
            ?? await fetchChangesAccountId({
            token: params.token,
            serverHttpBaseUrl: workflowRunServerHttpBaseUrl,
            ...(signal ? { signal } : {}),
          });
          },
          storage: workflowRunStorage,
          definitions: workflowDefinitions,
          readPluginWorkflows: workflowDefinitions.readPluginWorkflows,
          resolveEncryption: (signal) => resolveWorkflowRunEncryption(encryptionCaller, signal),
          observeRecovery: async ({ run, progress, signal }) => {
            const { observeWorkflowInvocationRecoveryEvidence } = await import("@/daemon/workflows/invocationRecoveryObserver");
            return await observeWorkflowInvocationRecoveryEvidence({
            runId: run.id, credentials: params.credentials!, machineId: run.machineId, progress,
            getApproval: async artifactId => ({ artifactId,
              request: await approvalsStore?.approvalsGet({ artifactId, serverId: null }) }),
            getOperation: async (operation) => await callMachineAction({ serverId: operation.serverId,
              machineId: operation.machineId, method: ACTION_OPERATION_RPC_METHODS_V2.get,
              request: { operationId: operation.operationId }, exactMachine: true, ...(signal ? { signal } : {}) }),
            getRun: async (request) => await callDetachedExecutionRunRpc(null, SESSION_RPC_METHODS.EXECUTION_RUN_GET,
              request, { exactMachineId: run.machineId, ...(signal ? { signal } : {}) }),
            ...(signal ? { signal } : {}),
          });
          },
          reattachInvocation: async ({ run, index, signal }) => {
            const census = WorkflowRunRecipientCensusResponseV1Schema.parse(await workflowRunStorage.execute({
              operation: 'run-key.census', runId: run.id,
            }, signal ? { signal } : {}));
            const resolved = resolveWorkflowRunDataKeyV1({ encryption: await resolveWorkflowRunEncryption(encryptionCaller, signal), census });
            if (resolved.kind !== 'available') throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
            const [{ createWorkflowInvocationRecoveryFactWriter }, { createWorkflowRunReviewEntryNotificationHandler }, { createWorkflowRunPushNotificationClient }, { createWorkflowInvocationRecoveryObserver }] = await Promise.all([import("@/daemon/workflows/recovery"), import("@/notifications/activity/dispatchWorkflowRunUpdateNotification"), import("@/daemon/workflows/production"), import("@/daemon/workflows/invocationRecoveryObserver")]);
            const writer = createWorkflowInvocationRecoveryFactWriter({ accountId: census.ownerAccountId, run, expectedRevision: run.revision,
              encryption: resolved.encryption,
              onReviewEntered: createWorkflowRunReviewEntryNotificationHandler({
                operationContext: params.savedSecretOperationContext,
                expoPushSender: createWorkflowRunPushNotificationClient(params.token),
              }),
              storage: { execute: async (operation, options) => await workflowRunStorage.execute(operation, {
                ...options, publisherMachineId: run.machineId,
              }) },
              ...(signal ? { signal } : {}),
            });
            const invocation = await writer.readInvocation(index.id);
            if (!invocation || invocation.index.attempt !== index.attempt || invocation.index.lifecycle !== index.lifecycle) {
              throw Object.assign(new Error('workflow_invocation_fact_conflict'), { code: 'workflow_invocation_fact_conflict' });
            }
            const observe = createWorkflowInvocationRecoveryObserver({ credentials: params.credentials!, machineId: run.machineId,
              nativeActionOperations: {
                get: async (operation, observationSignal) => await callMachineAction({ serverId: operation.serverId,
                  machineId: operation.machineId, method: ACTION_OPERATION_RPC_METHODS_V2.get,
                  request: { operationId: operation.operationId }, exactMachine: true, ...(observationSignal ? { signal: observationSignal } : {}) }),
                cancel: async () => { throw Object.assign(new Error('workflow_observation_only'), { code: 'workflow_observation_only' }); },
                wait: async () => { throw Object.assign(new Error('workflow_observation_only'), { code: 'workflow_observation_only' }); },
              },
              nativeActionRuns: {
                get: async (runId, observationSignal) => await callDetachedExecutionRunRpc(null, SESSION_RPC_METHODS.EXECUTION_RUN_GET,
                  { runId, includeStructured: true }, { exactMachineId: run.machineId,
                    ...(observationSignal ? { signal: observationSignal } : {}) }),
                stop: async () => { throw Object.assign(new Error('workflow_observation_only'), { code: 'workflow_observation_only' }); },
                wait: async () => { throw Object.assign(new Error('workflow_observation_only'), { code: 'workflow_observation_only' }); },
              },
              actionExecutor: { execute: async (actionId, request, context) => {
                // This port is intentionally read-only: observation reattach
                // cannot reach the stop/send/start/resume effects.
                if (actionId === 'approval.request.get' && 'artifactId' in request) return { ok: true,
                  result: { artifactId: request.artifactId,
                    request: await approvalsStore?.approvalsGet({ artifactId: request.artifactId, serverId: null }) } };
                if (actionId !== 'execution.run.get' || !('runId' in request)) return { ok: false, errorCode: 'workflow_observation_only' };
                const native = await callDetachedExecutionRunRpc(null, SESSION_RPC_METHODS.EXECUTION_RUN_GET,
                  { runId: request.runId, includeStructured: false }, {
                    exactMachineId: run.machineId, ...(context.signal ? { signal: context.signal } : {}),
                  });
                return { ok: true, result: native };
              } },
            });
            const observation = await observe({ progress: invocation.progress, terminalParent: false,
              ...(invocation.progress.execution?.kind === 'action'
                ? { frozenActionContract: await writer.resolveFrozenActionContract(invocation) } : {}),
              cancellationRequested: invocation.index.lifecycle === 'cancel_requested', observationOnly: true,
              ...(signal ? { signal } : {}),
            });
            await writer.commitObservation(invocation, observation);
          },
          prepareWorkspace: async ({ projectTarget, definition }) => {
            if (!projectTarget.workspaceRefId) {
              const { prepareWorkflowAcceptedWorkspaceTarget } = await import("@/daemon/workflows/resolveWorkflowWorkspace");
              return await prepareWorkflowAcceptedWorkspaceTarget({ projectTarget, definition });
            }
            const rows = await readProjectRows({ kinds: ['workspace-ref'], serverId: await resolveProjectHomeIdentity() });
            const workspaceServerId = params.serverIdentityId ?? projectHomeId;
            const [{ prepareWorkflowAcceptedWorkspaceTarget }, { resolveWorkspaceRefById }] = await Promise.all([import("@/daemon/workflows/resolveWorkflowWorkspace"), import("@/workspaces/workspaceRefsV1")]);
            return await prepareWorkflowAcceptedWorkspaceTarget({
              projectTarget,
              definition,
              currentServerId: workspaceServerId,
              resolveWorkspaceRef: (workspaceRefId) => resolveWorkspaceRefById(
                rows.workspaceRefs,
                workspaceRefId,
                workspaceServerId,
              ),
            });
          },
          restoreWorkspace: async (workspace) => {
            const { restoreRecordedWorkflowWorkspace } = await import("@/daemon/workflows/resolveWorkflowWorkspace");
            return await restoreRecordedWorkflowWorkspace({ workspace });
          },
          ...(params.workflowAcceptedAuthorizationCurrentness
            ? { isAcceptedAuthorizationCurrent: params.workflowAcceptedAuthorizationCurrentness }
            : {}),
          });
          return combined ? { execute: (request, ingress) => request.actionId === 'workflow.run.start'
            ? owner.startCombined({ ...combined, start: request.input, context: request.context }, ingress)
            : request.actionId === 'workflow.run.wait'
              ? owner.waitCombined({ ...combined, start: { ...combined.start, runId: request.input.runId },
                context: request.context }, ingress)
            : owner.execute(request, ingress) } satisfies Parameters<typeof createWorkflowActionExecutor>[0]['runs'] : owner;
        })(),
      });
      return execute;
    }
    : null;
  const ownedWorkflowAction = createOwnedWorkflowExecutor
    ? async (args: Parameters<NonNullable<ActionExecutorDeps['workflowAction']>>[0], combined?: WorkflowCombinedRunStartV1) =>
      await (await createOwnedWorkflowExecutor(args, combined))(args)
    : null;
  const workflowAction: ActionExecutorDeps['workflowAction'] | null = params.workflowAction ?? ownedWorkflowAction;
  const startCombinedWorkflow: CliWorkflowFamily['startCombinedWorkflow'] = async request => {
    if (!ownedWorkflowAction) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    return ownedWorkflowAction({ actionId: 'workflow.run.start', input: request.start, context: accountCallerContext(request.context) }, request);
  };
  const waitForCombinedWorkflow: CliWorkflowFamily['waitForCombinedWorkflow'] = async (request, runId) => {
    if (!ownedWorkflowAction) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    return ownedWorkflowAction({ actionId: 'workflow.run.wait', input: { runId, conditions: ['terminal'] },
      context: accountCallerContext(request.context) }, request);
  };
  const readCombinedWorkflowInvocations: CliWorkflowFamily['readCombinedWorkflowInvocations'] = async (request, input) => {
    if (!ownedWorkflowAction) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    return ownedWorkflowAction({ actionId: 'workflow.run.invocations.list', input,
      context: accountCallerContext(request.context) }, request);
  };
  const resolveWorkflowActionArgs = async (args: Parameters<NonNullable<ActionExecutorDeps['workflowAction']>>[0]) => {
        // A Machine/Account host's bound id is not a Workflow origin Session.
        // Keep Session identity explicit at ingress; only enrich Account identity.
        let context = accountCallerContext(args.context);
        const isTrustedCallingSession = normalizeStringValue(args.context.defaultSessionId) === normalizeStringValue(params.sessionId);
        if (args.actionId === 'workflow.run.start'
          && isTrustedCallingSession
          && !(context.externalActionTarget?.kind === 'machine' && context.externalActionTarget.project)) {
          // Signed custody must already contain the exact workspace target.
          if (context.externalActionExecutionAuthorization) return actionStartTargetUnavailableV1(context,
            'workflow_owner', 'target_binding_mismatch');
          const target = await resolveCliActionCallerWorkflowTarget({ ...callerSessionResolution(context),
            // Bound Workflow ingress needs only the live workspace, not an
            // Account metadata read before Workflow availability is decided.
            readBoundSession: async () => ({ metadata: null, workDepth: undefined, backendTarget: undefined,
              machineId: await resolveCurrentSessionValue('machineId', context.signal),
              directory: await resolveCurrentSessionValue('path', context.signal) }),
            ...(context.externalActionTarget ? { target: context.externalActionTarget } : {}) });
          if (!target) return actionStartTargetUnavailableV1(context, 'workflow_owner', 'caller_workspace_unavailable');
          context = {
            ...context,
            externalActionTarget: target,
          };
        }
    return { ...args, context };
  };
  const workflowActionPort: NonNullable<ActionExecutorDeps['workflowAction']> = async (args) => {
      if (!workflowAction) {
        return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      }
      const startedAtMs = Date.now();
      try {
        const resolved = await resolveWorkflowActionArgs(args);
        if ('ok' in resolved) return resolved;
        return await measureActionStartPhaseV1(resolved.context, 'workflow_owner', () => workflowAction(resolved));
      } catch (error) {
        const [{ normalizeWorkflowActionThrownError }, { logger }] = await Promise.all([import("./workflowActionExecutor"), import("@/ui/logger")]);
        return normalizeWorkflowActionThrownError(error, {
          operation: args.actionId, durationMs: Date.now() - startedAtMs,
          emit: diagnostic => logger.infoFile(JSON.stringify(diagnostic)),
        });
      }
    };

  const prepareWorkflowRunStartApproval: CliWorkflowFamily['prepareWorkflowRunStartApproval'] = async (request, presentationDeps) => {
    if (request.actionId !== 'workflow.run.start' || !createOwnedWorkflowExecutor || params.workflowAction) return null;
    const startedAtMs = Date.now();
    try {
      const args = { actionId: request.actionId, input: WorkflowRunStartRequestV1Schema.parse(request.input),
        context: request.context } satisfies WorkflowActionExecuteArgs<'workflow.run.start'>;
      const resolved = await resolveWorkflowActionArgs(args);
      if ('ok' in resolved) return resolved;
      const execute = await createOwnedWorkflowExecutor(resolved);
      return await execute.prepareStartApproval({ ...args, context: resolved.context }, presentationDeps);
    } catch (error) {
      const [{ normalizeWorkflowActionThrownError }, { logger }] = await Promise.all([import('./workflowActionExecutor'), import('@/ui/logger')]);
      return normalizeWorkflowActionThrownError(error, { operation: request.actionId,
        durationMs: Date.now() - startedAtMs, emit: diagnostic => logger.infoFile(JSON.stringify(diagnostic)) }, true);
    }
  };

  return { workflowTriggers, resolveWorkflowMaterializer, readWorkflowApprovedOperation, readWorkflowActionStartContext, workflowAction, workflowActionPort, prepareWorkflowRunStartApproval,
    startCombinedWorkflow, waitForCombinedWorkflow, readCombinedWorkflowInvocations };
}
