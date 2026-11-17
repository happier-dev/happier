import type { TargetActionApprovalRequestV1 } from '../approvals/targetActionApprovalRequestV1.js';
import { projectTargetActionApprovalInvocationV1, TargetActionApprovalRequestV1Schema } from '../approvals/targetActionApprovalRequestV1.js';
import { admitApprovalRequesterDecisionV1 } from '../approvals/approvalRequestV1.js';
import { isApiTokenGrantTargetMemberV1 } from '../auth/apiTokenGrant.js';
import { withActionAutomationNoticesV1, type ActionExecuteResult } from './actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './executor/types.js';
import { resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import { getSharedBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';
import { deriveActionActorV1 } from './actionRequestAttributionV1.js';
import { readRpcErrorCode } from '../rpc/errors.js';
import { readRecord } from '../inputs/inputRecords.js';
import { ApprovalStaleFailureDetailsSchema, buildApprovalOriginFailure } from '../approvals/approvalStaleReason.js';
import { resolveApprovalExecutor } from '../approvals/resolveApprovalExecutor.js';
import { createApprovalAutomaticContinuationV1, answerApprovalAutomaticConsentV1, restoreApprovalAutomaticContextV1 } from './executor/automaticApprovalContinuation.js';
import type { ApprovalAutomaticContinuationV1 } from './executor/automaticApprovalContinuation.js';
import { readApprovalExecutionFailure } from '../approvals/approvalExecutionFailure.js';
import type { ActionAutomationPortV1 } from './executor/actionAutomationAdmission.js';
import { isApprovalRequestExecutionApproved } from '../approvals/approvalAutomaticChecks.js';

/** The existing target Artifact uses the same pending engine as built-in Actions. */
export function createTargetActionAutomaticContinuationV1(deps: Readonly<{
  actionAutomations?: ActionAutomationPortV1;
  read(artifactId: string): Promise<TargetActionApprovalRequestV1 | null>;
  update(args: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1; context?: ActionExecutorContext }>): Promise<TargetActionApprovalUpdateResult>;
}>): ApprovalAutomaticContinuationV1<TargetActionApprovalRequestV1> {
  return createApprovalAutomaticContinuationV1<TargetActionApprovalRequestV1, TargetActionApprovalRequestV1>({
    actionAutomations: deps.actionAutomations,
    parse: input => TargetActionApprovalRequestV1Schema.parse(input),
    invocation: request => ({ actionId: request.qualifiedActionId, input: request.input }),
    read: artifactId => deps.read(artifactId),
    write: async (artifactId, request, context) => {
      const updated = await deps.update({ artifactId, request, context });
      return updated.ok ? null : { ok: false, errorCode: updated.errorCode, error: updated.error ?? updated.errorCode };
    },
    refusal: (request, updatedAtMs, automaticChecks, refused) => TargetActionApprovalRequestV1Schema.parse({
      ...request, status: 'failed', updatedAtMs, automaticChecks,
      execution: { executedAtMs: updatedAtMs, ...refused },
    }),
    readFailure: readApprovalExecutionFailure,
  });
}

export type TargetActionApprovalUpdateResult = Readonly<
  { ok: true } | { ok: false; errorCode: string; error?: string }
>;

export function buildTargetActionApprovalDecisionResult(request: TargetActionApprovalRequestV1): ActionExecuteResult {
  const withNotices = (result: ActionExecuteResult) => withActionAutomationNoticesV1(result, request.automaticChecks?.notices);
  if (request.status === 'outcome_unknown') return withNotices(failure('approval_execution_outcome_unknown'));
  if (resolveApprovalExecutor(request).kind === 'live_invocation' && request.execution?.effectAttempted === false
    && request.execution.errorCode === 'approval_origin_unavailable') {
    const details = ApprovalStaleFailureDetailsSchema.safeParse(request.execution.details);
    if (details.success && details.data.reason === 'live_invocation_unavailable') {
      return withNotices(buildApprovalOriginFailure(details.data.reason));
    }
  }
  return withNotices({ ok: true, result: { ok: true, status: request.status,
    ...(request.execution === undefined ? {} : { execution: request.execution }) } });
}

function failure(errorCode: string, error = errorCode): ActionExecuteResult {
  return { ok: false, errorCode, error };
}

/** One target-Action decision owner; host adapters supply Artifact custody and durable execution. */
export function createTargetActionApprovalDecision(deps: Readonly<{
  actionAutomations?: ActionAutomationPortV1;
  read: (artifactId: string, initialRead?: Readonly<{ request: unknown }>) => Promise<TargetActionApprovalRequestV1 | null>;
  update: (args: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1; context?: ActionExecutorContext }>) => Promise<TargetActionApprovalUpdateResult>;
  now?: () => number;
  /** Only the original execution host can make a process-local liveness assertion. */
  hasLiveInvocation?: (artifactId: string) => boolean;
  isRequesterSourceCurrent?: (request: TargetActionApprovalRequestV1, signal?: AbortSignal) => Promise<boolean>;
  executeApproved?: (args: Readonly<{
    artifactId: string;
    request: TargetActionApprovalRequestV1;
    context?: ActionExecutorContext;
    signal?: AbortSignal;
    persist: (request: TargetActionApprovalRequestV1) => Promise<ActionExecuteResult | null>;
    nextTimestamp: (request: TargetActionApprovalRequestV1) => number;
  }>) => Promise<ActionExecuteResult>;
}>): NonNullable<ActionExecutorDeps['targetActionApprovalReplay']> {
  return async ({ artifactId: rawArtifactId, decision, triggerConsent, initialRead, context, callerGrant, signal }) => {
    const actionAutomations = deps.actionAutomations ?? context?.actionAutomationPort;
    const automatic = createTargetActionAutomaticContinuationV1({ ...deps, actionAutomations });
    const artifactId = rawArtifactId.trim();
    if (!artifactId) return null;
    signal?.throwIfAborted();
    let existing: TargetActionApprovalRequestV1 | null;
    // Only the initial family probe may borrow the host's admitted body.
    // Consent readback below still acquires the persisted decision independently.
    try { existing = await deps.read(artifactId, initialRead); }
    catch { return failure('approval_context_unavailable'); }
    // Ordinary approval Artifacts remain with the generic Action owner.
    if (!existing) return null;
    const originalInvocation = projectTargetActionApprovalInvocationV1(existing);
    if (!originalInvocation) return failure('approval_invalid');
    const requesterAdmission = await admitApprovalRequesterDecisionV1({
      request: { ...existing, ...originalInvocation }, context: context ?? {},
    });
    if (!requesterAdmission.ok) return requesterAdmission;
    const isRequesterSourceCurrent = async (request: TargetActionApprovalRequestV1) =>
      deps.isRequesterSourceCurrent !== undefined
        && await deps.isRequesterSourceCurrent(request, signal).catch(() => false);
    if (existing.requesterConfirmation && !['executed', 'failed', 'outcome_unknown', 'rejected', 'canceled'].includes(existing.status)
      && !await isRequesterSourceCurrent(existing)) return failure('approval_stale');
    const decidingActor = deriveActionActorV1(context ?? {}, 'approval.request.decide');
    const decidingAccountId = decidingActor?.actorKind === 'person' ? decidingActor.accountId : undefined;
    const decisionAttribution = {
      ...(context?.authority === 'present_user' && decidingActor?.actorKind === 'person' ? {
        authority: 'present_user' as const,
        ...(decidingAccountId ? { decidingAccountId } : {}),
        ...(context.surface === 'voice' ? { decidedVia: 'voice' as const } : {}),
      } : {}),
      ...(existing.requesterConfirmation ? {
        authority: 'present_user' as const, decidingAccountId: existing.requesterConfirmation.requesterAccountId,
        ...(context?.requesterApprovalDecision?.decisionSource === 'voice' ? { decidedVia: 'voice' as const } : {}),
      } : {}),
    };
    const executor = resolveApprovalExecutor(existing);
    if (executor.kind !== 'daemon' && executor.kind !== 'live_invocation') return failure('approval_invalid');
    const origin = existing.executionOriginV1;
    const target = origin?.target
      ?? (origin?.sessionId ? { kind: 'session' as const, sessionId: origin.sessionId } : null)
      ?? (origin?.machineId ? { kind: 'machine' as const, machineId: origin.machineId } : null);
    const decisionTarget = target ?? (executor.kind === 'daemon'
      ? executor.sessionId ? { kind: 'session' as const, sessionId: executor.sessionId }
        : { kind: 'machine' as const, machineId: executor.machineId } : null);
    if (callerGrant && !isApiTokenGrantTargetMemberV1(callerGrant, decisionTarget,
      origin?.machineId ?? (executor.kind === 'daemon' ? executor.machineId : existing.replayPlacement?.machineId))) return failure('credential_scope_denied');
    if (existing.status === 'outcome_unknown') return failure('approval_execution_outcome_unknown');
    const nextTimestamp = (request: TargetActionApprovalRequestV1) => Math.max((deps.now ?? Date.now)(), request.updatedAtMs);
    const persist = async (request: TargetActionApprovalRequestV1, revalidateDecision = false): Promise<ActionExecuteResult | null> => {
      try {
        // Consent writes recheck delegation; execution receipts retain already
        // committed consent even when the person has since opted out.
        const updated = await deps.update({ artifactId, request, ...(revalidateDecision && context ? { context } : {}) });
        return updated.ok ? null : failure(updated.errorCode, updated.error);
      } catch (error) {
        const code = readRpcErrorCode(error) ?? readRecord(error).code;
        return failure(code === 'present_user_required' ? code : 'approval_update_failed');
      }
    };
    const coordinator = getSharedBlockingApprovalCoordinator();
    const executionContext = (request: TargetActionApprovalRequestV1) =>
      restoreApprovalAutomaticContextV1(request, request.qualifiedActionId, context ?? {}, actionAutomations);
    if (decision === 'cancel') {
      if (existing.status === 'canceled') return buildTargetActionApprovalDecisionResult(existing);
      if (existing.status === 'failed' && existing.execution?.errorCode === 'approval_canceled'
        && existing.execution.effectAttempted === false) return buildTargetActionApprovalDecisionResult(existing);
      if (existing.status === 'approved' && isApprovalRequestExecutionApproved(existing) && !existing.execution) {
        const canceledAtMs = nextTimestamp(existing);
        const failed: TargetActionApprovalRequestV1 = { ...existing, status: 'failed', updatedAtMs: canceledAtMs,
          execution: { executedAtMs: canceledAtMs, ok: false, effectAttempted: false,
            errorCode: 'approval_canceled', error: 'approval_canceled' } };
        const persistenceFailure = await persist(failed, true);
        if (!persistenceFailure) coordinator.notifyApprovalUpdated({ artifactId, request: failed });
        return persistenceFailure ?? buildTargetActionApprovalDecisionResult(failed);
      }
      if (existing.status !== 'open') return failure('approval_not_open');
      const canceled: TargetActionApprovalRequestV1 = { ...existing, status: 'canceled', updatedAtMs: nextTimestamp(existing) };
      const persistenceFailure = await persist(canceled, true);
      if (!persistenceFailure) await automatic.cancel(canceled, executionContext(canceled));
      if (!persistenceFailure) coordinator.notifyApprovalUpdated({ artifactId, request: canceled });
      return persistenceFailure ?? buildTargetActionApprovalDecisionResult(canceled);
    }
    if (decision === 'reject') {
      if (existing.status === 'rejected' && existing.decision?.kind === 'reject') return buildTargetActionApprovalDecisionResult(existing);
      if (existing.status !== 'open') return failure('approval_not_open');
      const rejected: TargetActionApprovalRequestV1 = { ...existing, status: 'rejected', updatedAtMs: nextTimestamp(existing),
        decision: { kind: 'reject', decidedAtMs: nextTimestamp(existing), ...decisionAttribution } };
      const persistenceFailure = await persist(rejected, true);
      if (!persistenceFailure) await automatic.cancel(rejected, executionContext(rejected));
      if (!persistenceFailure) coordinator.notifyApprovalUpdated({ artifactId, request: rejected });
      return persistenceFailure ?? buildTargetActionApprovalDecisionResult(rejected);
    }
    if (existing.status === 'open' && existing.automaticChecks) {
      const checks = existing.automaticChecks;
      const now = nextTimestamp(existing);
      if (checks.phase === 'consent') {
        let nextChecks = checks;
        if (triggerConsent) {
          const answered = await answerApprovalAutomaticConsentV1({ artifactId, checks, answer: triggerConsent,
            context: context ?? {}, executionContext: executionContext(existing), port: actionAutomations });
          if ('ok' in answered) return answered;
          nextChecks = answered;
        } else if (checks.humanApprovalRequired && !checks.humanDecision) {
          nextChecks = { ...checks, humanDecision: { kind: 'approve', decidedAtMs: now, ...decisionAttribution } };
        } else return failure('invalid_parameters');
        const admitted = await automatic.admit(artifactId, { ...existing, updatedAtMs: now, automaticChecks: nextChecks }, executionContext(existing));
        if ('ok' in admitted) return admitted;
        const writeFailure = await automatic.write(artifactId, admitted, context ?? {});
        if (writeFailure) return writeFailure;
        existing = admitted;
      } else if (checks.phase === 'override') {
        if (triggerConsent) return failure('invalid_parameters');
        existing = TargetActionApprovalRequestV1Schema.parse({ ...existing, status: 'approved', updatedAtMs: now,
          decision: { kind: 'approve', decidedAtMs: now, ...decisionAttribution }, automaticChecks: { ...checks, phase: 'passed' } });
        const writeFailure = await automatic.write(artifactId, existing, context ?? {});
        if (writeFailure) return writeFailure;
      }
      const resumed = await automatic.resume(artifactId, existing, executionContext(existing));
      if ('ok' in resumed) return resumed;
      if (resumed.kind === 'refused') return resumed.failure;
      existing = resumed.request;
      if (resumed.kind === 'pending') return buildTargetActionApprovalDecisionResult(existing);
      coordinator.notifyApprovalUpdated({ artifactId, request: existing });
    }
    if (existing.status === 'failed' && existing.automaticChecks?.phase === 'refused') return readApprovalExecutionFailure(existing);
    if ((existing.status === 'executed' || existing.status === 'failed') && isApprovalRequestExecutionApproved(existing)) {
      return buildTargetActionApprovalDecisionResult(existing);
    }
    const liveInputsUnavailable = executor.kind === 'live_invocation'
      && deps.hasLiveInvocation !== undefined && !deps.hasLiveInvocation(artifactId);
    if (existing.status === 'executing' && isApprovalRequestExecutionApproved(existing)) return failure('approval_execution_outcome_unknown');
    if (existing.status !== 'open' && (existing.status !== 'approved' || !isApprovalRequestExecutionApproved(existing))) return failure('approval_not_open');
    if (resolveApprovalRequestApproveAdmission(existing).status !== 'available') return failure('approval_context_unavailable');
    let approved = existing;
    if (existing.status === 'open') {
      const approvedAtMs = nextTimestamp(existing);
      const persistenceFailure = await persist({ ...existing, status: 'approved', updatedAtMs: approvedAtMs,
        decision: { kind: 'approve', decidedAtMs: approvedAtMs, ...decisionAttribution } }, true);
      let persisted: TargetActionApprovalRequestV1 | null;
      try { persisted = await deps.read(artifactId); }
      // Consent may already be committed. Keep the Artifact recoverable; a
      // later replay reuses this decision and claims execution before effects.
      catch { return failure('approval_context_unavailable'); }
      if (!persisted) return persistenceFailure ?? failure('approval_not_found');
      // Account change delivery can resume the original invocation before the
      // decision write returns. Its claim confirms consent without replay.
      if (resolveApprovalExecutor(persisted).kind === 'live_invocation' && persisted.status === 'executing'
        && persisted.decision?.kind === 'approve') return buildTargetActionApprovalDecisionResult(persisted);
      if ((persisted.status === 'executed' || persisted.status === 'failed' || persisted.status === 'outcome_unknown') && persisted.decision?.kind === 'approve') {
        return buildTargetActionApprovalDecisionResult(persisted);
      }
      if (persisted.status !== 'approved' || persisted.decision?.kind !== 'approve') return persistenceFailure ?? failure('approval_not_open');
      approved = persisted;
    }
    if (resolveApprovalExecutor(approved).kind === 'live_invocation') {
      const settleUnavailable = async () => {
        const failedAtMs = nextTimestamp(approved);
        const failed: TargetActionApprovalRequestV1 = { ...approved, status: 'failed', updatedAtMs: failedAtMs,
          execution: { executedAtMs: failedAtMs, ...buildApprovalOriginFailure('live_invocation_unavailable'), effectAttempted: false } };
        const persistenceFailure = await persist(failed);
        if (!persistenceFailure) coordinator.notifyApprovalUpdated({ artifactId, request: failed });
        return persistenceFailure ?? buildTargetActionApprovalDecisionResult(failed);
      };
      if (liveInputsUnavailable) return await settleUnavailable();
      // Only this admitted decision releases the original invocation. The
      // Artifact feed supplies observations, never a live approval witness.
      const proof = context?.requesterApprovalDecision;
      const delivery = await coordinator.resolveBlockingDecision({ artifactId, request: approved, decision: 'approve', decisionAuthority: context?.authority ?? 'account_automation',
        ...(proof ? { requesterApprovalDecision: { ...proof,
          isCurrent: async () => await proof.isCurrent() && await isRequesterSourceCurrent(approved) } } : {}) });
      // Persisted consent cannot wake a different process's private waiter.
      // Reuse the existing no-effect refusal when no live decision was delivered.
      return delivery.resolved ? buildTargetActionApprovalDecisionResult(approved) : await settleUnavailable();
    }
    return deps.executeApproved ? await deps.executeApproved({ artifactId, request: approved, persist, nextTimestamp,
      ...(context ? { context } : {}), ...(signal ? { signal } : {}) }) : failure('approval_origin_unavailable');
  };
}
