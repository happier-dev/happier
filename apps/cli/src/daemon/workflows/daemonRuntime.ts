import type {
  ActionExecutorContext,
  AccountApiTokensListActionOutputV1,
  WorkflowAcceptedAuthorizationV1,
} from '@happier-dev/protocol';
import { resolveSessionRuntimeSnapshot } from '@/daemon/sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS, WorkflowSessionAuthoringSelectionSchema } from '@happier-dev/protocol/workflows/workflowV1';
import { SessionOwnerMetadataV1Schema, readSessionModesMetadata } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionInputCancelExactTurnResultV1Schema } from '@happier-dev/protocol/sessions/control/exactTurnCancellationV1';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { admitAgentStartV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { readSessionMcpSelectionV1FromMetadata, readSessionMcpSelectionRestartRequiredV1FromMetadata } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { freezeActionCompletionContractV1, readActionCompletionRunObservationV1 } from '@happier-dev/protocol/actions/actionCompletion';
import type { ActionCompletionOperation } from '@happier-dev/protocol/actions/actionCompletion';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { ExecutionRunWaitResultSchema, ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationPermissionMediationSourceCurrentnessResultV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { configuration } from '@/configuration';
import { resolveAutomationWorkerAccountEncryption } from '@/daemon/automation/automationWorker';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  readAuthoritativePluginSlotOccurrence,
} from '@/plugins/runtime/reload/runtimeLease';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCredentialedWorkflowMaterializationHostV1 } from '@/session/actions/workflowMaterializationHost';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { callExactMachineRpc, callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import type { StoredCredentials } from '@/persistence';
import { waitForDaemonAdmission, type DaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import { createSpawnConnectedServicesTeamResourceCatalogResolver } from '@/session/services/spawnConnectedServicesDefaults';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';

import {
  createProductionWorkflowRunCoordinator,
  createWorkflowRunPushNotificationClient,
  resolveWorkflowTriggerClaimSource,
} from './production';
import {
  createWorkflowRunRecoveryReader,
} from './recovery';
import { createWorkflowInvocationRecoveryObserver, resolveWorkflowAuthorizedSession } from './invocationRecoveryObserver';
import { createWorkflowRunStorageClient } from './workflowRunStorageClient';
import { createWorkflowRunReviewEntryNotificationHandler } from '@/notifications/activity/dispatchWorkflowRunUpdateNotification';
import { WorkflowSessionCompositionError, type WorkflowSessionConversation } from './sessionStepExecutor';

type MachineAdmissionTransport = NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>;

/** Host-private context from an accepted Workflow execution, never Action input. */
export function buildWorkflowActionContext(execution: Readonly<{
  runId: string;
  authorization: WorkflowAcceptedAuthorizationV1;
  workspace?: Readonly<{ machineId: string }>;
  signal?: AbortSignal;
}>, requesterWorkAttributionV1?: RequesterWorkAttributionV1): ActionExecutorContext {
  return {
    surface: 'agent' as const,
    authority: 'account_automation' as const,
    actionCaller: {
      kind: 'workflowRun' as const,
      runId: execution.runId,
      authorization: execution.authorization,
    },
    executionRunWorkflowRunId: execution.runId,
    ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
    ...(execution.workspace ? { executionRunTargetMachineId: execution.workspace.machineId } : {}),
    callerPermissionMode: execution.authorization.admittedPermissionCeiling,
    ...(execution.signal ? { signal: execution.signal } : {}),
  };
}

/** Only the loaded origin input queue can prove that a committed step was withdrawn. */
export async function withdrawWorkflowOriginSessionInput(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  machineId: string;
  localInputId: string;
  signal?: AbortSignal;
}>): Promise<'withdrawn' | 'dispatched'> {
  const authorized = await resolveWorkflowAuthorizedSession(params);
  if (!authorized) throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
  const { target } = authorized;
  const request = {
    token: params.credentials.token, sessionId: params.sessionId,
    method: SESSION_RPC_METHODS.SESSION_WORKFLOW_STEP_WITHDRAW,
    request: { localInputId: params.localInputId },
    ...(params.signal ? { signal: params.signal } : {}),
  };
  let result: unknown;
  try {
    result = target.mode === 'plain'
      ? await callSessionRpc({ ...request, mode: 'plain' })
      : await callSessionRpc({ ...request, mode: 'e2ee', ctx: target.ctx });
  } catch {
    throw new WorkflowSessionCompositionError('workflow_origin_input_withdrawal_unavailable');
  }
  if (result !== 'withdrawn' && result !== 'dispatched') {
    throw new WorkflowSessionCompositionError('workflow_origin_input_withdrawal_unavailable');
  }
  return result;
}

/** After `dispatched`, request the canonical exact-turn stop, never Pending retirement. */
export async function cancelDispatchedWorkflowOriginSessionInput(params: Readonly<{
  credentials: StoredCredentials; sessionId: string; machineId: string; localInputId: string; signal?: AbortSignal;
}>): Promise<void> {
  const authorized = await resolveWorkflowAuthorizedSession(params);
  if (!authorized) throw new WorkflowSessionCompositionError('workflow_conversation_unavailable');
  const request = {
    token: params.credentials.token, sessionId: params.sessionId,
    method: SESSION_RPC_METHODS.SESSION_INPUT_CANCEL_EXACT_TURN_V1,
    request: { sessionId: params.sessionId, localId: params.localInputId },
    ...(params.signal ? { signal: params.signal } : {}),
  };
  try {
    const result = authorized.target.mode === 'plain'
      ? await callSessionRpc({ ...request, mode: 'plain' })
      : await callSessionRpc({ ...request, mode: 'e2ee', ctx: authorized.target.ctx });
    const parsed = SessionInputCancelExactTurnResultV1Schema.safeParse(result);
    if (!parsed.success || !parsed.data.ok || parsed.data.sessionId !== params.sessionId || parsed.data.localId !== params.localInputId) {
      throw new WorkflowSessionCompositionError('workflow_origin_input_stop_unavailable');
    }
  } catch {
    throw new WorkflowSessionCompositionError('workflow_origin_input_stop_unavailable');
  }
}

/** Authorized owner metadata supplies identity and applied Session state, never list presentation. */
export async function resolveWorkflowSessionConversation(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  machineId: string;
  signal?: AbortSignal;
}>): Promise<WorkflowSessionConversation | null> {
  const authorized = await resolveWorkflowAuthorizedSession(params);
  if (!authorized) return null;
  const { target, metadata } = authorized;
  if (typeof metadata.path !== 'string' || !metadata.path.trim()) return null;
  const backend = resolveBackendTargetFromSessionMetadata(metadata);
  const contribution = backend ? readAgentCatalogSnapshot().agentDefinitionsById.get(backend.backendId) : null;
  const agentTarget = contribution?.identity ? { kind: 'agent' as const, identity: contribution.identity } : undefined;
  const selection: Record<string, unknown> = {};
  // Reuse the portable selection schema and field inventory. Metadata-only
  // fields and secrets never become a Workflow witness.
  for (const field of WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS) {
    if (metadata[field] === undefined) continue;
    const parsed = WorkflowSessionAuthoringSelectionSchema.shape[field].safeParse(metadata[field]);
    if (parsed.success) selection[field] = parsed.data;
  }
  if (agentTarget) selection.agentTarget = agentTarget;
  const stateFields = SessionOwnerMetadataV1Schema.shape.runtime.unwrap().shape;
  const modes = readSessionModesMetadata(metadata);
  if (modes?.currentModeId && modes.agentId === backend?.backendId) {
    selection.acpSessionModeId = modes.currentModeId;
  } else {
    delete selection.acpSessionModeId;
  }
  const config = stateFields.sessionConfigOptionsV1.safeParse(metadata.sessionConfigOptionsV1 ?? metadata.acpConfigOptionsV1);
  if (config.success && config.data && config.data.agentId === backend?.backendId) {
    selection.sessionConfigOptionOverrides = {
      v: 1, updatedAt: config.data.updatedAt,
      overrides: Object.fromEntries(config.data.configOptions.map((option) => [option.id, {
        updatedAt: config.data!.updatedAt, value: option.currentValue,
      }])),
    };
  } else {
    delete selection.sessionConfigOptionOverrides;
  }
  // Pending MCP intent is not applied runtime state; its existing owner retains
  // the exact applied selection when a restart is required.
  const mcp = readSessionMcpSelectionRestartRequiredV1FromMetadata(metadata)?.appliedSelection
    ?? readSessionMcpSelectionV1FromMetadata(metadata);
  if (mcp) selection.mcpSelection = mcp;
  const { permissionMode, modelSelection } = resolveSessionRuntimeSnapshot({
    incomingOptions: { existingSessionId: target.sessionId, directory: metadata.path },
    persistedMetadata: metadata,
  }).snapshot;
  return {
    sessionId: target.sessionId, machineId: params.machineId, directory: metadata.path,
    ...(target.rawSession.origin ? { origin: target.rawSession.origin } : {}),
    ...(target.rawSession.workDepth === undefined ? {} : { workDepth: target.rawSession.workDepth }),
    ...(agentTarget ? { agentTarget } : {}),
    runtimeSelection: WorkflowSessionAuthoringSelectionSchema.parse(selection),
    runtimeSnapshot: { permissionMode, modelSelection },
  };
}

async function resolveAvailableEncryption(credentials: StoredCredentials, signal?: AbortSignal) {
  const resolved = await resolveAutomationWorkerAccountEncryption({
    token: credentials.token,
    credentials,
    ...(signal ? { signal } : {}),
  });
  if (resolved.kind !== 'available') throw new Error('workflow_account_encryption_unavailable');
  return resolved;
}

export { createWorkflowInvocationRecoveryObserver } from './invocationRecoveryObserver';

export function createWorkflowAcceptedAuthorizationCurrentness(params: Readonly<{
  accountId: string;
  listAccountApiTokens: (signal?: AbortSignal) => Promise<AccountApiTokensListActionOutputV1>;
  resolveCurrentPluginOccurrenceId: (pluginId: string) => Promise<string | null>;
  resolveCurrentPluginSourceCustody: (pluginId: string) => Promise<PluginSourceCustodyV1 | null>;
  isMediatedSourceCurrent: (
    sourceAuthority: NonNullable<WorkflowAcceptedAuthorizationV1['sourceAuthority']>,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  now?: () => number;
}>) {
  const now = params.now ?? Date.now;
  return async ({ authorization, signal }: Readonly<{
    authorization: WorkflowAcceptedAuthorizationV1;
    signal?: AbortSignal;
  }>): Promise<boolean> => {
    // A failed authority read is unknown, not revocation. Propagate it to the
    // claim owner's interruption/reclaim path; only verified negatives return false.
    const principal = authorization.principal;
    if (authorization.sourceAuthority) {
      // The authoritative plugin-runtime lease proves that the admitted
      // mediator still exists before this Run may release another leaf.
      const sourceMediatorOccurrenceId = await params.resolveCurrentPluginOccurrenceId(
        authorization.sourceAuthority.mediatorPluginId,
      );
      if (sourceMediatorOccurrenceId === null) return false;
      if (!(await params.isMediatedSourceCurrent(authorization.sourceAuthority, signal))) {
        return false;
      }
    }
    // Session is immutable acceptance attribution, not a revocable grant
    // from the originating process. The accepted Run outlives that Session.
    if (principal.kind === 'host' || principal.kind === 'session') {
      return true;
    }
    if (principal.kind === 'api') {
      if (principal.accountId !== params.accountId || principal.principalId !== params.accountId) {
        return false;
      }
      const current = await params.listAccountApiTokens(signal);
      const token = current.tokens.find((candidate) => candidate.tokenId === principal.credentialId);
      return token !== undefined
        && (token.expiresAt === null || Date.parse(token.expiresAt) > now());
    }
    const sourceCustody = await params.resolveCurrentPluginSourceCustody(
      principal.pluginId,
    );
    return sourceCustody !== null
      && pluginSourceCustodyV1Equal(sourceCustody, principal.sourceCustody);
  };
}

/**
 * Process-lifetime production composition for the one Workflow coordinator and
 * its lifecycle-indexed recovery reader. The Automation worker remains the
 * claim owner; this factory only binds incumbent Session/Action/storage owners.
 */
export function createProductionDaemonWorkflowRuntime(params: Readonly<{
  admissionDrain?: DaemonAdmissionDrain;
  credentials: StoredCredentials;
  accountId: string;
  serverId?: string;
}>) {
  const serverId = params.serverId ?? configuration.activeServerId;
  const admissionDrain = params.admissionDrain;
  const operationRpc = async (operation: ActionCompletionOperation, kind: 'get' | 'cancel' | 'wait', signal?: AbortSignal,
    includeSetupReview?: true) => {
    // Retained observation cannot select another Home's credentials or custody.
    if (operation.serverId !== serverId) throw new Error('action_operation_home_mismatch');
    return await callExactMachineRpc({ credentials: params.credentials, machineId: operation.machineId,
      serverUrl: configuration.apiServerUrl, authorityCeiling: 'account_automation',
      method: kind === 'cancel' ? ACTION_OPERATION_RPC_METHODS_V1.cancel : ACTION_OPERATION_RPC_METHODS_V2.get,
      request: { operationId: operation.operationId, ...(kind === 'wait' ? { waitForTerminal: true,
        ...(includeSetupReview ? { includeSetupReview } : {}) } : {}) },
      ...(kind === 'wait' ? { timeoutMs: null } : {}), ...(signal ? { signal } : {}),
    });
  };
  const accountServerActionDeps = createAccountServerActionDeps({
    token: params.credentials.token,
    serverId,
    serverHttpBaseUrl: configuration.apiServerUrl,
  });
  const isAcceptedAuthorizationCurrent = createWorkflowAcceptedAuthorizationCurrentness({
    accountId: params.accountId,
    listAccountApiTokens: async (signal) => {
      const list = accountServerActionDeps.accountApiTokensListAction;
      if (!list) throw new Error('workflow_api_token_currentness_unavailable');
      const result = await list({
        input: {},
        context: { surface: 'cli', authority: 'account_automation', serverId },
        ...(signal ? { signal } : {}),
      });
      if (!('tokens' in result)) throw new Error('workflow_api_token_currentness_unavailable');
      return result;
    },
    resolveCurrentPluginOccurrenceId: async (pluginId) => (
      readAuthoritativePluginSlotOccurrence(pluginId)?.occurrenceId ?? null
    ),
    resolveCurrentPluginSourceCustody: async (pluginId) => (
      readAuthoritativePluginSlotOccurrence(pluginId)?.sourceCustody ?? null
    ),
    isMediatedSourceCurrent: async (sourceAuthority, signal) => {
      const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
      try {
        const result = await executeContributedAction({
          runtimeRegistry: lease.registry,
          actionId: buildQualifiedPluginContributionKey({
            pluginId: sourceAuthority.mediatorPluginId,
            localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.permissionMediationSourceCurrentness,
          }),
          input: {
            sourceRef: sourceAuthority.sourceRef,
            sourceRevisionOrEpoch: sourceAuthority.sourceRevisionOrEpoch,
            remoteApprovalMaxScope: sourceAuthority.remoteApprovalMaxScope,
          },
          context: {
            surface: 'plugin',
            invocationSurface: 'background',
            ...(signal ? { signal } : {}),
          },
        });
        if (!result.matched || !result.result.ok) throw new Error('workflow_source_currentness_unavailable');
        const parsed = ConversationPermissionMediationSourceCurrentnessResultV1Schema.safeParse(
          result.result.result,
        );
        if (!parsed.success) throw new Error('workflow_source_currentness_unavailable');
        return parsed.data.current;
      } finally {
        await lease.release();
      }
    },
  });
  return {
    isAcceptedAuthorizationCurrent,
    createCoordinatorForMachine(input: Readonly<{
      machineId: string;
      requesterWorkAttributionV1?: RequesterWorkAttributionV1;
      machineAdmissionTransport: MachineAdmissionTransport;
      machineActionDirectTargetTransport: import('@/session/actions/createCliActionDeps').MachineActionDirectTargetTransport;
      managedMachineAction?: import('@happier-dev/protocol').ActionExecutorDeps['managedMachineAction'];
    }>) {
      const parsedStamp = RequesterWorkAttributionV1Schema.safeParse(input.requesterWorkAttributionV1);
      const stamp = parsedStamp.success ? Object.freeze(parsedStamp.data) : undefined;
      const requesterWorkAttributionV1 = stamp?.serverId === serverId
        && stamp.accountId === params.accountId && stamp.machineId === input.machineId ? stamp : undefined;
      const resolveTeamCredentialResourceCatalog = accountServerActionDeps.homeDomainAction
        ? createSpawnConnectedServicesTeamResourceCatalogResolver({
            homeDomainAction: accountServerActionDeps.homeDomainAction,
            serverId,
            accountId: params.accountId,
          })
        : undefined;
      const actionExecutor = createCliActionExecutorFromCredentials({
        credentials: params.credentials,
        machineId: input.machineId,
        machineAdmissionTransport: input.machineAdmissionTransport,
        machineActionDirectTargetTransport: input.machineActionDirectTargetTransport,
        ...(input.managedMachineAction ? { managedMachineAction: input.managedMachineAction } : {}),
        workflowAcceptedAuthorizationCurrentness: isAcceptedAuthorizationCurrent,
      });
      const resolveMaterializer = createCredentialedWorkflowMaterializationHostV1({
        credentials: params.credentials, accountId: params.accountId,
        callMachineAction: async (request) => {
          if (request.machineId !== input.machineId) throw new Error('target_unavailable');
          return await input.machineActionDirectTargetTransport.invoke(request.method, request.request,
            request.signal ? { signal: request.signal } : undefined);
        },
        readWorkflowDefinition: async (ref, signal) => {
          const encryption = await resolveAvailableEncryption(params.credentials, signal);
          const source = await resolveWorkflowTriggerClaimSource({ target: { kind: 'workflow', ref: formatWorkflowDefinitionRefV1(ref) },
            credentials: params.credentials, encryption, ...(signal ? { signal } : {}) });
          return source ? { ...source, sourceKey: formatWorkflowDefinitionRefV1(ref) } : null;
        },
        readHostActionContract: async (actionId, target) => {
          if (target.machineId !== input.machineId) return null;
          const result = await actionExecutor.execute('action.spec.get', { id: actionId }, {
            surface: 'cli', authority: 'account_automation',
            externalActionTarget: { kind: 'machine', machineId: target.machineId, project: { machineId: target.machineId, directory: target.directory } },
            ...(target.signal ? { signal: target.signal } : {}),
          });
          if (!result.ok || !result.result || typeof result.result !== 'object' || !('actionSpec' in result.result)) return null;
          const spec = ActionDefinitionV1Schema.safeParse(result.result.actionSpec);
          if (!spec.success || spec.data.id !== actionId || spec.data.outputSchema === undefined) return null;
          const id = ActionIdSchema.safeParse(actionId);
          if (!id.success) return null;
          // This is the exact run machine's host catalog. Executable completion
          // functions stay host-private; only their frozen schema is sealed.
          const hostSpec = getActionSpec(id.data);
          const declaration = hostSpec.completion;
          const outputSchema = declaration?.terminalOutputSchema ?? hostSpec.outputSchema;
          if (outputSchema === undefined) return null;
          return { inputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(hostSpec.inputSchema, { target: 'draft-7' })),
            outputSchema: StrictJsonValueSchema.parse(zodSchemaToJsonSchemaObject(outputSchema, { target: 'draft-7' })),
            ...(declaration ? { completion: freezeActionCompletionContractV1(declaration) } : {}) };
        },
      });
      const resolveMaterializationHost: NonNullable<Parameters<typeof createProductionWorkflowRunCoordinator>[0]['resolveMaterializationHost']> = async (claim) => {
        const materialization = await resolveMaterializer({ machineId: input.machineId, directory: claim.directory,
          ...(claim.signal ? { signal: claim.signal } : {}) });
        const current = materialization.agentStartPolicySnapshot;
        return { ...materialization, admitLeaf: async (leaf, facts) => admitAgentStartV1(current.policy,
          { kind: 'workflow_run_leaf', leaf }, {
            caller: { kind: 'originless', runId: claim.runId, runDepth: claim.workDepth,
              ...(claim.originSessionId ? { runOriginSessionId: claim.originSessionId } : {}) },
            baseline: { machineId: input.machineId, directory: claim.directory }, ledSubtreeSessionIds: [],
            roles: facts.role ? { [facts.role.roleId]: facts.role } : {},
            callerPermissionCeiling: facts.permissionCeiling, workDepthLimit: current.workDepthLimit,
            allowLists: current.allowLists,
          }) };
      };
      const resolveWorkflowActionContext = async (execution: Readonly<{
        runId: string;
        authorization: WorkflowAcceptedAuthorizationV1;
        workspace: Readonly<{ machineId: string; directory: string }>;
        workDepth: number;
        originSessionId?: string;
        role?: import('@happier-dev/protocol').WorkflowMaterializedLeafV1['role'];
        signal?: AbortSignal;
      }>) => {
        const materialization = await resolveMaterializer({ machineId: execution.workspace.machineId,
          directory: execution.workspace.directory, ...(execution.signal ? { signal: execution.signal } : {}) });
        const current = materialization.agentStartPolicySnapshot;
        return { ...buildWorkflowActionContext(execution, requesterWorkAttributionV1), defaultSessionId: execution.originSessionId ?? null,
          externalActionTarget: { kind: 'machine' as const, machineId: execution.workspace.machineId,
            project: { machineId: execution.workspace.machineId, directory: execution.workspace.directory } },
          sessionAgentSpawnPolicyV1: current.policy,
          agentStartContext: { caller: { kind: 'originless' as const, runId: execution.runId, runDepth: execution.workDepth,
              ...(execution.originSessionId ? { runOriginSessionId: execution.originSessionId } : {}) },
            baseline: { machineId: execution.workspace.machineId, directory: execution.workspace.directory },
            ledSubtreeSessionIds: [], roles: execution.role ? { [execution.role.roleId]: execution.role } : {},
            callerPermissionCeiling: execution.authorization.admittedPermissionCeiling,
            workDepthLimit: current.workDepthLimit, allowLists: current.allowLists } };
      };
      const resolveConversation = async ({ sessionId, machineId, signal }: Readonly<{
        sessionId: string;
        machineId: string;
        signal?: AbortSignal;
      }>) => {
        if (machineId !== input.machineId) return null;
        return await resolveWorkflowSessionConversation({
          credentials: params.credentials,
          sessionId, machineId,
          ...(signal ? { signal } : {}),
        });
      };
      return createProductionWorkflowRunCoordinator({
        token: params.credentials.token,
        ...(requesterWorkAttributionV1 ? { requesterWorkAttributionV1 } : {}),
        accountId: params.accountId,
        machineId: input.machineId,
        resolveAccountEncryption: async (signal) => await resolveAvailableEncryption(params.credentials, signal),
        isAcceptedAuthorizationCurrent,
        ...(admissionDrain ? { waitForNewWorkAdmission: (signal?: AbortSignal) =>
          waitForDaemonAdmission(admissionDrain, signal) } : {}),
        resolveControllerContext: async ({ runId, accepted, signal }) => await resolveWorkflowActionContext({
          runId, authorization: accepted.authorization, workspace: accepted.workspaceTarget.project,
          workDepth: accepted.workDepth,
          ...(accepted.origin?.originSessionId ? { originSessionId: accepted.origin.originSessionId } : {}),
          ...(signal ? { signal } : {}),
        }),
        resolveMaterializationHost,
        resolveCurrentWorkspaceRefs: async (signal) => {
          const snapshot = await readProjectAccountRows({
            credentials: params.credentials,
            serverId: configuration.activeServerId,
            ...(signal ? { signal } : {}),
          });
          return snapshot.workspaceRefs;
        },
        execution: {
          action: {
            executor: actionExecutor,
            buildContext: resolveWorkflowActionContext,
            observeOperation: async (operation, observation) => {
              const observed = ActionOperationGetV1ResponseSchema.parse(await operationRpc(operation, 'wait', observation.signal, true));
              if (observed.kind !== 'found') throw new Error('action_operation_observation_unavailable');
              return observed.operation;
            },
            observeRun: async (run, observation) => {
              if (run.observation) {
                const observed = ExecutionRunGetResponseSchema.safeParse(await input.machineActionDirectTargetTransport.invoke(
                  SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: run.runId, includeStructured: true, waitForOutput: run.observation },
                  observation.signal ? { signal: observation.signal } : undefined));
                if (!observed.success || observed.data.run.runId !== run.runId) {
                  return { kind: 'outcome_uncertain', code: 'execution_run_observation_unavailable' };
                }
                return readActionCompletionRunObservationV1(observed.data, run.observation);
              }
              const waited = ExecutionRunWaitResultSchema.safeParse(await input.machineActionDirectTargetTransport.invoke(
                SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, { runId: run.runId },
                observation.signal ? { signal: observation.signal } : undefined));
              if (!waited.success || !waited.data.ok || waited.data.status === 'running'
                || waited.data.result.run.runId !== run.runId) return { kind: 'outcome_uncertain', code: 'execution_run_observation_unavailable' };
              return readActionCompletionRunObservationV1(waited.data.result);
            },
          },
          credentials: params.credentials,
          serverId,
          machineAdmissionTransport: input.machineAdmissionTransport,
          ...(resolveTeamCredentialResourceCatalog ? { resolveTeamCredentialResourceCatalog } : {}),
          resolveExistingSessionConversation: resolveConversation,
          originSessionInput: {
            withdraw: async ({ sessionId, localInputId }) => await withdrawWorkflowOriginSessionInput({
              credentials: params.credentials, machineId: input.machineId, sessionId, localInputId,
            }),
            cancelDispatched: async ({ sessionId, localInputId }) => await cancelDispatchedWorkflowOriginSessionInput({
              credentials: params.credentials, machineId: input.machineId, sessionId, localInputId,
            }),
          },
          detachedRun: { actionExecutor, buildActionContext: execution => {
            // Rejoining durable input only observes/settles its accepted work.
            // A policy read (especially on an aborted claim) must not prevent
            // Stop; every new start/send still demands fresh host launch facts.
            return execution.invocation.execution || execution.observationOnly
              ? buildWorkflowActionContext(execution, requesterWorkAttributionV1)
              : resolveWorkflowActionContext(execution);
          } },
        },
      });
    },
    createRecoveryForMachine(input: Readonly<{
      machineId: string;
      machineAdmissionTransport: MachineAdmissionTransport;
    }>) {
      const storage = createWorkflowRunStorageClient({ token: params.credentials.token, machineId: input.machineId });
      const actionExecutor = createCliActionExecutorFromCredentials({
        credentials: params.credentials,
        machineId: input.machineId,
        machineAdmissionTransport: input.machineAdmissionTransport,
      });
      return createWorkflowRunRecoveryReader({
        accountId: params.accountId,
        machineId: input.machineId,
        storage,
        onReviewEntered: createWorkflowRunReviewEntryNotificationHandler({
          expoPushSender: createWorkflowRunPushNotificationClient(params.credentials.token),
        }),
        resolveAccountEncryption: async (signal) => await resolveAvailableEncryption(params.credentials, signal),
        reconcileInvocation: createWorkflowInvocationRecoveryObserver({
          credentials: params.credentials,
          machineId: input.machineId,
          actionExecutor,
          nativeActionOperations: {
            get: async (operation, signal) => await operationRpc(operation, 'get', signal),
            cancel: async (operation, signal) => await operationRpc(operation, 'cancel', signal),
            wait: async (operation, signal) => await operationRpc(operation, 'wait', signal),
          },
          nativeActionRuns: {
            get: async (runId, signal) => await callMachineRpc({ credentials: params.credentials, machineId: input.machineId,
              method: SESSION_RPC_METHODS.EXECUTION_RUN_GET, request: { runId, includeStructured: true }, ...(signal ? { signal } : {}) }),
            stop: async (runId, signal) => await callMachineRpc({ credentials: params.credentials, machineId: input.machineId,
              method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP, request: { runId }, ...(signal ? { signal } : {}) }),
            wait: async (runId, signal, observation) => {
              if (observation) return await callMachineRpc({
                credentials: params.credentials, machineId: input.machineId,
                method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
                request: { runId, includeStructured: true, waitForOutput: observation }, timeoutMs: null,
                ...(signal ? { signal } : {}),
              });
              const waited = ExecutionRunWaitResultSchema.safeParse(await callMachineRpc({
                credentials: params.credentials, machineId: input.machineId,
                method: SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, request: { runId }, timeoutMs: null,
                ...(signal ? { signal } : {}),
              }));
              if (!waited.success || !waited.data.ok || waited.data.status === 'running'
                || waited.data.result.run.runId !== runId) throw new Error('execution_run_terminal_observation_unavailable');
              return waited.data.result;
            },
          },
        }),
      });
    },
  };
}
