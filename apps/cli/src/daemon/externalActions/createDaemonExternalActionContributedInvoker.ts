import { recordFailureCause } from '@/diagnostics/recordFailureCause';
import type { ApprovalRequestV2, TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { readPluginActionError } from '@happier-dev/protocol/plugins/actions/invocation';
import { projectPluginFailureMessage } from '@happier-dev/protocol/plugins/failureProjection';
import { redactPluginInvocationResultData } from '@happier-dev/cli-common/plugins/registration';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { classifyApprovalExecutionOriginCurrentness } from '@happier-dev/protocol/actions/executor/approvalResults';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { projectTargetActionApprovalInvocationV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { createTargetActionApprovalDecision, buildTargetActionApprovalDecisionResult } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { ActionOperationCredentialUseV1Schema, projectActionFailureCauseV1, type ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import type { DaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';
import {
  executeContributedAction,
} from '@/plugins/runtime/invocation/actions/executeContributedAction';
import {
  createCommittedContributedActionDefinitionLister,
  createCommittedContributedActionInvoker,
} from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { projectContributedActionFailure } from '@/plugins/runtime/invocation/actions/contributedActionFailure';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import type {
  TargetActionCurrentIntentRequest,
  TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { PluginExternalActionContext } from '@/plugins/runtime/invocation/services/types';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { settleTargetActionExecution } from '@/session/actions/approvals/targetActionSettlement';

type TargetActionApprovalStore = Pick<
  ReturnType<typeof createCliApprovalsArtifactStore>,
  'targetActionApprovalsGet' | 'targetActionApprovalsUpdate'
>;

function targetActionReplayFailure(
  errorCode: string,
  error = errorCode,
): ActionExecuteResult {
  return { ok: false, errorCode, error };
}

function projectTargetApprovalRequest(request: TargetActionApprovalRequestV1): ApprovalRequestV2 | null {
  const invocation = projectTargetActionApprovalInvocationV1(request);
  if (!invocation || !request.executionOriginV1) return null;
  return { v: 2, status: request.status, createdAtMs: request.createdAtMs, updatedAtMs: request.updatedAtMs,
    createdBy: request.createdBy, requestedSurface: request.requestedSurface, ...invocation,
    executionOriginV1: request.executionOriginV1, summary: request.summary,
    ...(request.requesterConfirmation ? { requesterConfirmation: request.requesterConfirmation } : {}),
    ...(request.detail ? { preview: { detail: request.detail } } : {}),
    ...(request.decision ? { decision: request.decision } : {}),
  };
}

/**
 * Adapts the public host Action `action.invoke` to the one committed-runtime
 * contributed-Action dispatcher. This adapter translates the public typed
 * contribution identity to the registry's canonical internal key; API caller
 * provenance remains host-owned and is deliberately not fabricated as a
 * plugin caller.
 */
export function createDaemonExternalActionContributedInvoker(input: Readonly<{
  managedProviderOperationAuthority?: import('@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority').ManagedProviderOperationAuthority;
  observePluginExecution?: HostActionOperationRuntime['observePluginExecution'];
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  requestCurrentIntent?: (
    request: TargetActionCurrentIntentRequest,
  ) => Promise<TargetActionCurrentIntentResult>;
}> = {}): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
  const acquireRuntimeRegistryLease = input.acquireRuntimeRegistryLease
    ?? acquireAuthoritativePluginRuntimeRegistryLease;

  return createCommittedContributedActionInvoker({
    managedProviderOperationAuthority: input.managedProviderOperationAuthority,
    daemonHoldsApprovalWaiter: true,
    ...(input.observePluginExecution ? { observePluginExecution: input.observePluginExecution } : {}),
    defaultInvocationSurface: 'api',
    acquireRuntimeRegistryLease: () => acquireRuntimeRegistryLease({
      happyHomeDir: configuration.happyHomeDir,
    }),
    ...(input.requestCurrentIntent ? { requestCurrentIntent: input.requestCurrentIntent } : {}),
  });
}

/**
 * Settles target-action approvals at their admitting daemon. Live-only input
 * resumes the incumbent waiter; durable public input re-enters the canonical
 * contributed-Action dispatcher. `approval.request.decide` owns both decisions.
 */
export function createDaemonExternalActionContributedApprovalReplay(input: Readonly<{
  observePluginExecution?: HostActionOperationRuntime['observePluginExecution'];
  prepareApprovalExecutionAuthorization?: NonNullable<ActionExecutorDeps['prepareApprovalExecutionAuthorization']>;
  resolvePreparedApprovalExecutionOriginCurrentness?: (
    authorization: NonNullable<ActionExecutorContext['externalActionExecutionAuthorization']>,
  ) => DaemonApprovalExecutionOriginCurrentness | undefined;
  createFileDownloadPublisher?: (context: ActionExecutorContext) => NonNullable<ActionExecutorContext['prepareFileDownload']>;
  credentials: StoredCredentials;
  isApprovalExecutionOriginCurrent?: DaemonApprovalExecutionOriginCurrentness;
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  targetActionApprovals?: TargetActionApprovalStore;
  readInstallationIdentity?: typeof readInstallationIdentityIfExistsSync;
  now?: () => number;
}>): NonNullable<ActionExecutorDeps['targetActionApprovalReplay']> {
  const acquireRuntimeRegistryLease = input.acquireRuntimeRegistryLease
    ?? acquireAuthoritativePluginRuntimeRegistryLease;
  const targetActionApprovals = input.targetActionApprovals
    ?? createCliApprovalsArtifactStore({ credentials: input.credentials });
  const now = input.now ?? Date.now;
  const readInstallationIdentity = input.readInstallationIdentity
    ?? readInstallationIdentityIfExistsSync;
  const prepareRequesterSource = async (authorization: ActionExecutorContext['externalActionExecutionAuthorization'], signal?: AbortSignal) => {
    if (!authorization || !input.prepareApprovalExecutionAuthorization) return undefined;
    const binding = authorization.binding;
    // This reopening is the ordinary Account path. Delegated HTTP, Session and
    // Workflow sources keep their existing currentness/custody owners.
    if (!('authentication' in binding)
      || (binding.authentication.kind !== 'account' && binding.authentication.kind !== 'terminal')
      || binding.sessionActionOrigin || binding.workflowActionOrigin) return undefined;
    const prepared = await input.prepareApprovalExecutionAuthorization({ authorization, ...(signal ? { signal } : {}) });
    if (!prepared || prepared.authorization.token !== authorization.token
      || !sameStrictJsonValue(prepared.authorization.binding, authorization.binding)) {
      await prepared?.dispose?.();
      return null;
    }
    return prepared;
  };
  const isRequesterSourceCurrent = async (request: TargetActionApprovalRequestV1, signal?: AbortSignal): Promise<boolean> => {
    const projected = projectTargetApprovalRequest(request);
    if (!projected) return false;
    const prepared = await prepareRequesterSource(projected.executionOriginV1.externalActionExecutionAuthorization, signal);
    if (prepared === null) return false;
    try {
      const currentness = prepared ? input.resolvePreparedApprovalExecutionOriginCurrentness?.(prepared.authorization)
        : input.isApprovalExecutionOriginCurrent;
      return currentness !== undefined && await currentness({ origin: projected.executionOriginV1, request: projected,
        ...(signal ? { signal } : {}) });
    } finally { await prepared?.dispose?.(); }
  };
  return createTargetActionApprovalDecision({
    read: artifactId => targetActionApprovals.targetActionApprovalsGet({ artifactId }),
    update: args => targetActionApprovals.targetActionApprovalsUpdate(args),
    now,
    hasLiveInvocation: artifactId => getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId) > 0,
    isRequesterSourceCurrent,
    executeApproved: async ({ artifactId, request, context, signal, persist, nextTimestamp }) => {
      let approved = request;
      const requestedSurface = approved.requestedSurface;
      if ((requestedSurface !== 'api' && requestedSurface !== 'cli' && requestedSurface !== 'agent' && requestedSurface !== 'mcp')
        || approved.replayPlacement === undefined) {
        return targetActionReplayFailure('approval_invalid');
      }
      // The durable placement is stamped once at admission; later status writes
      // below carry it forward unchanged, so it is captured here rather than
      // re-read from a reassigned request.
      const replayPlacement = approved.replayPlacement;
      const action = parseQualifiedPluginActionId(approved.qualifiedActionId);
      if (!action) return targetActionReplayFailure('approval_invalid');
      const origin = approved.executionOriginV1;
      if (!origin) return targetActionReplayFailure('approval_invalid');
      const originalAuthorization = origin.externalActionExecutionAuthorization;
      let preparedSource: Awaited<ReturnType<NonNullable<ActionExecutorDeps['prepareApprovalExecutionAuthorization']>>> | undefined;
      try {
      const sourceBinding = origin.externalActionExecutionAuthorization?.binding;
      const sourceSession = sourceBinding && 'authentication' in sourceBinding ? sourceBinding.sessionActionOrigin : undefined;

      const approvalRequest = projectTargetApprovalRequest(approved);
      if (!approvalRequest) return targetActionReplayFailure('approval_invalid');
      const source: { currentness?: DaemonApprovalExecutionOriginCurrentness } = {};
      const currentness = await classifyApprovalExecutionOriginCurrentness({
        check: async reportStale => {
          preparedSource = await prepareRequesterSource(originalAuthorization, signal);
          if (preparedSource === null) { reportStale('credential_changed'); return false; }
          source.currentness = preparedSource
            ? input.resolvePreparedApprovalExecutionOriginCurrentness?.(preparedSource.authorization)
            : input.isApprovalExecutionOriginCurrent;
          return source.currentness ? await source.currentness({
              origin,
              request: approvalRequest,
              reportStale,
              ...(signal ? { signal } : {}),
            })
          : (reportStale('currentness_owner_unavailable'), false);
        },
      });
      if (currentness.status === 'requester_home_unavailable') {
        return targetActionReplayFailure('project_requester_home_unavailable');
      }
      if (currentness.status === 'read_failed') {
        return targetActionReplayFailure(currentness.failure.errorCode, currentness.failure.error);
      }
      if (currentness.status === 'stale') {
        logger.debug('[RPC] Contributed approval origin is stale', {
          code: 'approval_stale',
          reason: currentness.reason,
        });
        const executedAtMs = nextTimestamp(approved);
        const terminal: TargetActionApprovalRequestV1 = {
          ...approved,
          status: 'failed',
          updatedAtMs: executedAtMs,
          execution: {
            executedAtMs,
            ok: false,
            errorCode: 'approval_stale',
            error: 'approval_stale',
          },
        };
        const persistenceFailure = await persist(terminal);
        return persistenceFailure ?? targetActionReplayFailure('approval_stale');
      }
      const sourceCurrentness = source.currentness;
      if (!sourceCurrentness) return targetActionReplayFailure('approval_stale');

      const executionClaim: TargetActionApprovalRequestV1 = {
        ...approved,
        status: 'executing',
        updatedAtMs: nextTimestamp(approved),
      };
      const claimFailure = await persist(executionClaim);
      if (claimFailure) {
        let persisted: TargetActionApprovalRequestV1 | null;
        try {
          persisted = await targetActionApprovals.targetActionApprovalsGet({ artifactId });
        } catch (error) {
          return recordFailureCause(error, 'target_action.approval.replay_read', targetActionReplayFailure('approval_unavailable'));
        }
        if (persisted && (persisted.status === 'executed' || persisted.status === 'failed' || persisted.status === 'outcome_unknown')
          && persisted.decision?.kind === 'approve') {
          return buildTargetActionApprovalDecisionResult(persisted);
        }
        if (persisted?.status === 'executing' && persisted.decision?.kind === 'approve') {
          return targetActionReplayFailure('approval_execution_outcome_unknown');
        }
        return claimFailure;
      }
      approved = executionClaim;

      const operationCredentialUses: ActionOperationCredentialUseV1[] = [];
      let observingCredentialUse = true;
      const recordOperationCredentialUse = (use: ActionOperationCredentialUseV1) => {
        if (!observingCredentialUse) return;
        const parsed = ActionOperationCredentialUseV1Schema.safeParse(use);
        if (!parsed.success || operationCredentialUses.some(existing => sameStrictJsonValue(existing, parsed.data))) return;
        operationCredentialUses.push(parsed.data);
        context?.recordOperationCredentialUse?.(parsed.data);
      };
      let executionResult: ActionExecuteResult | undefined;
      let externalActionContext: PluginExternalActionContext | undefined;
      if (executionResult === undefined && origin.externalActionExecutionAuthorization !== undefined) {
        const installationIdentity = readInstallationIdentity();
        if (
          !installationIdentity
          || !origin.serverIdentityId
          || !origin.accountId
          || ('grant' in origin.externalActionExecutionAuthorization.binding && (!origin.principalId || !origin.credentialId))
          || !origin.target
        ) {
          executionResult = targetActionReplayFailure('approval_stale');
        } else {
          const authorization = preparedSource?.authorization ?? origin.externalActionExecutionAuthorization;
          const externalActionCredential = 'grant' in authorization.binding && origin.principalId && origin.credentialId ? Object.freeze({
            accountId: origin.accountId,
            principalId: origin.principalId,
            credentialId: origin.credentialId,
            grant: authorization.binding.grant,
          }) : undefined;
          // The canonical prepared carrier is immutable and owns non-enumerable
          // requester ports. Spreading it would silently discard that custody.
          const externalActionExecutionAuthorization = authorization;
          const externalActionTarget = Object.freeze({ ...origin.target });
          externalActionContext = Object.freeze<PluginExternalActionContext>({
            authority: 'account_automation',
            serverId: origin.serverId,
            serverIdentityId: origin.serverIdentityId,
            actionRequestId: origin.requestId,
            ...(externalActionCredential ? { externalActionCredential } : {}),
            externalActionExecutionAuthorization,
            externalActionTarget,
            signExternalActionApprovalInput: ({ actionId, input: actionInput, target, requesterConfirmation, sessionTargetsV1 }) =>
              signExternalActionApprovalInputV1({
                authorizationToken: externalActionExecutionAuthorization.token,
                actionId,
                target,
                input: actionInput,
                privateKey: installationIdentity.privateKey,
                ...(requesterConfirmation ? { requesterConfirmation } : {}),
                ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}),
              }),
          });
        }
      }
      const invocationSignal = signal ?? new AbortController().signal;
      if (executionResult === undefined) {
        try {
          invocationSignal.throwIfAborted();
          const lease = await acquireRuntimeRegistryLease({
            happyHomeDir: configuration.happyHomeDir,
          });
          try {
            invocationSignal.throwIfAborted();
            const replayContext: Omit<ActionExecutorContext, 'hostReviewedChild'> & {
              hostReviewedChild?: ActionExecutorContext['hostReviewedChild'];
            } = { authority: origin.authority, runtimeAccountId: origin.accountId,
              recordOperationCredentialUse,
              serverId: origin.serverId,
              serverIdentityId: origin.serverIdentityId,
              ...(replayPlacement.defaultSessionId === undefined ? {} : { defaultSessionId: replayPlacement.defaultSessionId }),
              actionRequestAttributionV1: origin.actionRequestAttributionV1,
              actionCaller: origin.caller,
              callerPermissionMode: origin.callerPermissionMode,
              causalPermissionAuthority: origin.causalPermissionAuthority,
              sessionTargetsV1: origin.sessionTargetsV1,
              sessionInputSource: origin.sessionInputSource,
              sessionAgentSpawnPolicyV1: origin.sessionAgentSpawnPolicyV1,
              workspaceWrites: sourceSession?.workspaceWrites,
              ...(externalActionContext ?? {}),
            };
            replayContext.hostReviewedChild = createHostReviewedChildPortV1({
              actionId: 'action.invoke', input: { action, input: approved.input }, context: replayContext, reviewAdmitted: true,
            });
            const attempt = await executeContributedAction({
              runtimeRegistry: lease.registry,
              actionId: buildQualifiedPluginContributionKey(action),
              input: approved.input,
              expectedApprovalReplayPlacement: replayPlacement,
              approvalContext: { ...replayContext,
                ...(input.createFileDownloadPublisher ? { prepareFileDownload: input.createFileDownloadPublisher(replayContext) } : {}),
              },
              approvalExecutionOrigin: origin,
              context: {
                ...(input.observePluginExecution ? { observePluginExecution: input.observePluginExecution } : {}),
                surface: requestedSurface,
                invocationSurface: requestedSurface,
                initiatingActionCaller: origin.caller,
                ...(externalActionContext ? { externalActionContext } : {}),
                ...(replayPlacement.defaultSessionId === undefined
                  ? {}
                  : { defaultSessionId: replayPlacement.defaultSessionId }),
                signal: invocationSignal,
              },
            });
            if (!attempt.matched) {
              executionResult = targetActionReplayFailure('contributed_action_unavailable');
            } else {
              executionResult = attempt.result.ok || attempt.result.details !== undefined
                ? attempt.result : projectContributedActionFailure(attempt.result);
            }
          } finally {
            await lease.release();
          }
        } catch (error) {
          const failure = readPluginActionError(error);
          const failureCode = failure ? failure.code : 'plugin_action_execution_failed';
          executionResult = failure ? projectContributedActionFailure({
            errorCode: failure.code,
            error: projectPluginFailureMessage(failure.message),
            ...(failure.data === undefined ? {} : {
              data: redactPluginInvocationResultData(failure.data, projectPluginFailureMessage),
            }),
          }) : targetActionReplayFailure('plugin_action_execution_failed');
          logger.warnLocalFile('[ExternalAction] Approved contributed Action replay failed', { code: failureCode,
            failureCause: projectActionFailureCauseV1(error, 'external_action.approved_replay', { allowUnknownErrorCode: false }) });
        }
      }
      observingCredentialUse = false;

      return await settleTargetActionExecution({ request: approved, result: executionResult,
        operationCredentialUses, persist, executedAtMs: nextTimestamp(approved) });
      } finally { await preparedSource?.dispose?.(); }
    },
  });
}

/**
 * Reads the current committed runtime's contributed Action declarations for
 * the canonical `action.spec.search` and `action.spec.get` owner. The lease
 * is released after the immutable declaration snapshot is copied; execution
 * keeps its own currentness checks through the committed invoker above.
 */
export function createDaemonExternalActionContributedDefinitionLister(input: Readonly<{
  tryAcquireRuntimeRegistryLease?: typeof tryAcquireAuthoritativePluginRuntimeRegistryLease;
}> = {}): NonNullable<ActionExecutorDeps['listContributedActionDefinitions']> {
  const tryAcquireRuntimeRegistryLease = input.tryAcquireRuntimeRegistryLease
    ?? tryAcquireAuthoritativePluginRuntimeRegistryLease;

  return createCommittedContributedActionDefinitionLister({
    tryAcquireRuntimeRegistryLease: () => tryAcquireRuntimeRegistryLease({
      happyHomeDir: configuration.happyHomeDir,
    }),
    onLeaseReleaseError: () => logger.debug(
      '[ExternalAction] Contributed Action discovery registry lease release failed (non-fatal)',
      { error: 'external_action_catalog_registry_lease_release_failed' },
    ),
  });
}
