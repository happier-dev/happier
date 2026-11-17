import type { ApprovalRequestV2, StoredApprovalRequestV2 } from '../../approvals/approvalRequestV1.js';
import { ApprovalRequestV2Schema } from '../../approvals/approvalRequestV1.js';
import { ApprovalAutomaticChecksV1Schema, actionAutomationTriggerKeyV1, type ActionAutomationResultV1, type ApprovalAutomaticChecksV1 } from '../../approvals/approvalAutomaticChecks.js';
import { settleApprovalRequestReplayInputs, resolveApprovalRequestExecutionInput } from '../../approvals/approvalRequestTransition.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from '../../approvals/approvalExecutionFailure.js';
import { WorkflowFinalResultV1Schema, projectWorkflowFinalResultDeliverableTextV1 } from '../../workflows/workflowProgressV1.js';
import type { ActionExecutorContext, ActionExecuteFailure, ActionExecutorDeps } from './types.js';
import { ActionExecuteFailureSchema } from '../actionExecutionResult.js';
import type { ActionAutomationPortV1, ActionAutomationSelectionV1, ActionAutomationTriggerReferenceV1 } from './actionAutomationAdmission.js';
import { createActionAutomationInvocationV1 } from './actionSettlement.js';
import { deriveActionActorV1 } from '../actionRequestAttributionV1.js';
import { resolveHostStampedAuthority } from '../invocationAuthority.js';

/** Host-local subject matching stays with selected triggers, outside the structural actor-row reference. */
function projectActorConsentReferenceV1(reference: ActionAutomationTriggerReferenceV1) {
  const { subject: _subject, ...retained } = reference;
  return retained;
}

/** Incumbent pre-read refusal, also consumed by the complete consent authority rule. */
export function hasApprovalAutomaticConsentPersonAuthorityV1(context: ActionExecutorContext): boolean {
  return resolveHostStampedAuthority(context) === 'present_user' && !context.externalActionCredential;
}

/** One authority rule for observing and authoring a person's execution-Account consent. */
export function canAuthorApprovalAutomaticConsentV1(request: Readonly<{
  automaticChecks?: ApprovalAutomaticChecksV1;
  executionOriginV1?: Readonly<{ accountId?: string }>;
}> | null, context: ActionExecutorContext, actionId: 'approval.request.get' | 'approval.request.decide'): boolean {
  if (!hasApprovalAutomaticConsentPersonAuthorityV1(context)) return false;
  const actor = deriveActionActorV1(context, actionId);
  return Boolean(request?.automaticChecks && actor?.actorKind === 'person'
    && actor.accountId === request.executionOriginV1?.accountId
    && (context.externalActionExecutionAuthorization || context.runtimeAccountId === undefined
      || context.runtimeAccountId === actor.accountId));
}

/** Viewer-local presentation; never persisted on the shared approval Artifact. */
export function readApprovalAutomaticConsentCanAllowV1(
  request: Parameters<typeof canAuthorApprovalAutomaticConsentV1>[0], context: ActionExecutorContext,
): boolean {
  return request?.automaticChecks?.consents.some(row => row.decision === 'pending') === true
    && canAuthorApprovalAutomaticConsentV1(request, context, 'approval.request.get');
}

/** Both Artifact families answer the same admitted trigger, retaining the saved actor row. */
export async function answerApprovalAutomaticConsentV1(args: Readonly<{
  artifactId: string; checks: ApprovalAutomaticChecksV1;
  answer: NonNullable<Parameters<NonNullable<ActionExecutorDeps['targetActionApprovalReplay']>>[0]['triggerConsent']>;
  context: ActionExecutorContext; executionContext: ActionExecutorContext; port?: ActionAutomationPortV1;
}>): Promise<ApprovalAutomaticChecksV1 | ActionExecuteFailure> {
  const key = actionAutomationTriggerKeyV1(args.answer);
  const selected = args.checks.selected.find(row => actionAutomationTriggerKeyV1(row) === key);
  const previous = args.checks.consents.find(row => actionAutomationTriggerKeyV1(row) === key);
  if (!selected || previous?.decision !== 'pending') return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
  let actorConsent: import('./actionAutomationAdmission.js').ActionAutomationTriggerReferenceV1 | undefined;
  if (args.answer.decision === 'allow') {
    if (!args.port?.allowConsent) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    actorConsent = await args.port.allowConsent({ selection: { ...selected, consent: {
      status: previous.actorConsent ? 'stale' : 'missing', ...(previous.actorConsent ? { row: previous.actorConsent } : {}) } },
      context: args.context, executionContext: args.executionContext,
      decisionInput: { artifactId: args.artifactId, decision: 'approve', triggerConsent: { ...args.answer, decision: 'allow' } } });
  }
  return { ...args.checks,
    notices: args.answer.decision === 'skip' ? [...args.checks.notices, {
      code: 'action_automation_skipped', reason: 'consentSkipped',
      automationId: selected.automationId, triggerId: selected.triggerId, workflowId: selected.workflowId,
    }] : args.checks.notices,
    consents: args.checks.consents.map(row => actionAutomationTriggerKeyV1(row) === key
    ? { ...row, decision: args.answer.decision,
      actorConsent: actorConsent ? projectActorConsentReferenceV1(actorConsent) : undefined } : row) };
}

/** Original admitted placement/selection, separate from the deciding caller's identity. */
export function restoreApprovalAutomaticContextV1(request: Readonly<{
  executionOriginV1?: StoredApprovalRequestV2['executionOriginV1']; automaticChecks?: ApprovalAutomaticChecksV1;
}>, actionId: string, context: ActionExecutorContext, port?: ActionAutomationPortV1): ActionExecutorContext {
  const origin = request.executionOriginV1;
  const selection = readApprovalAutomaticSelectionV1(request);
  if (!selection) return context;
  const retained = origin ? { ...context, actionRequestId: origin.requestId,
    authority: origin.authority, surface: origin.surface, actionCaller: origin.caller,
    ...(origin.sessionId ? { defaultSessionId: origin.sessionId } : {}),
    ...(origin.machineId ? { defaultSessionMachineId: origin.machineId } : {}),
    ...(origin.target ? { externalActionTarget: origin.target } : {}) } : context;
  const continuation = { actionId, context: retained, selection, notices: request.automaticChecks?.notices };
  return port ? { ...retained, actionAutomationAdmission: context.actionAutomationAdmission?.continue(continuation)
    ?? createActionAutomationInvocationV1({
    ...continuation, port,
  }) } : retained;
}

/** Capture the already-selected snapshot at either prepared Action owner. */
export function createApprovalAutomaticChecksV1(selection: ActionAutomationSelectionV1, humanApprovalRequired: boolean): ApprovalAutomaticChecksV1 {
  const selected = [...selection.before, ...selection.after];
  return ApprovalAutomaticChecksV1Schema.parse({ phase: 'consent', humanApprovalRequired,
    subjects: selection.subjects, selectionStatus: selection.status, notices: selection.notices ?? [],
    selected: selected.map(({ consent: _consent, ...row }) => row),
    consents: selected.filter(row => row.consent).map(row => ({ automationId: row.automationId, triggerId: row.triggerId,
      decision: row.consent?.status === 'current' ? 'allow' : 'pending',
      ...(row.consent?.review ? { review: row.consent.review } : {}),
      ...(row.consent?.row ? { actorConsent: projectActorConsentReferenceV1(row.consent.row) } : {}) })), runs: [], results: [] });
}

/** Rebuild only the admitted selection, including saved actor consent; never select again. */
export function readApprovalAutomaticSelectionV1(request: Readonly<{ automaticChecks?: ApprovalAutomaticChecksV1 }>): ActionAutomationSelectionV1 | undefined {
  const checks = request.automaticChecks;
  if (!checks) return undefined;
  const skip = new Set(checks.consents.filter(row => row.decision === 'skip').map(actionAutomationTriggerKeyV1));
  const selected = checks.selected.filter(row => !skip.has(actionAutomationTriggerKeyV1(row))).map(row => {
    const consent = checks.consents.find(consent => actionAutomationTriggerKeyV1(consent) === actionAutomationTriggerKeyV1(row));
    return consent ? { ...row, consent: { status: consent.actorConsent ? consent.decision === 'allow' ? 'current' as const : 'stale' as const : 'missing' as const,
      ...(consent.review ? { review: consent.review } : {}),
      ...(consent.actorConsent ? { row: consent.actorConsent } : {}) } } : row;
  });
  return { status: checks.selectionStatus, subjects: checks.subjects, notices: checks.notices,
    before: selected.filter(row => row.phase === 'before'), after: selected.filter(row => row.phase === 'after') };
}

type AutomaticApprovalRecord = Pick<StoredApprovalRequestV2, 'status' | 'updatedAtMs' | 'decision' | 'automaticChecks'>;
export type ApprovalAutomaticContinuationResultV1<Request> = Readonly<{ kind: 'pending' | 'approved'; request: Request }>
  | Readonly<{ kind: 'refused'; request: Request; failure: ActionExecuteFailure }> | ActionExecuteFailure;

/** Named package boundary keeps the two Artifact adapters' declarations bounded. */
export interface ApprovalAutomaticContinuationV1<Read extends AutomaticApprovalRecord, Write extends Read = Read> {
  admit(artifactId: string, request: Write, context: ActionExecutorContext): Promise<Write | ActionExecuteFailure>;
  admit(artifactId: string, request: Read, context: ActionExecutorContext): Promise<Read | ActionExecuteFailure>;
  resume(artifactId: string, request: Read, context: ActionExecutorContext): Promise<ApprovalAutomaticContinuationResultV1<Read>>;
  cancel(request: Read, context: ActionExecutorContext, exceptRunId?: string): Promise<void>;
  write(artifactId: string, request: Read, context: ActionExecutorContext): Promise<ActionExecuteFailure | null>;
}

/** One pending engine; each incumbent Artifact family retains its own subject/CAS writer. */
export function createApprovalAutomaticContinuationV1<Read extends AutomaticApprovalRecord, Write extends Read>(owner: Readonly<{
  actionAutomations?: ActionAutomationPortV1;
  parse(input: unknown): Write;
  invocation(request: Read): Readonly<{ actionId: string; input: unknown }> | ActionExecuteFailure;
  read?: (artifactId: string, request: Read) => Promise<Read | null>;
  write(artifactId: string, request: Read, context: ActionExecutorContext): Promise<ActionExecuteFailure | null>;
  refusal(request: Read, updatedAtMs: number, checks: ApprovalAutomaticChecksV1, failure: ActionExecuteFailure): Write;
  readFailure(request: Read): ActionExecuteFailure | null;
}>): ApprovalAutomaticContinuationV1<Read, Write> {
  const waitingRuns = (request: Read) => {
    const checks = request.automaticChecks;
    return checks?.runs.filter(run => checks.selected.some(selected => actionAutomationTriggerKeyV1(selected) === actionAutomationTriggerKeyV1(run)
      && selected.phase === 'before' && selected.mode !== 'notify')) ?? [];
  };
  const cancel = async (request: Read, context: ActionExecutorContext, exceptRunId?: string) => {
    await Promise.allSettled(waitingRuns(request).filter(run => run.runId !== exceptRunId)
      .map(run => owner.actionAutomations?.cancel?.({ run, context })));
  };
  const write = owner.write;

  /** The next value includes a human/consent answer, but has not been written yet. */
  function admit(artifactId: string, request: Write,
    context: ActionExecutorContext): Promise<Write | ActionExecuteFailure>;
  function admit(artifactId: string, request: Read,
    context: ActionExecutorContext): Promise<Read | ActionExecuteFailure>;
  async function admit(artifactId: string, request: Read,
    context: ActionExecutorContext): Promise<Read | ActionExecuteFailure> {
    const checks = request.automaticChecks;
    if (!checks || checks.phase !== 'consent' || checks.humanApprovalRequired && !checks.humanDecision
      || checks.consents.some(consent => consent.decision === 'pending')) return request;
    const selected = readApprovalAutomaticSelectionV1(request)?.before ?? [];
    if (selected.length === 0) return owner.parse({ ...request, status: 'approved',
      ...(checks.humanDecision ? { decision: checks.humanDecision } : {}), automaticChecks: { ...checks, phase: 'passed' } });
    if (!owner.actionAutomations?.start) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    const admitted = owner.invocation(request);
    if ('ok' in admitted) return admitted;
    const started = await owner.actionAutomations.start({ selected, ...admitted, context, approvalArtifactId: artifactId });
    return owner.parse({ ...request, updatedAtMs: Math.max(Date.now(), request.updatedAtMs),
      automaticChecks: { ...checks, phase: 'checking', runs: [...checks.runs, ...started.runs],
        notices: [...checks.notices, ...started.notices] } });
  }

  const resume = async (artifactId: string, request: Read, context: ActionExecutorContext): Promise<ApprovalAutomaticContinuationResultV1<Read>> => {
    const checks = request.automaticChecks;
    if (!checks || request.status !== 'open' || checks.phase !== 'checking') {
      return { kind: request.status === 'approved' ? 'approved' : 'pending', request };
    }
    const runs = waitingRuns(request);
    const wait = owner.actionAutomations?.wait;
    if (runs.length && !wait) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    let refused = false;
    const results = wait ? await Promise.all(runs.map(async (run): Promise<ActionAutomationResultV1> => {
      const observed = await wait({ run, context }).catch((error: unknown) => {
        if (context.signal?.aborted) throw error;
        return { state: 'interrupted' as const, errorCode: 'target_unavailable', finalResult: undefined, resultId: undefined };
      });
      const finalResult = WorkflowFinalResultV1Schema.safeParse(observed.finalResult);
      const reason = finalResult.success ? projectWorkflowFinalResultDeliverableTextV1(finalResult.data) : null;
      const outcome = observed.state === 'succeeded' ? 'passed'
        : observed.state === 'failed' ? 'failed' : observed.state === 'cancelled' ? 'canceled' : 'unavailable';
      const selection = checks.selected.find(row => actionAutomationTriggerKeyV1(row) === actionAutomationTriggerKeyV1(run));
      if (!refused && outcome !== 'passed' && (outcome !== 'failed' || selection?.onFailure !== 'ask')) {
        refused = true;
        await cancel(request, context, run.runId);
      }
      return { ...run, outcome, ...(observed.resultId ? { resultId: observed.resultId } : {}),
        ...(outcome === 'passed' ? {} : { reason: reason || observed.errorCode || 'workflow_failed' }) };
    })) : [];
    // A person's cancellation or another continuation's settlement owns the same Artifact CAS.
    if (owner.read) {
      const latest = await owner.read(artifactId, request);
      if (!latest) return { ok: false, errorCode: 'approval_invalid', error: 'approval_invalid' };
      if (latest.status === 'canceled') return { ok: false, effectAttempted: false,
        errorCode: 'approval_canceled', error: 'approval_canceled' };
      if (latest.status === 'rejected') return { ok: false, effectAttempted: false,
        errorCode: 'approval_rejected', error: 'approval_rejected' };
      if (latest.status !== 'open') {
        const failure = owner.readFailure(latest);
        return failure ?? { kind: latest.status === 'approved' ? 'approved' : 'pending', request: latest };
      }
    }
    const failed = results.filter(result => result.outcome !== 'passed');
    const updatedAtMs = Math.max(Date.now(), request.updatedAtMs);
    if (failed.length === 0) {
      const next = owner.parse({ ...request, status: 'approved', updatedAtMs,
        ...(checks.humanDecision ? { decision: checks.humanDecision } : {}),
        automaticChecks: { ...checks, phase: 'passed', results } });
      const failure = await write(artifactId, next, context);
      return failure ?? { kind: 'approved', request: next };
    }
    if (!refused) {
      const next = owner.parse({ ...request, updatedAtMs,
        automaticChecks: { ...checks, phase: 'override', results } });
      const failure = await write(artifactId, next, context);
      return failure ?? { kind: 'pending', request: next };
    }
    const failure: ActionExecuteFailure = { ok: false, effectAttempted: false,
      errorCode: 'action_interception_rejected', error: 'action_interception_rejected',
      details: { message: failed.map(result => result.reason).filter(Boolean).join('\n') } };
    const next = owner.refusal(request, updatedAtMs, { ...checks, phase: 'refused', results }, failure);
    const writeFailure = await write(artifactId, next, context);
    return writeFailure ?? { kind: 'refused', request: next, failure };
  };
  return { admit, resume, cancel, write };
}

/** Existing Action Artifact ownership adapter; no internal stored-read revalidation. */
export function createAutomaticApprovalContinuation(deps: Pick<ActionExecutorDeps,
  'approvalsUpdate' | 'approvalsGet' | 'actionAutomations'>): ApprovalAutomaticContinuationV1<StoredApprovalRequestV2, ApprovalRequestV2> {
  return createApprovalAutomaticContinuationV1<StoredApprovalRequestV2, ApprovalRequestV2>({
    actionAutomations: deps.actionAutomations,
    parse: input => ApprovalRequestV2Schema.parse(input),
    invocation: request => {
      const admitted = resolveApprovalRequestExecutionInput({ ...request, decision: request.automaticChecks?.humanDecision });
      return admitted.ok ? { actionId: request.actionId, input: admitted.input } : admitted;
    },
    ...(deps.approvalsGet ? { read: async (artifactId: string, request: StoredApprovalRequestV2) => {
      const latest = await deps.approvalsGet!({ artifactId, serverId: request.executionOriginV1.serverId });
      return latest?.v === 2 ? latest : null;
    } } : {}),
    write: async (artifactId, request, context) => {
      if (!deps.approvalsUpdate) return { ok: false, errorCode: 'approvals_not_supported', error: 'approvals_not_supported' };
      const response = await deps.approvalsUpdate({ artifactId, request, serverId: request.executionOriginV1.serverId, context });
      const failure = ActionExecuteFailureSchema.safeParse(response);
      return failure.success ? failure.data : null;
    },
    refusal: (request, updatedAtMs, checks, failure) => ApprovalRequestV2Schema.parse({
      ...settleApprovalRequestReplayInputs(request), status: 'failed', updatedAtMs, automaticChecks: checks,
      execution: projectApprovalExecutionFailureV2({ request, executedAtMs: updatedAtMs, effectAttempted: false, failure }),
    }),
    readFailure: readApprovalExecutionFailure,
  });
}
