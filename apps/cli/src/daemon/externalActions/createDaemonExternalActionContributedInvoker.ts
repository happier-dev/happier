import { isApiTokenGrantTargetMemberV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { ApiTokenGrantV1, ApprovalRequestV2, TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ActionExecuteResult, ActionExecutorDeps } from '@happier-dev/protocol/actions';

import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import {
  executeContributedAction,
} from '@/plugins/runtime/invocation/actions/executeContributedAction';
import {
  createCommittedContributedActionDefinitionLister,
  createCommittedContributedActionInvoker,
} from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { targetActionApprovalMatchesCurrentIntent } from '@/session/actions/approvals/targetActionCurrentIntent';
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

type TargetActionApprovalStore = Pick<
  ReturnType<typeof createCliApprovalsArtifactStore>,
  'targetActionApprovalsGet' | 'targetActionApprovalsUpdate'
>;

function buildTargetActionApprovalDecisionResult(
  request: TargetActionApprovalRequestV1,
): ActionExecuteResult {
  return {
    ok: true,
    result: {
      ok: true,
      status: request.status,
      ...(request.execution === undefined ? {} : { execution: request.execution }),
    },
  };
}

function targetActionReplayFailure(
  errorCode: string,
  error = errorCode,
): ActionExecuteResult {
  return { ok: false, errorCode, error };
}

/**
 * Adapts the public host Action `action.invoke` to the one committed-runtime
 * contributed-Action dispatcher. This adapter translates the public typed
 * contribution identity to the registry's canonical internal key; API caller
 * provenance remains host-owned and is deliberately not fabricated as a
 * plugin caller.
 */
export function createDaemonExternalActionContributedInvoker(input: Readonly<{
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  requestCurrentIntent?: (
    request: TargetActionCurrentIntentRequest,
  ) => Promise<TargetActionCurrentIntentResult>;
}> = {}): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
  const acquireRuntimeRegistryLease = input.acquireRuntimeRegistryLease
    ?? acquireAuthoritativePluginRuntimeRegistryLease;

  return createCommittedContributedActionInvoker({
    fixedInvocationSurface: 'api',
    captureApprovalReplayPlacement: true,
    acquireRuntimeRegistryLease: () => acquireRuntimeRegistryLease({
      happyHomeDir: configuration.happyHomeDir,
    }),
    ...(input.requestCurrentIntent ? { requestCurrentIntent: input.requestCurrentIntent } : {}),
  });
}

/**
 * Claims only strict API target-action approval artifacts at the daemon that
 * stamped their durable placement. The generic `approval.request.decide`
 * Action remains the public decision owner; this bridge only rehydrates its
 * target artifact and re-enters the canonical contributed-Action dispatcher.
 */
export function createDaemonExternalActionContributedApprovalReplay(input: Readonly<{
  credentials: StoredCredentials;
  isApprovalExecutionOriginCurrent?: NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>;
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
  const replayArtifact = async ({
    artifactId,
    decision,
    signal,
    callerGrant,
  }: Readonly<{
    artifactId: string;
    decision: 'approve' | 'reject';
    signal?: AbortSignal;
    callerGrant?: ApiTokenGrantV1;
  }>): Promise<ActionExecuteResult | null> => {
    let existing: TargetActionApprovalRequestV1 | null;
    try {
      existing = await targetActionApprovals.targetActionApprovalsGet({ artifactId });
    } catch {
      return targetActionReplayFailure('approval_unavailable');
    }
    // This callback deliberately leaves ordinary ApprovalRequestV1 artifacts
    // on the generic Action owner rather than trying to interpret them here.
    if (!existing) return null;
    if (existing.requestedSurface !== 'api' || existing.replayPlacement === undefined) {
      return targetActionReplayFailure('approval_invalid');
    }
    const decisionOrigin = existing.executionOriginV1;
    const target = decisionOrigin?.target
      ?? (decisionOrigin?.sessionId ? { kind: 'session' as const, sessionId: decisionOrigin.sessionId } : null)
      ?? (decisionOrigin?.machineId ? { kind: 'machine' as const, machineId: decisionOrigin.machineId } : null);
    if (callerGrant && !isApiTokenGrantTargetMemberV1(callerGrant, target, decisionOrigin?.machineId)) {
      return targetActionReplayFailure('credential_scope_denied');
    }

    const nextTimestamp = (request: TargetActionApprovalRequestV1): number => (
      Math.max(now(), request.updatedAtMs)
    );
    const persist = async (
      request: TargetActionApprovalRequestV1,
    ): Promise<ActionExecuteResult | null> => {
      try {
        const updated = await targetActionApprovals.targetActionApprovalsUpdate({ artifactId, request });
        return updated.ok ? null : targetActionReplayFailure(updated.errorCode, updated.error);
      } catch {
        return targetActionReplayFailure('approval_update_failed');
      }
    };

    if (decision === 'reject') {
      if (existing.status === 'rejected' && existing.decision?.kind === 'reject') {
        return buildTargetActionApprovalDecisionResult(existing);
      }
      if (existing.status !== 'open') {
        return targetActionReplayFailure('approval_not_open');
      }
      const rejected: TargetActionApprovalRequestV1 = {
        ...existing,
        status: 'rejected',
        updatedAtMs: nextTimestamp(existing),
        decision: { kind: 'reject', decidedAtMs: nextTimestamp(existing) },
      };
      const persistenceFailure = await persist(rejected);
      return persistenceFailure ?? buildTargetActionApprovalDecisionResult(rejected);
    }

    if ((existing.status === 'executed' || existing.status === 'failed')
      && existing.decision?.kind === 'approve') {
      return buildTargetActionApprovalDecisionResult(existing);
    }
    if (existing.status === 'executing' && existing.decision?.kind === 'approve') {
      return targetActionReplayFailure('approval_execution_outcome_unknown');
    }
    if (existing.status !== 'open'
      && (existing.status !== 'approved' || existing.decision?.kind !== 'approve')) {
      return targetActionReplayFailure('approval_not_open');
    }

    let approved = existing;
    if (existing.status === 'open') {
      const approvedAtMs = nextTimestamp(existing);
      const nextApproved: TargetActionApprovalRequestV1 = {
        ...existing,
        status: 'approved',
        updatedAtMs: approvedAtMs,
        decision: { kind: 'approve', decidedAtMs: approvedAtMs },
      };
      // A lost or conflicting decision write is reconciled from the durable
      // row rather than assumed: another decider may already have committed
      // the same approval, or carried it through to a terminal outcome.
      const persistenceFailure = await persist(nextApproved);
      let persisted: TargetActionApprovalRequestV1 | null;
      try {
        persisted = await targetActionApprovals.targetActionApprovalsGet({ artifactId });
      } catch {
        return targetActionReplayFailure('approval_unavailable');
      }
      if (!persisted) {
        return persistenceFailure ?? targetActionReplayFailure('approval_not_found');
      }
      if ((persisted.status === 'executed' || persisted.status === 'failed')
        && persisted.decision?.kind === 'approve') {
        return buildTargetActionApprovalDecisionResult(persisted);
      }
      if (persisted.status !== 'approved' || persisted.decision?.kind !== 'approve') {
        return persistenceFailure ?? targetActionReplayFailure('approval_not_open');
      }
      approved = persisted;
    }
    if (approved.requestedSurface !== 'api' || approved.replayPlacement === undefined) {
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
      } catch {
        return targetActionReplayFailure('approval_unavailable');
      }
      if (persisted && (persisted.status === 'executed' || persisted.status === 'failed')
        && persisted.decision?.kind === 'approve') {
        return buildTargetActionApprovalDecisionResult(persisted);
      }
      if (persisted?.status === 'executing' && persisted.decision?.kind === 'approve') {
        return targetActionReplayFailure('approval_execution_outcome_unknown');
      }
      return claimFailure;
    }
    approved = executionClaim;

    const approvalRequest: ApprovalRequestV2 = {
      v: 2,
      status: approved.status,
      createdAtMs: approved.createdAtMs,
      updatedAtMs: approved.updatedAtMs,
      createdBy: approved.createdBy,
      requestedSurface: 'api',
      executionOriginV1: origin,
      actionId: 'action.invoke',
      actionArgs: {
        action: {
          pluginId: action.pluginId,
          localId: action.localId,
        },
        input: approved.input,
      },
      summary: approved.summary,
      ...(approved.detail ? { preview: { detail: approved.detail } } : {}),
      ...(approved.decision ? { decision: approved.decision } : {}),
    };
    const originCurrent = input.isApprovalExecutionOriginCurrent
      ? await input.isApprovalExecutionOriginCurrent({
      origin,
      request: approvalRequest,
      ...(signal ? { signal } : {}),
        }).catch(() => false)
      : false;
    let executionResult: ActionExecuteResult | undefined = originCurrent
      ? undefined
      : targetActionReplayFailure('approval_stale');
    let externalActionContext: PluginExternalActionContext | undefined;
    if (executionResult === undefined && origin.externalActionExecutionAuthorization !== undefined) {
      const installationIdentity = readInstallationIdentity();
      if (
        !installationIdentity
        || !origin.serverIdentityId
        || !origin.accountId
        || !origin.principalId
        || !origin.credentialId
        || !origin.target
        || !('grant' in origin.externalActionExecutionAuthorization.binding)
      ) {
        executionResult = targetActionReplayFailure('approval_stale');
      } else {
        const authorization = origin.externalActionExecutionAuthorization;
        const externalActionCredential = Object.freeze({
          accountId: origin.accountId,
          principalId: origin.principalId,
          credentialId: origin.credentialId,
          grant: authorization.binding.grant,
        });
        const authorizedTarget = Object.freeze({ ...authorization.binding.target });
        const externalActionExecutionAuthorization = Object.freeze({
          ...authorization,
          binding: Object.freeze({
            ...authorization.binding,
            target: authorizedTarget,
          }),
        });
        const externalActionTarget = Object.freeze({ ...origin.target });
        externalActionContext = Object.freeze<PluginExternalActionContext>({
          authority: 'account_automation',
          serverId: origin.serverId,
          serverIdentityId: origin.serverIdentityId,
          actionRequestId: origin.requestId,
          externalActionCredential,
          externalActionExecutionAuthorization,
          externalActionTarget,
          signExternalActionApprovalInput: ({ actionId, input: actionInput, target }) =>
            signExternalActionApprovalInputV1({
              authorizationToken: externalActionExecutionAuthorization.token,
              actionId,
              target,
              input: actionInput,
              privateKey: installationIdentity.privateKey,
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
          const attempt = await executeContributedAction({
            runtimeRegistry: lease.registry,
            actionId: buildQualifiedPluginContributionKey(action),
            input: approved.input,
            expectedApprovalReplayPlacement: replayPlacement,
            requestCurrentIntent: async (currentIntent) => (
              targetActionApprovalMatchesCurrentIntent(approved, {
                ...currentIntent,
                executionOriginV1: origin,
              })
                ? { status: 'approved', fingerprint: currentIntent.fingerprint }
                : { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' }
            ),
            context: {
              surface: 'api',
              invocationSurface: 'api',
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
          } else if (attempt.result.ok && attempt.result.deferredApprovalArtifactId !== undefined) {
            executionResult = targetActionReplayFailure('plugin_action_current_intent_mismatch');
          } else {
            executionResult = attempt.result;
          }
        } finally {
          await lease.release();
        }
      } catch {
        executionResult = targetActionReplayFailure('plugin_action_execution_failed');
      }
    }

    const executedAtMs = nextTimestamp(approved);
    const terminal: TargetActionApprovalRequestV1 = executionResult.ok
      ? {
          ...approved,
          status: 'executed',
          updatedAtMs: executedAtMs,
          execution: { executedAtMs, ok: true, result: executionResult.result },
        }
      : {
          ...approved,
          status: 'failed',
          updatedAtMs: executedAtMs,
          execution: {
            executedAtMs,
            ok: false,
            errorCode: executionResult.errorCode,
            error: executionResult.error,
          },
        };
    const persistenceFailure = await persist(terminal);
    // Once the durable claim is admitted, a lost terminal write leaves later
    // callers unable to distinguish an in-flight effect from an unknown one.
    if (persistenceFailure) return targetActionReplayFailure('approval_execution_outcome_unknown');
    return executionResult.ok
      ? buildTargetActionApprovalDecisionResult(terminal)
      : executionResult;
  };

  return async ({ artifactId: rawArtifactId, decision, signal, callerGrant }) => {
    const artifactId = rawArtifactId.trim();
    if (!artifactId) return null;
    signal?.throwIfAborted();
    return await replayArtifact({ artifactId, decision, ...(signal ? { signal } : {}), ...(callerGrant ? { callerGrant } : {}) });
  };
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
