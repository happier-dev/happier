import type {
  ActionExecutorContext,
  AccountApiTokensListActionOutputV1,
  WorkflowAcceptedAuthorizationV1,
  WorkflowAcceptedOriginV1,
} from '@happier-dev/protocol';
import { materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { WorkflowConversationUnavailableDetailsV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { SessionInputCancelExactTurnResultV1Schema } from '@happier-dev/protocol/sessions/control/exactTurnCancellationV1';
import { freezeWorkflowActionContractV1, readCompleteActionSpecV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { admitAgentStartV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { readWorkflowRunLeafStartRequestV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { readActionCompletionRunObservationV1 } from '@happier-dev/protocol/actions/actionCompletion';
import type { ActionCompletionOperation } from '@happier-dev/protocol/actions/actionCompletion';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ExecutionRunWaitResultSchema, ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import {
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  ConversationPermissionMediationSourceCurrentnessResultV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { captureServerHttpBaseUrl, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { resolveAutomationWorkerAccountEncryption } from '@/daemon/automation/automationWorker';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  readAuthoritativePluginSlotOccurrence,
} from '@/plugins/runtime/reload/runtimeLease';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createWorkflowRequesterCustody } from './requesterCustody';
import { createCredentialedTargetActionCurrentIntent } from '@/session/actions/approvals/credentialedTargetActionCurrentIntent';
import { createCredentialedWorkflowMaterializationHostV1, projectWorkflowConversationRoleSelection } from '@/session/actions/workflowMaterializationHost';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import type { StoredCredentials } from '@/persistence';
import { waitForDaemonAdmission, type DaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import { createSpawnConnectedServicesTeamResourceCatalogResolver } from '@/session/services/spawnConnectedServicesDefaults';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '../lifecycle/requesterWorkAttribution';
import { sameAutomationAccountContentIdentityV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { createWorkflowDiscussionResultPublisher } from './workflowDiscussionPublication';
import { createDiscussionReplyReturnPublisher } from '@/discussions/discussionReplyReturnPublisher';

import {
  createProductionWorkflowRunCoordinator,
  createWorkflowRunPushNotificationClient,
  resolveWorkflowTriggerClaimSource,
} from './production';
import {
  createWorkflowRunRecoveryReader,
  isWorkflowDiscussionModelReservationCurrent,
  type WorkflowDiscussionModelReservationCustody,
  type WorkflowDiscussionModelReservationReplay,
} from './recovery';
import { createWorkflowInvocationRecoveryObserver, resolveWorkflowAuthorizedSession, resolveWorkflowSessionConversation } from './invocationRecoveryObserver';
import { createWorkflowRunStorageClient } from './workflowRunStorageClient';
import { createWorkflowRunReviewEntryNotificationHandler } from '@/notifications/activity/dispatchWorkflowRunUpdateNotification';
import { WorkflowSessionCompositionError } from './sessionStepExecutor';
import { deriveWorkflowSessionCreationTag } from './workflowSessionStartup';
import { lookupSessionsByTags } from '@/session/transport/http/sessionsHttp';

type MachineAdmissionTransport = NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>;

/** Host-private context from an accepted Workflow execution, never Action input. */
export function buildWorkflowActionContext(execution: Readonly<{
  runId: string;
  authorization: WorkflowAcceptedAuthorizationV1;
  origin?: WorkflowAcceptedOriginV1;
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
    ...(execution.origin?.actionRequestAttributionV1 ? {
      actionRequestAttributionV1: materializeActionRequestAttributionV1(execution.origin.actionRequestAttributionV1),
    } : {}),
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

export { resolveWorkflowSessionConversation } from './invocationRecoveryObserver';

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
  discussionModelReservationCustody?: WorkflowDiscussionModelReservationCustody;
}>) {
  const now = params.now ?? Date.now;
  return async ({ authorization, reservation, signal }: Readonly<{
    authorization: WorkflowAcceptedAuthorizationV1;
    reservation?: WorkflowDiscussionModelReservationReplay;
    signal?: AbortSignal;
  }>): Promise<boolean> => {
    if (reservation && (!params.discussionModelReservationCustody
      || !await isWorkflowDiscussionModelReservationCurrent({ ...params.discussionModelReservationCustody,
        accountId: params.accountId, reservation, ...(signal ? { signal } : {}) }))) return false;
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

/** Source-backed accepted-authority reader owned by the assigned Run executor. */
export function createCredentialedWorkflowAcceptedAuthorizationCurrentness(params: Readonly<{
  credentials: StoredCredentials;
  accountId: string;
  serverId?: string;
  serverHttpBaseUrl?: string;
}>) {
  const serverId = params.serverId ?? configuration.activeServerId;
  const serverHttpBaseUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const accountServerActionDeps = createAccountServerActionDeps({
    token: params.credentials.token,
    serverId,
    serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
  });
  return createWorkflowAcceptedAuthorizationCurrentness({
    accountId: params.accountId,
    discussionModelReservationCustody: {
      storage: createWorkflowRunStorageClient({ token: params.credentials.token, serverHttpBaseUrl }),
      resolveAccountEncryption: async signal => await runWithServerHttpBaseUrl(serverHttpBaseUrl,
        () => resolveAvailableEncryption(params.credentials, signal)),
    },
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
}

/** Production composition; the Automation worker remains the claim owner. */
export function createProductionDaemonWorkflowRuntime(params: Readonly<{
  secretSources?: import('./production').WorkflowProductionExecutionDeps['secretSources'];
  admissionDrain?: DaemonAdmissionDrain;
  credentials: StoredCredentials;
  accountId: string;
  serverId?: string;
}>) {
  const serverId = params.serverId ?? configuration.activeServerId;
  const readBaseUrl = captureServerHttpBaseUrl();
  const admissionDrain = params.admissionDrain;
  const operationRpc = async (transport: import('@/session/actions/createCliActionDeps').MachineActionDirectTargetTransport,
    operation: ActionCompletionOperation, kind: 'get' | 'cancel' | 'wait', signal?: AbortSignal,
    includeSetupReview?: true) => {
    if (!await isServerProfileHomeIdentity(serverId, operation.serverId)) throw new Error('action_operation_home_mismatch');
    const method = kind === 'cancel' ? ACTION_OPERATION_RPC_METHODS_V1.cancel : ACTION_OPERATION_RPC_METHODS_V2.get;
    const request = { operationId: operation.operationId, ...(kind === 'wait' ? { waitForTerminal: true,
      ...(includeSetupReview ? { includeSetupReview } : {}) } : {}) };
    // The installed daemon already owns this operation. Observe its exact
    // custody locally, as discovery does, without another Home RPC admission.
    // A retained operation on a different Machine still uses its original route.
    if (operation.machineId === transport.machineId) return await transport.invoke(method, request,
      signal ? { signal } : undefined);
    return await callExactMachineRpc({ credentials: params.credentials, machineId: operation.machineId,
      serverUrl: resolveServerHttpBaseUrl(), authorityCeiling: 'account_automation',
      method, request,
      ...(kind === 'wait' ? { timeoutMs: null } : {}), ...(signal ? { signal } : {}),
    });
  };
  const accountServerActionDeps = createAccountServerActionDeps({ token: params.credentials.token, serverId,
    serverHttpBaseUrl: resolveServerHttpBaseUrl() });
  const isAcceptedAuthorizationCurrent = createCredentialedWorkflowAcceptedAuthorizationCurrentness(params);
  return {
    isAcceptedAuthorizationCurrent,
    createCoordinatorForMachine(input: Readonly<{
      machineId: string;
      sessionStartup?: import('./sessionStepExecutor').WorkflowSessionStartup;
      postWorkflowMessage?: import('./production').WorkflowProductionExecutionDeps['postWorkflowMessage'];
      requesterWorkAttributionV1?: RequesterWorkAttributionV1;
      machineAdmissionTransport: MachineAdmissionTransport;
      machineActionDirectTargetTransport: import('@/session/actions/createCliActionDeps').MachineActionDirectTargetTransport;
      managedMachineAction?: import('@happier-dev/protocol').ActionExecutorDeps['managedMachineAction'];
      sessionActionRpcTransport?: import('@/session/actions/createCliActionDeps').SessionActionRpcTransport;
      installationIdentity?: Readonly<{ installationId: string; privateKey: import('@/api/externalActionExecutionAuthorization').ExternalActionMachineRequestSigningKey }>;
      serverIdentityId?: string;
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
        serverId,
        serverApiUrl: resolveServerHttpBaseUrl(),
        machineId: input.machineId,
        ...(requesterWorkAttributionV1 ? { workflowRequesterCustody: createWorkflowRequesterCustody({
          credentials: params.credentials, attribution: requesterWorkAttributionV1,
          happyHomeDir: configuration.happyHomeDir, serverHttpBaseUrl: readBaseUrl(),
          homeServerIdentityId: input.serverIdentityId,
        }) } : {}),
        machineAdmissionTransport: input.machineAdmissionTransport,
        machineActionDirectTargetTransport: input.machineActionDirectTargetTransport,
        ...(input.sessionActionRpcTransport ? { sessionActionRpcTransport: input.sessionActionRpcTransport } : {}),
        ...(input.installationIdentity ? { externalActionMachineInstallationId: input.installationIdentity.installationId,
          externalActionMachineRequestPrivateKey: input.installationIdentity.privateKey } : {}),
        ...(input.serverIdentityId ? { serverIdentityId: input.serverIdentityId } : {}),
        ...(input.managedMachineAction ? { managedMachineAction: input.managedMachineAction } : {}),
        workflowAcceptedAuthorizationCurrentness: isAcceptedAuthorizationCurrent,
        pluginActionExecutionOwner: 'current_process',
        listContributedActionDefinitions: createCommittedContributedActionDefinitionLister(),
        invokeContributedAction: createCommittedContributedActionInvoker({
          isWorkflowRunAuthorizationCurrent: isAcceptedAuthorizationCurrent,
          requestCurrentIntent: createCredentialedTargetActionCurrentIntent(params.credentials),
        }),
      });
      const resolveMaterializer = createCredentialedWorkflowMaterializationHostV1({
        credentials: params.credentials, accountId: params.accountId,
        serverId, serverIdentityId: input.serverIdentityId,
        callMachineAction: async (request) => {
          if (request.machineId !== input.machineId) {
            return await callExactMachineRpc({ credentials: params.credentials, machineId: request.machineId,
              serverUrl: resolveServerHttpBaseUrl(), authorityCeiling: 'account_automation',
              method: request.method, request: request.request,
              ...(request.signal ? { signal: request.signal } : {}) });
          }
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
          const spec = await readCompleteActionSpecV1({ actionId, ...(target.signal ? { signal: target.signal } : {}),
            read: async input => {
              const result = await actionExecutor.execute('action.spec.get', input, {
                surface: 'cli', authority: 'account_automation',
                externalActionTarget: { kind: 'machine', machineId: target.machineId, project: { machineId: target.machineId, directory: target.directory } },
                ...(target.signal ? { signal: target.signal } : {}),
              });
              if (!result.ok) throw new Error('action_contract_unavailable');
              return result.result;
            },
          });
          return freezeWorkflowActionContractV1(spec);
        },
      });
      const resolveMaterializationHost: NonNullable<Parameters<typeof createProductionWorkflowRunCoordinator>[0]['resolveMaterializationHost']> = async (claim) => {
        const origin = claim.originSessionId ? await resolveWorkflowSessionConversation({
          credentials: params.credentials, sessionId: claim.originSessionId, machineId: input.machineId,
          ...(claim.signal ? { signal: claim.signal } : {}),
        }) : null;
        if (claim.originSessionId && !origin) {
          throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
        }
        const materialization = await resolveMaterializer({ machineId: input.machineId, directory: claim.directory,
          ...(origin ? { roleSelection: projectWorkflowConversationRoleSelection(origin, input.machineId) } : {}),
          ...(claim.signal ? { signal: claim.signal } : {}) });
        const current = materialization.agentStartPolicySnapshot;
        return { ...materialization, admitLeaf: async (leaf, facts) => admitAgentStartV1(current.policy,
          readWorkflowRunLeafStartRequestV1(leaf), {
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
        origin?: WorkflowAcceptedOriginV1;
        role?: import('@happier-dev/protocol').WorkflowMaterializedLeafV1['role'];
        signal?: AbortSignal;
      }>) => {
        const materialization = await resolveMaterializer({ machineId: execution.workspace.machineId,
          directory: execution.workspace.directory, ...(execution.signal ? { signal: execution.signal } : {}) });
        const current = materialization.agentStartPolicySnapshot;
        return { ...buildWorkflowActionContext(execution, requesterWorkAttributionV1), defaultSessionId: execution.originSessionId ?? null,
          workspaceWrites: execution.role?.workspaceWrites ?? 'allow',
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
      const resolveConversation = async ({ sessionId, machineId, signal, onUnavailable }: Readonly<{
        sessionId: string;
        machineId: string;
        signal?: AbortSignal;
        onUnavailable?: (details: WorkflowConversationUnavailableDetailsV1) => void;
      }>) => {
        return await resolveWorkflowSessionConversation({
          credentials: params.credentials,
          sessionId, machineId,
          ...(signal ? { signal } : {}),
          ...(onUnavailable ? { onUnavailable } : {}),
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
          ...(accepted.origin ? { origin: accepted.origin } : {}),
          ...(accepted.origin?.originSessionId ? { originSessionId: accepted.origin.originSessionId } : {}),
          ...(signal ? { signal } : {}),
        }),
        resolveMaterializationHost,
        resolveCurrentWorkspaceRefs: async (signal) => {
          const snapshot = await readProjectAccountRows({
            credentials: params.credentials,
            publication: 'installed',
            serverId: configuration.activeServerId,
            ...(signal ? { signal } : {}),
          });
          return snapshot.workspaceRefs;
        },
        execution: {
          action: {
            executor: actionExecutor,
            buildContext: resolveWorkflowActionContext,
            observeApproval: async ({ artifactId, actionRequestId, authorization, signal }) => {
              if (!input.serverIdentityId) return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
              return await actionExecutor.observeRecordedApprovalExecution({ artifactId, signal,
                expectedOrigin: { actionId: 'discussion.invite', requestId: actionRequestId,
                  accountId: params.accountId, serverIdentityId: input.serverIdentityId, machineId: input.machineId },
                isCurrent: async () => await isAcceptedAuthorizationCurrent({ authorization, signal }),
              });
            },
            observeOperation: async (operation, observation) => {
              const observed = ActionOperationGetV1ResponseSchema.parse(await operationRpc(input.machineActionDirectTargetTransport,
                operation, 'wait', observation.signal, true));
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
          secretSources: params.secretSources,
          serverId,
          ...(input.postWorkflowMessage ? { postWorkflowMessage: input.postWorkflowMessage } : {}),
          ...(input.serverIdentityId ? { serverIdentityId: input.serverIdentityId } : {}),
          ...(input.sessionStartup ? { sessionStartup: input.sessionStartup } : {}),
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
      postWorkflowMessage?: import('./production').WorkflowProductionExecutionDeps['postWorkflowMessage'];
      machineAdmissionTransport: MachineAdmissionTransport;
      machineActionDirectTargetTransport: import('@/session/actions/createCliActionDeps').MachineActionDirectTargetTransport;
    }>) {
      const storage = createWorkflowRunStorageClient({ token: params.credentials.token, machineId: input.machineId });
      const actionExecutor = createCliActionExecutorFromCredentials({
        credentials: params.credentials,
        machineId: input.machineId,
        machineAdmissionTransport: input.machineAdmissionTransport,
        machineActionDirectTargetTransport: input.machineActionDirectTargetTransport,
      });
      return createWorkflowRunRecoveryReader({
        accountId: params.accountId,
        machineId: input.machineId,
        storage,
        onReviewEntered: createWorkflowRunReviewEntryNotificationHandler({
          secretSources: params.secretSources,
          expoPushSender: createWorkflowRunPushNotificationClient(params.credentials.token),
        }),
        resolveAccountEncryption: async (signal) => await resolveAvailableEncryption(params.credentials, signal),
        onInvocationSettled: async ({ run, accepted, invocation, encryption, signal }) => {
          if (accepted.resultDelivery?.kind !== 'originating_discussion') return;
          const current = async () => !signal?.aborted
            && sameAutomationAccountContentIdentityV1((await resolveAvailableEncryption(params.credentials, signal)).witness, encryption.witness)
            && await isAcceptedAuthorizationCurrent({ authorization: accepted.authorization, ...(signal ? { signal } : {}) });
          const publish = createWorkflowDiscussionResultPublisher({ credentials: params.credentials,
            origin: accepted.resultDelivery, isCurrent: current, ...(signal ? { signal } : {}),
            publish: createDiscussionReplyReturnPublisher({ credentials: params.credentials,
              machineId: input.machineId, serverId, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
              workflowAuthorization: accepted.authorization,
              signal: signal ?? new AbortController().signal, isCurrent: current,
              ...(input.postWorkflowMessage ? { postWorkflowMessage: input.postWorkflowMessage } : {}) }),
          });
          await publish({ runId: run.id, invocation,
            ...(run.state === 'interrupted' ? { expectedParentRevision: run.revision } : {}) });
        },
        reconcileInvocation: createWorkflowInvocationRecoveryObserver({
          credentials: params.credentials,
          machineId: input.machineId,
          actionExecutor,
          nativeActionOperations: {
            findStartup: async (creationKey, signal) => {
              if (input.machineActionDirectTargetTransport.machineId !== input.machineId) return null;
              let cursor: string | undefined;
              do {
                const page = ActionOperationListV1ResponseSchema.parse(await input.machineActionDirectTargetTransport.invoke(
                  ACTION_OPERATION_RPC_METHODS_V2.list, { ...(cursor ? { cursor } : {}) }, signal ? { signal } : undefined));
                if (page.items.some(operation => operation.scope.accountId !== params.accountId
                  || operation.scope.machineId !== input.machineId)) return null;
                const operation = page.items.find(operation => operation.actionId === 'session.spawn_new'
                  && operation.requestId === creationKey && operation.scope.accountId === params.accountId
                  && operation.scope.machineId === input.machineId);
                if (operation) return { kind: 'found', operation, target: { key: 'startup', serverId, machineId: input.machineId,
                  operationId: operation.operationId } };
                if (page.nextCursor === cursor) throw new Error('action_operation_cursor_not_progressing');
                cursor = page.nextCursor ?? undefined;
              } while (cursor && !signal?.aborted);
              signal?.throwIfAborted();
              return { kind: 'absent' };
            },
            findSession: async ({ runId, creationKey, signal }) => {
              const tag = deriveWorkflowSessionCreationTag(serverId, runId, creationKey);
              const found = await lookupSessionsByTags({ token: params.credentials.token, tags: [tag],
                ...(signal ? { signal } : {}) });
              if (found.state !== 'available' || found.sessions.length > 1) throw new Error('workflow_startup_discovery_unavailable');
              const session = found.sessions[0];
              if (!session) return null;
              const authorized = await resolveWorkflowAuthorizedSession({ credentials: params.credentials,
                sessionId: session.id, machineId: input.machineId, sessionCreationTag: tag,
                ...(signal ? { signal } : {}) });
              if (!authorized) throw new Error('workflow_startup_discovery_unavailable');
              return session.id;
            },
            get: async (operation, signal) => await operationRpc(input.machineActionDirectTargetTransport, operation, 'get', signal),
            cancel: async (operation, signal) => await operationRpc(input.machineActionDirectTargetTransport, operation, 'cancel', signal),
            wait: async (operation, signal) => await operationRpc(input.machineActionDirectTargetTransport, operation, 'wait', signal),
          },
          nativeActionRuns: {
            get: async (runId, signal) => await input.machineActionDirectTargetTransport.invoke(
              SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId, includeStructured: true }, signal ? { signal } : undefined),
            stop: async (runId, signal) => await input.machineActionDirectTargetTransport.invoke(
              SESSION_RPC_METHODS.EXECUTION_RUN_STOP, { runId }, signal ? { signal } : undefined),
            wait: async (runId, signal, observation) => {
              if (observation) return await input.machineActionDirectTargetTransport.invoke(
                SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId, includeStructured: true, waitForOutput: observation },
                signal ? { signal } : undefined);
              const waited = ExecutionRunWaitResultSchema.safeParse(await input.machineActionDirectTargetTransport.invoke(
                SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, { runId }, signal ? { signal } : undefined));
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
