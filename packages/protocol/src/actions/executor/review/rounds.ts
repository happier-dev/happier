import { ReviewPrepareRoundInputV1Schema, ReviewNewRoundInputV1Schema } from '../../../reviews/reviewRoundActionsV1.js';
import { prepareReviewRoundV1, prepareReviewHumanRoundV1 } from '../../../reviews/prepareReviewRoundV1.js';
import { ScmComparisonCaptureOutputSchema, type ScmComparisonCaptureInput } from '../../../scm/diffSummary.js';
import type { ScmComparison } from '../../../scm/comparison.js';
import { WorkflowRunGetResultV1Schema } from '../../../workflows/actionsV1.js';
import { prepareWorkflowRunStartV1 } from '../../../workflows/workflowStartPreparationV1.js';
import { REVIEW_PREPARE_ROUND_ACTION_ID_V1, REVIEW_NEW_ROUND_ACTION_ID_V1, type ActionId } from '../../actionIds.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import { resolveSessionIdFromInput } from '../sessionScope.js';
import { readReviewRunActionPayload } from '../executionRuns.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import type { ReviewRoundComparisonCaptureV1 } from '../../../reviews/reviewArtifactV1.js';
import { SessionStatusResultSchema } from '../../../sessions/control/contract.js';
import { RpcError } from '../../../rpc/errors.js';
import { invokeHostReviewedChildV1 } from '../deploymentRoleChild.js';
import type { JsonObject } from '../../../json/strictJsonValue.js';
import { createActionExecuteFailureError } from '../../actionExecutionResult.js';

/** Retain the same Machine authority the Review's SCM operation uses. */
export async function resolveReviewComparisonTargetV1(deps: ActionExecutorDeps, ctx: ActionExecutorContext,
  sessionId: string | null, actionId: ActionId,
  executeHostChild: RoundActionInvocation['executeHostChild']): Promise<ReviewRoundComparisonCaptureV1['target'] | undefined> {
  if (sessionId) {
    const knownMachineId = (sessionId === ctx.defaultSessionId ? ctx.defaultSessionMachineId : undefined)
      ?? await deps.resolveApiTokenGrantSessionMachineId?.({ actionId, sessionId, context: ctx });
    if (knownMachineId) return { kind: 'machine', machineId: knownMachineId };
    const response = await executeHostChild('session.status.get', { sessionId, live: false }, ctx);
    if (!response.ok) throw new Error(response.error, { cause: response });
    const status = SessionStatusResultSchema.safeParse(response.result);
    if (!status.success || status.data.session.id !== sessionId) throw new RpcError('invalid_action_output', 'invalid_action_output');
    if (!status.data.session.machineId) throw new RpcError('workspace_unavailable', 'workspace_unavailable');
    return { kind: 'machine', machineId: status.data.session.machineId };
  }
  if (ctx.externalActionTarget?.kind === 'machine') return ctx.externalActionTarget;
  const machineId = ctx.executionRunTargetMachineId ?? ctx.agentStartContext?.baseline.machineId ?? ctx.defaultSessionMachineId;
  return machineId ? { kind: 'machine', machineId } : undefined;
}

type RoundActionInvocation = Readonly<{
  actionId: ActionId;
  deps: ActionExecutorDeps;
  ctx: ActionExecutorContext;
  data: unknown;
  executeHostChild: (actionId: ActionId, input: unknown, context: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>;

/** Review admission carries a bounded index; file bodies stay pinned at the capture owner. */
export async function captureReviewComparisonV1(inv: Pick<RoundActionInvocation, 'ctx' | 'executeHostChild'>, request: ScmComparisonCaptureInput,
  context = inv.ctx): Promise<ScmComparison> {
  const response = await inv.executeHostChild('scm.diffSummary.capture', { ...request, projection: { kind: 'index' } }, context);
  if (!response.ok) throw createActionExecuteFailureError(response);
  const parsed = ScmComparisonCaptureOutputSchema.safeParse(response.result);
  if (!parsed.success) throw createActionExecuteFailureError({ ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
  const captured = parsed.data;
  if (!captured.success) throw createActionExecuteFailureError(readActionFailureEnvelope({ ...captured, ok: false })!);
  const comparison = captured.comparison;
  // Source coverage and transport coverage are separate. Keep the retained identity
  // readable through SCM paging, and never present a bounded prefix as all files.
  if (captured.page && captured.page.nextCursor !== null) {
    return { ...comparison, inventory: { ...comparison.inventory,
      state: comparison.inventory.state === 'complete' ? 'incomplete' : comparison.inventory.state,
      reasons: [...comparison.inventory.reasons,
        `Review index includes ${comparison.inventory.files.length} of ${captured.page.totalFiles} captured files; remaining files are readable from the retained comparison.`] } };
  }
  return comparison;
}

export async function dispatchReviewRoundAction(inv: RoundActionInvocation): Promise<ActionExecuteResult | null> {
  if (inv.actionId === REVIEW_PREPARE_ROUND_ACTION_ID_V1) {
    const input = ReviewPrepareRoundInputV1Schema.parse(inv.data);
    const records = inv.deps.reviewRecords?.(inv.ctx);
    if (!records) return { ok: false, errorCode: 'review_record_unavailable', error: 'review_record_unavailable' };
    return { ok: true, result: await prepareReviewRoundV1(input, {
      reviewRecords: records, cwd: inv.ctx.agentStartContext?.baseline.directory,
      comparisonTarget: input.previousRoundContext && input.reviewInput.scope !== 'repository'
        ? await resolveReviewComparisonTargetV1(inv.deps, inv.ctx,
          resolveSessionIdFromInput(input.reviewInput, inv.ctx), inv.actionId, inv.executeHostChild)
        : undefined,
      startedAt: Date.now(), signal: inv.ctx.signal,
      captureComparison: request => captureReviewComparisonV1(inv, request),
    }) };
  }
  if (inv.actionId === REVIEW_NEW_ROUND_ACTION_ID_V1) {
    const input = ReviewNewRoundInputV1Schema.parse(inv.data);
    if ('reviewId' in input) {
      const records = inv.deps.reviewRecords?.(inv.ctx);
      if (!records) return { ok: false, errorCode: 'review_record_unavailable', error: 'review_record_unavailable' };
      const review = await records.read(input.reviewId, inv.ctx.signal);
      if (!review) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      return { ok: true, result: await prepareReviewHumanRoundV1(review, {
        reviewRecords: records, startedAt: Date.now(), signal: inv.ctx.signal,
        captureComparison: (request, target) => captureReviewComparisonV1(inv, request,
          { ...inv.ctx, externalActionTarget: target }),
      }) };
    }
    if ('sessionId' in input || 'target' in input) {
      const detached = 'target' in input;
      const sessionId = detached ? null : resolveSessionIdFromInput(input, inv.ctx);
      if (!detached && !sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
      const context = detached ? { ...inv.ctx, executionRunTargetMachineId: inv.ctx.externalActionTarget?.kind === 'machine'
        ? inv.ctx.externalActionTarget.machineId : inv.ctx.executionRunTargetMachineId } : inv.ctx;
      const response = await inv.executeHostChild('execution.run.action', { sessionId, runId: input.runId,
        actionId: REVIEW_NEW_ROUND_ACTION_ID_V1, input: { ...(input.fresh === undefined ? {} : { fresh: input.fresh }),
          ...(input.costConsent === undefined ? {} : { costConsent: input.costConsent }) } }, context);
      if (!response.ok) return response;
      const result = readReviewRunActionPayload(response.result);
      return readActionFailureEnvelope(result) ?? { ok: true, result };
    }
    const prior = await inv.executeHostChild('workflow.run.get', { runId: input.runId }, inv.ctx);
    if (!prior.ok) return prior;
    const opened = WorkflowRunGetResultV1Schema.parse(prior.result);
    // Lazy like Review composition: the builtin graph owner sits above the Action executor.
    if (input.reviewerIds && !(await import('../../../workflows/builtins/reviewAndConverge.js'))
      .supportsReviewReviewerRetryV1(opened.authoredDefinition, input.reviewerIds)) {
      return { ok: false, errorCode: 'review_reviewer_retry_unavailable', error: 'review_reviewer_retry_unavailable' };
    }
    const prepared = prepareWorkflowRunStartV1({ definition: opened.authoredDefinition, acceptedContext: opened.acceptedContext,
      replay: { runId: input.runId, intent: 'another_round',
        ...(input.costConsent === undefined ? {} : { costConsent: input.costConsent }),
        ...(input.reviewerIds ? { reviewerIds: input.reviewerIds } : {}) } });
    const workflowInput = {
      runId: globalThis.crypto.randomUUID(), source: prepared.source, inputs: prepared.inputs,
      ...(prepared.executionTarget ? { executionTarget: prepared.executionTarget } : {}),
      ...(prepared.roleOverrides ? { roleOverrides: prepared.roleOverrides } : {}),
      ...(prepared.metadata ? { metadata: prepared.metadata } : {}),
      ...(prepared.origin ? { origin: prepared.origin } : {}),
      ...(prepared.onComplete ? { onComplete: prepared.onComplete } : {}),
    };
    return await invokeHostReviewedChildV1({
      parent: { actionId: inv.actionId, input }, context: inv.ctx,
      // Prepared Workflow values are JSON; the existing issuer owns normalization.
      child: { action: 'workflow.run.start', role: 'workflow.run.start', input: workflowInput as JsonObject },
      execute: (childInput, context, childId) => inv.executeHostChild(childId, childInput, context),
    });
  }
  return null;
}
