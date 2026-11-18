import { ReviewPrepareRoundInputV1Schema, ReviewNewRoundInputV1Schema } from '../../../reviews/reviewRoundActionsV1.js';
import { prepareReviewRoundV1 } from '../../../reviews/prepareReviewRoundV1.js';
import { ScmComparisonCaptureOutputSchema } from '../../../scm/diffSummary.js';
import { WorkflowRunGetResultV1Schema } from '../../../workflows/actionsV1.js';
import { prepareWorkflowRunStartV1 } from '../../../workflows/workflowStartPreparationV1.js';
import { REVIEW_PREPARE_ROUND_ACTION_ID_V1, REVIEW_NEW_ROUND_ACTION_ID_V1, type ActionId } from '../../actionIds.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import { resolveSessionIdFromInput } from '../sessionScope.js';
import { readReviewRunActionPayload } from '../executionRuns.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import type { ReviewRoundComparisonCaptureV1 } from '../../../reviews/reviewArtifactV1.js';

/** Retain the same Machine authority the Review's SCM operation uses. */
export async function resolveReviewComparisonTargetV1(deps: ActionExecutorDeps, ctx: ActionExecutorContext,
  sessionId: string | null): Promise<ReviewRoundComparisonCaptureV1['target'] | undefined> {
  if (ctx.externalActionTarget?.kind === 'machine') return ctx.externalActionTarget;
  const machineId = ctx.executionRunTargetMachineId
    ?? (sessionId ? await deps.resolveSessionMachineId?.(sessionId) : undefined)
    ?? ctx.agentStartContext?.baseline.machineId ?? ctx.defaultSessionMachineId;
  return machineId ? { kind: 'machine', machineId } : undefined;
}

type RoundActionInvocation = Readonly<{
  actionId: ActionId;
  deps: ActionExecutorDeps;
  ctx: ActionExecutorContext;
  data: unknown;
  executeHostChild: (actionId: ActionId, input: unknown, context: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>;

export async function dispatchReviewRoundAction(inv: RoundActionInvocation): Promise<ActionExecuteResult | null> {
  if (inv.actionId === REVIEW_PREPARE_ROUND_ACTION_ID_V1) {
    const input = ReviewPrepareRoundInputV1Schema.parse(inv.data);
    const records = inv.deps.reviewRecords?.(inv.ctx);
    if (!records) return { ok: false, errorCode: 'review_record_unavailable', error: 'review_record_unavailable' };
    return { ok: true, result: await prepareReviewRoundV1(input, {
      reviewRecords: records, cwd: inv.ctx.agentStartContext?.baseline.directory,
      comparisonTarget: await resolveReviewComparisonTargetV1(inv.deps, inv.ctx,
        resolveSessionIdFromInput(input.reviewInput, inv.ctx)),
      startedAt: Date.now(), signal: inv.ctx.signal,
      captureComparison: async request => {
        const capture = await inv.executeHostChild('scm.diffSummary.capture', request, inv.ctx);
        if (!capture.ok) throw new Error(capture.error, { cause: capture });
        const captured = ScmComparisonCaptureOutputSchema.parse(capture.result);
        if (!captured.success) throw new Error(captured.error, { cause: { ok: false, errorCode: captured.errorCode, error: captured.error } });
        return captured.comparison;
      },
    }) };
  }
  if (inv.actionId === REVIEW_NEW_ROUND_ACTION_ID_V1) {
    const input = ReviewNewRoundInputV1Schema.parse(inv.data);
    if ('sessionId' in input || 'target' in input) {
      const detached = 'target' in input;
      const sessionId = detached ? null : resolveSessionIdFromInput(input, inv.ctx);
      if (!detached && !sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
      const context = detached ? { ...inv.ctx, executionRunTargetMachineId: inv.ctx.externalActionTarget?.kind === 'machine'
        ? inv.ctx.externalActionTarget.machineId : inv.ctx.executionRunTargetMachineId } : inv.ctx;
      const response = await inv.executeHostChild('execution.run.action', { sessionId, runId: input.runId,
        actionId: REVIEW_NEW_ROUND_ACTION_ID_V1, input: { ...(input.fresh === undefined ? {} : { fresh: input.fresh }) } }, context);
      if (!response.ok) return response;
      const result = readReviewRunActionPayload(response.result);
      return readActionFailureEnvelope(result) ?? { ok: true, result };
    }
    const prior = await inv.executeHostChild('workflow.run.get', { runId: input.runId }, inv.ctx);
    if (!prior.ok) return prior;
    const opened = WorkflowRunGetResultV1Schema.parse(prior.result);
    const prepared = prepareWorkflowRunStartV1({ definition: opened.authoredDefinition, acceptedContext: opened.acceptedContext,
      replay: { runId: input.runId, intent: 'another_round' } });
    return await inv.executeHostChild('workflow.run.start', {
      runId: globalThis.crypto.randomUUID(), source: prepared.source, inputs: prepared.inputs,
      ...(prepared.executionTarget ? { executionTarget: prepared.executionTarget } : {}),
      ...(prepared.roleOverrides ? { roleOverrides: prepared.roleOverrides } : {}),
      ...(prepared.metadata ? { metadata: prepared.metadata } : {}),
      ...(prepared.origin ? { origin: prepared.origin } : {}),
      ...(prepared.onComplete ? { onComplete: prepared.onComplete } : {}),
    }, inv.ctx);
  }
  return null;
}
