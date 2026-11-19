import { isActionFamilyId } from '../actionFamilies.js';
import { REVIEW_COMMENT_LIST_PAGE_LIMIT_MAX_V1, ReviewCommentActionIdV1Schema, ReviewCommentListActionRequestV1Schema, ReviewCommentListResponseV1Schema, type ReviewCommentListResponseV1 } from '../../../reviews/comments/actions.js';
import type { WorkflowSessionScopeV1 } from '../../../workflows/workflowSessionScopeV1.js';
import { normalizeId } from '../inputReading.js';
import type { AdmittedActionInputById } from '../../actionSpecs.js';
import type { ReviewCommentV1 } from '../../../reviews/comments/v1.js';
import { reviewCommentFindingScopeV1 } from '../../../reviews/comments/findingIdentity.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import { ReviewCommentGetResponseV1Schema } from '../../../reviews/comments/actions.js';
import { buildAcceptedReviewFindingsForVerifyV1, REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1, renderReviewFindingsForVerifyV1 } from '../../../reviews/reviewFindingsApplyInputV1.js';
import { ReviewWalkthroughRequestSchema, ReviewExplainFindingsRequestSchema, ReviewExplainFindingsRefinementSchema } from '../../../reviews/reviewNarration.js';
import { resolveSessionIdFromInput, resolveServerIdForExecutionRunScope } from '../sessionScope.js';
import { resolveExecutionRunLaunchOrigin, buildExecutionRunCallOptions, checkDetachedExecutionRunProtocolV2, normalizeExecutionBackendOptionValue, normalizeExecutionBackendTargetValue, resolveFanoutTeamCredentialModel, resolveFanoutConnectedServicesSelections, readReviewRunActionPayload, readFanoutStartError, fanoutStarts, classifyExecutionRunStartFailure } from '../executionRuns.js';
import { readRecord, hasOwn } from '../../../inputs/inputRecords.js';
import { requiresReviewWorkflowCompositionV1, reviewReviewerIdForSelectionV1, reviewReviewerIdsForStartV1, type ReviewStartInput } from '../../../reviews/reviewStart.js';
import { SESSION_TRANSCRIPT_GET_MAX_LIMIT, SessionTranscriptGetResultSchema } from '../../specs/session/transcript.js';
import { createPermissionPolicyResult, resolveAgentExecutionRunPermission } from '../callerContext.js';
import { EXECUTION_RUN_ACTION_PERMISSION_MODES } from '../../executionRunActionPermissionMode.js';
import { tryNormalizeExecutionBackendOptionValue, readReviewNarratorOptions } from '../../../inputs/inputOptions.js';
import { resolveReviewNarratorPolicy, type ReviewEngineScope } from '../../../reviews/reviewEngines.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { readExecutionRunStartRunCreation, withExecutionRunStartFailureDetails } from '../../../execution/runs/responseSchemas.js';
import { REVIEW_SETTLE_ROUND_ACTION_ID_V1, type ActionId } from '../../actionIds.js';
import { REVIEW_HUMAN_ACTION_IDS_V1 } from '../../actionIdsReviewHumanV1.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import { isActionOutcomeUnknownErrorCodeV1, projectActionFailureCauseV1 } from '../../actionExecutionResult.js';
import { dispatchReviewRoundAction, resolveReviewComparisonTargetV1 } from './rounds.js';
import type { ScmComparison } from '../../../scm/comparison.js';
import { ScmComparisonCaptureOutputSchema } from '../../../scm/diffSummary.js';
import { ScmStatusSnapshotResponseSchema } from '../../../scm/index.js';
import { resolveReviewComparisonSourceV1 } from '../../../reviews/prepareReviewRoundV1.js';
import { dispatchReviewSettlementAction } from './settlement.js';

export function reviewScopeForInput(input: unknown): ReviewEngineScope {
  const record = readRecord(input);
  if (record.scope === 'repository') return 'repository';
  return hasOwn(record, 'selectedPaths') || hasOwn(record, 'selectedFiles') ? 'paths' : 'worktree';
}

async function readReviewTranscriptInput(sourceSession: NonNullable<ReviewStartInput['sourceSession']>,
  execute: (actionId: ActionId, input: unknown, context: ActionExecutorContext) => Promise<ActionExecuteResult>,
  context: ActionExecutorContext): Promise<Readonly<{ ok: true; instructions: string }> | Extract<ActionExecuteResult, { ok: false }>> {
  const items: import('../../specs/session/transcript.js').SessionTranscriptGetItem[] = [];
  let cursor: string | null = null;
  let partial = false;
  for (;;) {
    const response = await execute('session.transcript.get', { sessionId: sourceSession.sessionId,
      cursor, direction: 'after', limit: SESSION_TRANSCRIPT_GET_MAX_LIMIT,
      includeTools: true, includeReasoning: false, includeEvents: false, includeRaw: false,
      maxCharsPerMessage: null }, { ...context, serverId: sourceSession.serverId });
    if (!response.ok) return response;
    const parsed = SessionTranscriptGetResultSchema.safeParse(response.result);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    const page = parsed.data;
    if (!page.ok) return { ok: false, errorCode: page.errorCode, error: page.errorMessage };
    if ('projection' in page || page.sessionId !== sourceSession.sessionId) {
      return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    }
    items.push(...page.items);
    partial ||= page.diagnostics.payloadTruncations > 0 || page.items.some(item => item.truncated === true);
    if (!page.hasMore || page.nextCursor === null) {
      partial ||= page.hasMore || page.diagnostics.scanLimitReached;
      break;
    }
    cursor = page.nextCursor;
  }
  return { ok: true, instructions: `Session transcript (${partial ? 'partial' : 'complete'} coverage):\n${JSON.stringify({ sourceSession, items })}` };
}

export async function dispatchReviewDispatch1(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'ctx' | 'parsed' | 'data'> & Readonly<{
  executeHostChild: (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
  workflowSessionScope: WorkflowSessionScopeV1 | null;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, ctx, parsed, data, executeHostChild, workflowSessionScope } = inv;
  if (actionId === REVIEW_SETTLE_ROUND_ACTION_ID_V1) return await dispatchReviewSettlementAction({ deps, ctx, data: parsed.data });
  const roundAction = await dispatchReviewRoundAction({ actionId, deps, ctx, data: parsed.data, executeHostChild });
  if (roundAction) return roundAction;

      const reviewCommentActionId = isActionFamilyId(actionId, ReviewCommentActionIdV1Schema) ? actionId : null;
      if (reviewCommentActionId !== null || actionId === 'review.apply') {
        if (!deps.reviewCommentAction) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        let reviewCommentPrincipal = ctx.reviewCommentPrincipal ?? null;
        let reviewCommentInput = parsed.data;
        if (ctx.actionCaller?.kind === 'workflowRun') {
          if (reviewCommentPrincipal && (
            reviewCommentPrincipal.actor.kind !== 'workflow'
            || reviewCommentPrincipal.actor.runId !== ctx.actionCaller.runId
          )) {
            return { ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' };
          }
          // Only the executor's admitted scope can replace a supplied principal projection.
          const workflowScope = workflowSessionScope;
          ctx.signal?.throwIfAborted();
          const { workflowScope: _suppliedScope, ...principal } = reviewCommentPrincipal ?? {};
          reviewCommentPrincipal = { ...principal, actor: { kind: 'workflow', runId: ctx.actionCaller.runId },
            ...(workflowScope ? { workflowScope } : {}) };
        } else if (ctx.surface === 'agent' || ctx.surface === 'mcp') {
          const actor = reviewCommentPrincipal?.actor;
          if (actor?.kind !== 'agent' || (ctx.defaultSessionId && ctx.defaultSessionId !== actor.sessionId)) {
            return { ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' };
          }
          if (reviewCommentActionId === 'reviews.comments.list') {
            reviewCommentInput = {
              ...data,
              sessionId: data.sessionId ?? actor.sessionId,
            };
          }
        }
        if (ctx.surface === 'plugin') {
          if (ctx.actionCaller?.kind !== 'plugin') {
            return {
              ok: false,
              errorCode: 'plugin_action_caller_required',
              error: 'plugin_action_caller_required',
            };
          }
          if (reviewCommentPrincipal) {
            return {
              ok: false,
              errorCode: 'review_comment_permission_denied',
              error: 'review_comment_permission_denied',
            };
          }
          reviewCommentPrincipal = {
            actor: { kind: 'plugin', pluginId: ctx.actionCaller.pluginId },
          };
        }
        const serverId = normalizeId(ctx.serverId) || null;
        const requestContext = {
          ...(serverId ? { serverId } : {}),
          ...(reviewCommentPrincipal ? { reviewCommentPrincipal } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        };
        if (actionId === 'review.apply') {
          const apply = parsed.data as AdmittedActionInputById[typeof actionId];
          // SessionTarget preparation owns selector resolution; leaves accept only its exact address.
          if (typeof apply.sessionId !== 'string') return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const comments: ReviewCommentV1[] = [];
          const scopes = 'reviewId' in apply ? [{ reviewId: apply.reviewId }]
            : [...new Set(apply.reviews.map(review => review.runId))].map(runId => ({ sessionId: apply.sessionId, runId }));
          for (const scope of scopes) {
            let cursor: string | undefined;
            do {
              ctx.signal?.throwIfAborted();
              const result = await deps.reviewCommentAction({ actionId: 'reviews.comments.list',
                input: ReviewCommentListActionRequestV1Schema.parse({ ...scope, includeHistory: true,
                  limit: REVIEW_COMMENT_LIST_PAGE_LIMIT_MAX_V1, ...(cursor ? { cursor } : {}) }),
                ...requestContext });
              const failure = readActionFailureEnvelope(result);
              if (failure) return failure;
              const page = ReviewCommentListResponseV1Schema.parse(result);
              comments.push(...page.items);
              cursor = page.cursor ?? undefined;
            } while (cursor !== undefined);
          }
          // A materialized finding can reuse an earlier round's canonical comment.
          for (const id of new Set('reviewId' in apply ? [] : apply.reviews.flatMap(review => review.findings.flatMap(finding => finding.comment ? [finding.comment.id] : [])))) {
            if (comments.some(comment => comment.id === id)) continue;
            ctx.signal?.throwIfAborted();
            const result = await deps.reviewCommentAction({ actionId: 'reviews.comments.get', input: { commentId: id, includeHistory: true }, ...requestContext });
            const failure = readActionFailureEnvelope(result);
            if (failure) return failure;
            comments.push(ReviewCommentGetResponseV1Schema.parse(result).comment);
          }
          if (!('reviewId' in apply) && comments.some(comment => comment.sessionId !== apply.sessionId)) {
            return { ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' };
          }
          const reviews = 'reviewId' in apply ? comments.filter(comment => reviewCommentFindingScopeV1(comment) !== null).map(comment => ({ runId: comment.runId ?? comment.id,
            findings: [{ ...comment.finding, id: comment.findingId ?? comment.id, title: comment.finding?.title ?? 'Review finding',
              summary: typeof comment.body === 'string' ? comment.body : '',
              engineId: comment.engineId, anchor: comment.anchor,
              comment: { id: comment.id, serverRevision: comment.serverRevision, state: comment.state,
                reviewId: apply.reviewId, ...(comment.projectId ? { projectId: comment.projectId } : {}),
                ...(comment.workspace ? { workspace: comment.workspace } : {}),
                ...(comment.sessionId ? { sessionId: comment.sessionId } : {}),
                ...(comment.runId ? { runId: comment.runId } : {}) },
            }] })) : apply.reviews;
          const findings = buildAcceptedReviewFindingsForVerifyV1(reviews, comments);
          if (findings.length === 0) return { ok: true, result: { status: 'unchanged', commentIds: [] } };
          if ('reviewId' in apply && findings.some(finding => typeof comments.find(comment => comment.id === finding.comment?.id)?.body !== 'string')) {
            return { ok: false, errorCode: 'review_comment_encryption_material_unavailable', error: 'review_comment_encryption_material_unavailable' };
          }
          ctx.signal?.throwIfAborted();
          // Plugin delivery retains the existing host invocation identity; the message owner
          // still owns admission, local-id derivation and idempotency. Never mint a second id.
          const idempotencyKey = ctx.actionCaller?.kind === 'plugin' ? normalizeId(ctx.actionRequestId) : null;
          return await executeHostChild('session.message.send', { sessionId: apply.sessionId,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            message: `${REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1}\n\n${renderReviewFindingsForVerifyV1(findings)}` }, ctx);
        }
        if (reviewCommentActionId === null) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        if (reviewCommentActionId === 'reviews.comments.list') {
          const { allPages, ...request } = ReviewCommentListActionRequestV1Schema.parse(reviewCommentInput);
          reviewCommentInput = request;
          if (allPages) {
            const items: ReviewCommentListResponseV1['items'] = [];
            let cursor = request.cursor;
            do {
              ctx.signal?.throwIfAborted();
              const result = await deps.reviewCommentAction({
                actionId: 'reviews.comments.list',
                // Draining every page: a page size only sets how many round trips that costs.
                input: { ...request, limit: REVIEW_COMMENT_LIST_PAGE_LIMIT_MAX_V1, ...(cursor ? { cursor } : {}) },
                ...requestContext,
              });
              const failure = readActionFailureEnvelope(result);
              if (failure) return failure;
              const page = ReviewCommentListResponseV1Schema.parse(result);
              items.push(...page.items);
              cursor = page.cursor ?? undefined;
            } while (cursor !== undefined);
            return { ok: true, result: { items, cursor: null } };
          }
        }
        const result = await deps.reviewCommentAction({
          actionId: reviewCommentActionId,
          input: reviewCommentInput,
          ...requestContext,
        });
        const failure = readActionFailureEnvelope(result);
        return failure ?? { ok: true, result };
      }
  return null;
}

export async function dispatchReviewDispatch2(inv: Pick<CoreInvocation, 'actionId' | 'parsed' | 'ctx' | 'data' | 'deps'> & Readonly<{
  workflowSessionScope: WorkflowSessionScopeV1 | null;
  executeHostChild: (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
  startExecutionRunWithSelection: (sessionId: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[0], input: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[1], opts: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[2], context: ActionExecutorContext) => ReturnType<NonNullable<ActionExecutorDeps['executionRunStart']>>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, parsed, ctx, executeHostChild, data, deps, startExecutionRunWithSelection, workflowSessionScope } = inv;

      if (actionId === 'review.walkthrough' || actionId === 'review.explain_findings') {
        const input = parsed.data as AdmittedActionInputById[typeof actionId];
        const detached = input.target?.kind === 'detached';
        const sessionId = detached ? null : resolveSessionIdFromInput(input, ctx);
        if (!detached && !sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        const narrationContext = detached ? { ...ctx, executionRunTargetMachineId: ctx.externalActionTarget?.kind === 'machine'
          ? ctx.externalActionTarget.machineId : ctx.executionRunTargetMachineId } : ctx;
        const { sessionId: _sessionId, target: _target, runId, reviewRunIds, ...request } = input;
        const nestedInput = actionId === 'review.walkthrough'
          ? ReviewWalkthroughRequestSchema.parse({ ...request, reviewRunIds: reviewRunIds ?? [runId] })
          : ReviewExplainFindingsRequestSchema.parse({ ...request, reviewRunIds: reviewRunIds ?? [runId] });
        // Reuse the existing Run Action admission/authority transport in every surface.
        const response = await executeHostChild('execution.run.action', { sessionId, runId, actionId, input: nestedInput }, narrationContext);
        if (!response.ok) return response;
        const payload = readReviewRunActionPayload(response.result);
        const host = readRecord(payload);
        if (host.ok === false) return { ok: false,
          errorCode: typeof host.errorCode === 'string' ? host.errorCode : 'review_action_failed',
          error: typeof host.error === 'string' ? host.error : 'review_action_failed' };
        if (actionId === 'review.walkthrough') return { ok: true, result: payload };
        const refinement = ReviewExplainFindingsRefinementSchema.safeParse(payload);
        if (!refinement.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
        // Targeting was verified by the host; revision admission remains with U3.
        return executeHostChild(refinement.data.refinement.actionId, refinement.data.refinement.input,
          { ...narrationContext, defaultSessionId: sessionId ?? undefined });
      }

      if (actionId === 'review.start') {
        const detached = readRecord(data.target).kind === 'detached'
          || ctx.actionCaller?.kind === 'workflowRun';
        const sessionId = detached ? null : resolveSessionIdFromInput(parsed.data, ctx);
        if (!detached && !sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        const machineTarget = detached && ctx.externalActionTarget?.kind === 'machine' ? ctx.externalActionTarget : undefined;
        const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
        const baseOptions = buildExecutionRunCallOptions(
          ctx.authority,
          serverId, ctx.signal, detached ? ctx.defaultSessionId : undefined,
          detached ? machineTarget?.machineId ?? ctx.executionRunTargetMachineId : undefined,
          detached ? ctx.executionRunPermissionRequestStore : undefined,
          detached ? ctx.executionRunWorkflowObservationSink : undefined,
          ctx,
        );
        const workflowScope = ctx.actionCaller?.kind === 'workflowRun' ? workflowSessionScope : null;
        ctx.signal?.throwIfAborted();
        const opts = workflowScope ? { ...baseOptions, workflowScope } : baseOptions;

        let reviewInput = data as ReviewStartInput;
        let initialComparison: ScmComparison | undefined;
        let selectedSource = reviewInput.reviewRound ? undefined : resolveReviewComparisonSourceV1(reviewInput);
        const needsComparison = !reviewInput.reviewRound && Boolean(selectedSource || reviewInput.comparisonId);
        let comparisonCwd = reviewInput.cwd ?? (sessionId && sessionId !== ctx.defaultSessionId ? undefined : ctx.agentStartContext?.baseline.directory);
        const comparisonTarget = needsComparison
          ? await resolveReviewComparisonTargetV1(deps, ctx, sessionId, actionId, executeHostChild) : undefined;
        if (needsComparison && !comparisonCwd) {
          const response = await executeHostChild('scm.status.snapshot', { ...(sessionId ? { sessionId } : {}), detail: 'facts' }, ctx);
          if (!response.ok) return response;
          const status = ScmStatusSnapshotResponseSchema.safeParse(response.result);
          if (!status.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          if (!status.data.success) return { ok: false, errorCode: status.data.errorCode ?? 'workspace_unavailable',
            error: status.data.error ?? 'workspace_unavailable' };
          comparisonCwd = status.data.snapshot?.repo.rootPath ?? undefined;
        }
        if (needsComparison && (!comparisonCwd || !comparisonTarget)) {
          return { ok: false, errorCode: 'workspace_unavailable', error: 'workspace_unavailable' };
        }
        if (needsComparison && comparisonCwd && (!reviewInput.comparisonId || !selectedSource)) {
          const response = await executeHostChild('scm.diffSummary.capture', { cwd: comparisonCwd,
            ...(selectedSource ? { source: selectedSource } : {}),
            ...(reviewInput.comparisonId ? { comparisonId: reviewInput.comparisonId } : {}),
            ...(sessionId ? { sessionId } : {}) }, ctx);
          if (!response.ok) return response;
          const captured = ScmComparisonCaptureOutputSchema.safeParse(response.result);
          if (!captured.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          if (!captured.data.success) return { ok: false, errorCode: captured.data.errorCode, error: captured.data.error };
          initialComparison = captured.data.comparison;
          selectedSource = initialComparison.source;
          reviewInput = { ...reviewInput, source: initialComparison.source, comparisonId: initialComparison.id };
        }
        const subjectKind = reviewInput.scmPullRequestReviewScope ? 'pull_request'
          : reviewInput.comparisonId ? 'comparison' : 'repository';
        const comparisonCapture = reviewInput.comparisonId && selectedSource && comparisonCwd && comparisonTarget
          ? { target: comparisonTarget, input: { cwd: comparisonCwd, source: selectedSource,
            comparisonId: reviewInput.comparisonId, ...(sessionId ? { sessionId } : {}) } } : undefined;
        const workflowComposition = requiresReviewWorkflowCompositionV1(reviewInput);
        const reviewers = reviewInput.steps?.flatMap(step => step.reviewers) ?? reviewInput.reviewers;
        const transcriptReviewers = reviewers.filter(reviewer => reviewer.kind !== 'person' && reviewer.includeSessionTranscript === true);
        const profileSelections = reviewers.flatMap((selection, index) => {
          if (selection.kind !== 'engine') return [];
          const engineInput = { ...reviewInput, ...selection,
            ...(!workflowComposition ? ctx.reviewReviewerLaunchInputs?.[index] : undefined) };
          return engineInput.profileId ? [{ engineId: selection.engineId, profileId: engineInput.profileId,
            ...(engineInput.profileSourceCustody ? { profileSourceCustody: engineInput.profileSourceCustody } : {}) }] : [];
        });
        const readReviewEngineInventory = async (dispatchOptions = opts) => await deps.reviewEnginesList!({
          sessionId,
          ...(detached && dispatchOptions?.targetMachineId ? { machineId: dispatchOptions.targetMachineId } : {}),
          includeDisabled: false,
          ...(profileSelections.length > 0 ? { profileSelections } : {}),
          scope: reviewScopeForInput(reviewInput),
        }, ctx);
        let reviewEngineInventory: unknown;
        if (transcriptReviewers.some(reviewer => reviewer.kind === 'engine')) {
          if (!deps.reviewEnginesList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          reviewEngineInventory = await readReviewEngineInventory();
          const defaultOptions = readReviewNarratorOptions(reviewEngineInventory);
          const profileOptions = readReviewNarratorOptions({ items: readRecord(reviewEngineInventory).selectionItems });
          if (reviewers.some((selection, index) => {
            if (selection.kind !== 'engine' || selection.includeSessionTranscript !== true) return false;
            const engineInput = { ...reviewInput, ...selection,
              ...(!workflowComposition ? ctx.reviewReviewerLaunchInputs?.[index] : undefined) };
            const options = engineInput.profileId ? profileOptions : defaultOptions;
            return options.find(option => option.value === normalizeExecutionBackendOptionValue(selection.engineId)
              && (!engineInput.profileId || option.profileId === engineInput.profileId))?.capabilities.sessionTranscript !== true;
          })) return { ok: false, errorCode: 'review_transcript_unsupported', error: 'review_transcript_unsupported' };
        }
        const transcript = transcriptReviewers.length > 0 && reviewInput.sourceSession
          ? await readReviewTranscriptInput(reviewInput.sourceSession, executeHostChild, ctx) : null;
        if (transcript && !transcript.ok) return transcript;
        if (workflowComposition) {
          // Retain admitted ordinary reviewer prompts so Workflow leaves do not reread the source.
          const records = deps.reviewRecords?.(ctx);
          if (!records) return { ok: false, errorCode: 'review_record_unavailable', error: 'review_record_unavailable' };
          const reviewRound = await records.start({ reviewId: globalThis.crypto.randomUUID(), title: 'Code review',
            subjectKind,
            sourceKind: ctx.actionCaller?.kind === 'workflowRun' ? 'workflow' : 'direct',
            ...(ctx.actionCaller?.kind === 'workflowRun' ? { workflowId: ctx.actionCaller.workflowId } : {}),
            ...(reviewInput.comparisonId ? { comparisonId: reviewInput.comparisonId } : {}),
            ...(comparisonCapture ? { comparisonCapture } : {}),
            reviewerIds: reviewReviewerIdsForStartV1(reviewInput), startedAt: Date.now(), signal: ctx.signal });
          const people = (reviewInput.steps ?? [{ reviewers: reviewInput.reviewers }]).flatMap(step =>
            step.reviewers.flatMap(reviewer => reviewer.kind === 'person'
              ? [{ principal: reviewer.principal, required: reviewer.required }] : []));
          if (people.length > 0) {
            const requested = await executeHostChild(REVIEW_HUMAN_ACTION_IDS_V1.setReviewers,
              { ...reviewRound, reviewers: people }, ctx);
            if (!requested.ok) {
              await records.settle({ ...reviewRound, outcome: ctx.signal?.aborted ? 'cancelled' : 'failed',
                finishedAt: Date.now(), runs: [], ...(ctx.signal?.aborted ? {} : { signal: ctx.signal }) });
              return requested;
            }
          }
          if (reviewReviewerIdsForStartV1(reviewInput).length === 0) {
            await records.settle({ ...reviewRound, outcome: 'completed', finishedAt: Date.now(),
              runs: [], signal: ctx.signal });
            return { ok: true, result: { intent: 'review', sessionId, reviewRound,
              reviewedFingerprint: null, results: [] } };
          }
          const { buildReviewStepsWorkflowV1 } = await import('../../../workflows/builtins/reviewAndConverge.js');
          const built = buildReviewStepsWorkflowV1(reviewInput, reviewRound, initialComparison, comparisonCapture?.input, transcript?.ok ? transcript.instructions : undefined);
          const started = await executeHostChild('workflow.run.start', { runId: globalThis.crypto.randomUUID(),
            source: { kind: 'inline', definition: built.definition }, inputs: built.inputs }, ctx);
          if (!started.ok) {
            if (!isActionOutcomeUnknownErrorCodeV1(started.errorCode)) {
              await records.settle({ ...reviewRound, outcome: ctx.signal?.aborted ? 'cancelled' : 'failed',
                finishedAt: Date.now(), runs: [], ...(ctx.signal?.aborted ? {} : { signal: ctx.signal }) });
            }
            return started;
          }
          return { ok: true, result: { ...readRecord(started.result), reviewRound } };
        }
        if (!deps.reviewEnginesList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const engineSelections = reviewInput.reviewers.flatMap((selection, index) => selection.kind === 'engine'
          ? [{ selection, index, reviewerId: reviewInput.reviewReviewerId ?? reviewReviewerIdForSelectionV1(index) }] : []);
        const admittedEngineSelections = [];
        for (const entry of engineSelections) {
          const hostLaunch = ctx.reviewReviewerLaunchInputs?.[entry.index];
          const engineInput = { ...reviewInput, ...entry.selection, ...hostLaunch, intent: hostLaunch?.intent };
          const connections = resolveFanoutConnectedServicesSelections(engineInput, [entry.selection.engineId]);
          const team = resolveFanoutTeamCredentialModel(engineInput, [entry.selection.engineId]);
          if (!connections.ok || !team.ok || (engineInput.teamCredentialSessionBindingConsent
            && engineInput.teamCredentialSessionBindingConsent.sessionId !== sessionId)) {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          admittedEngineSelections.push({ ...entry, engineInput,
            connectedSelection: connections.selections.get(entry.selection.engineId)!, teamCredentialModel: team.selection });
        }
        const selectedById = new Map(admittedEngineSelections.map(entry => [entry.reviewerId, entry]));
        const engineIds = engineSelections.map(entry => entry.selection.engineId);
        const instructions = reviewInput.instructions.trim();
        const executionRunPermission = resolveAgentExecutionRunPermission(
          ctx,
          reviewInput.permissionMode,
          EXECUTION_RUN_ACTION_PERMISSION_MODES,
        );
        if (!executionRunPermission.ok) {
          return executionRunPermission.error;
        }
        const permissionDecision = executionRunPermission.permissionDecision;
        if (permissionDecision?.ok === false) {
          return createPermissionPolicyResult(ctx, permissionDecision);
        }
        const permissionMode = permissionDecision?.ok === true
          ? permissionDecision.requestedMode
          : reviewInput.permissionMode;
        const executionRunOpts = executionRunPermission.causalPermissionAuthority
          ? {
              ...(opts ?? {}),
              causalPermissionAuthority: executionRunPermission.causalPermissionAuthority,
            }
          : opts;
        let executionRunDispatchOpts = executionRunOpts;
        const runScopedAgentBindings = reviewInput.roleId !== undefined || reviewInput.launchProfileId !== undefined
          || reviewInput.teamCredentialModel !== undefined
          || engineSelections.some(({ selection }) => selection.roleId !== undefined || selection.launchProfileId !== undefined
            || selection.teamCredentialModel !== undefined);
        const hasSecretOverlay = reviewInput.secretReferenceOverlay !== undefined
          || engineSelections.some(({ selection }) => selection.secretReferenceOverlay !== undefined);
        if (detached || hasSecretOverlay || runScopedAgentBindings) {
          const capability = await checkDetachedExecutionRunProtocolV2(
            deps,
            sessionId,
            executionRunOpts,
            {
              startAndWait: false,
              runScopedAgentBindings,
              secretReferenceOverlay: hasSecretOverlay,
            },
          );
          if (!capability.ok) return classifyExecutionRunStartFailure(capability, 'noRunCreated');
          executionRunDispatchOpts = capability.opts;
        }
        const {
          teamCredentialSessionBindingConsent: _teamCredentialSessionBindingConsent,
          secretReferenceOverlay: _secretReferenceOverlay,
          approvalProfileId: _approvalProfileId,
          outputs: _outputs,
          narrator: _narrator,
          reviewers: _reviewers,
          steps: _steps,
          ...reviewIntentInput
        } = reviewInput;
        const intentInputBase = { ...reviewIntentInput, permissionMode };
        reviewEngineInventory ??= await readReviewEngineInventory(executionRunDispatchOpts);
        const narratorOptions = readReviewNarratorOptions(reviewEngineInventory);
        const explicitProfileOptions = readReviewNarratorOptions({ items: readRecord(reviewEngineInventory).selectionItems });
        const selectedReviewEngineItems = new Map(admittedEngineSelections.map(({ reviewerId, selection, engineInput }) => {
          const backendKey = normalizeExecutionBackendOptionValue(selection.engineId);
          const options = engineInput.profileId ? explicitProfileOptions : narratorOptions;
          const item = options.find((option) => option.value === backendKey
            && (!engineInput.profileId || option.profileId === engineInput.profileId));
          return [reviewerId, item] as const;
        }));
        const narrationRequested = reviewInput.outputs?.includes('walkthrough') === true;
        const narrationPolicy = resolveReviewNarratorPolicy({
          selectedEngineIds: engineSelections.map(entry => entry.reviewerId),
          engines: engineSelections.flatMap(({ reviewerId }) => {
            const selected = selectedReviewEngineItems.get(reviewerId);
            return selected ? [{ ...selected, value: reviewerId }] : [];
          }),
        });
        const narrator = reviewInput.narrator ?? (narrationPolicy.defaultNarratorEngineId
          ? { engineId: engineSelections.find(entry => entry.reviewerId === narrationPolicy.defaultNarratorEngineId)!.selection.engineId }
          : undefined);
        if (narrationRequested && !reviewInput.comparisonId) {
          return { ok: false, errorCode: 'review_narration_comparison_required', error: 'review_narration_comparison_required' };
        }
        if (narrationRequested && (!narrator || !narratorOptions.some((option) =>
          option.value === tryNormalizeExecutionBackendOptionValue(narrator.engineId)
          && option.disabled !== true && option.capabilities.structuredNarration))) {
          return { ok: false, errorCode: 'review_narrator_unavailable', error: 'review_narrator_unavailable' };
        }
        const originalSelection = engineSelections[0]?.selection;
        const originalModelId = originalSelection?.teamCredentialModel?.modelId ?? originalSelection?.modelId
          ?? (typeof data.modelId === 'string' ? data.modelId : undefined);
        const continueSingleReview = narrationRequested && engineIds.length === 1 && !narrationPolicy.requiresSeparateNarrator
          && narrator !== undefined && normalizeExecutionBackendOptionValue(narrator.engineId) === normalizeExecutionBackendOptionValue(engineIds[0]!)
          && (narrator.modelId === undefined || narrator.modelId === originalModelId);

        const reviewIdBytes = randomBytes(16);
        reviewIdBytes[6] = (reviewIdBytes[6]! & 0x0f) | 0x40;
        reviewIdBytes[8] = (reviewIdBytes[8]! & 0x3f) | 0x80;
        const reviewIdHex = bytesToHex(reviewIdBytes);
        const reviewId = `${reviewIdHex.slice(0, 8)}-${reviewIdHex.slice(8, 12)}-${reviewIdHex.slice(12, 16)}-${reviewIdHex.slice(16, 20)}-${reviewIdHex.slice(20)}`;
        const reviewRecords = deps.reviewRecords?.(ctx);
        if (!reviewInput.reviewRound && !reviewRecords) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:review.start' };
        const reviewRound = reviewInput.reviewRound ?? await reviewRecords!.start({ reviewId, title: 'Code review',
          subjectKind,
          sourceKind: ctx.actionCaller?.kind === 'workflowRun' ? 'workflow' : 'direct',
          ...(ctx.actionCaller?.kind === 'workflowRun' ? { workflowId: ctx.actionCaller.workflowId } : {}),
          ...(reviewInput.comparisonId ? { comparisonId: reviewInput.comparisonId } : {}),
          ...(comparisonCapture ? { comparisonCapture } : {}),
          reviewerIds: reviewReviewerIdsForStartV1(reviewInput), startedAt: Date.now(), signal: ctx.signal });
        const reviewGroupId = reviewRound.reviewId;
        const reviewLaunchOptions = executionRunDispatchOpts;
        const results = await fanoutStarts({
          keys: engineSelections.map(entry => entry.reviewerId),
          recordActionOutputDiagnostic: deps.recordActionOutputDiagnostic,
          startOne: async (reviewerId) => {
            const { selection, engineInput, connectedSelection, teamCredentialModel } = selectedById.get(reviewerId)!;
            const engineId = selection.engineId;
            const selectedItem = selectedReviewEngineItems.get(reviewerId);
            if (!selectedItem || selectedItem.disabled === true) {
              return {
                ok: false,
                errorCode: 'review_engine_unavailable',
                error: 'review_engine_unavailable',
                details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
              };
            }
            return startExecutionRunWithSelection(
              sessionId,
              {
                intent: engineInput.intent ?? 'review',
                ...(engineInput.roleId ? { roleId: engineInput.roleId } : {}),
                ...(engineInput.launchProfileId ? { launchProfileId: engineInput.launchProfileId } : {}),
                display: { groupId: reviewGroupId },
                ...(machineTarget?.project ? { cwd: machineTarget.project.directory }
                  : detached && typeof engineInput.cwd === 'string' ? { cwd: engineInput.cwd } : {}),
                ...(reviewInput.notifyParentOnCompletion !== undefined
                  ? { notifyParentOnCompletion: reviewInput.notifyParentOnCompletion }
                  : {}),
                backendTarget: normalizeExecutionBackendTargetValue(engineId),
                instructions: selection.includeSessionTranscript === true && transcript?.ok
                  ? `${instructions}\n\n${transcript.instructions}` : instructions,
                reviewOutputSelection: reviewInput.outputs ? { outputs: reviewInput.outputs, narrator } : null,
                ...(engineInput.childSelection ? { childSelection: engineInput.childSelection }
                  : sessionId === null && engineInput.modelId === undefined && engineInput.modelSelection === undefined && !teamCredentialModel
                    && connectedSelection.bindings === undefined && connectedSelection.defaultServiceIds.length === 0
                    && !engineInput.roleId && !engineInput.launchProfileId && !engineInput.profileId
                    && (!engineInput.intent || engineInput.intent === 'review') ? { childSelection: 'agentDefault' as const } : {}),
                ...(typeof engineInput.modelId === 'string' ? { modelId: engineInput.modelId } : {}),
                ...(engineInput.modelSelection !== undefined ? { modelSelection: engineInput.modelSelection } : {}),
                ...(engineInput.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: engineInput.sessionConfigOptionOverrides } : {}),
                ...(connectedSelection.bindings !== undefined ? { connectedServices: connectedSelection.bindings } : {}),
                ...(connectedSelection.defaultServiceIds.length > 0
                  ? { connectedServicesDefaultServiceIds: connectedSelection.defaultServiceIds }
                  : {}),
                permissionMode,
                ...(engineInput.approvalProfileId !== undefined ? { approvalProfileId: engineInput.approvalProfileId } : {}),
                retentionPolicy: selectedReviewEngineItems.get(reviewerId)?.retentionPolicy ?? 'resumable',
                runClass: continueSingleReview ? 'long_lived' : 'bounded',
                // Reviews should stream sidechain progress (and tool traffic) into the parent session.
                ioMode: 'streaming',
                ...(teamCredentialModel
                  ? {
                      modelId: teamCredentialModel.modelId,
                      teamCredentialModel,
                      ...(engineInput.teamCredentialSessionBindingConsent
                        ? { teamCredentialSessionBindingConsent: engineInput.teamCredentialSessionBindingConsent }
                        : {}),
                    }
                  : {}),
                launchOrigin: resolveExecutionRunLaunchOrigin(ctx),
                ...(engineInput.profileId && engineInput.profileSourceCustody
                  ? {
                      profileId: engineInput.profileId,
                      profileSourceCustody: engineInput.profileSourceCustody,
                    }
                  : {}),
                ...(engineInput.secretReferenceOverlay
                  ? { secretReferenceOverlay: engineInput.secretReferenceOverlay }
                  : {}),
                ...(!engineInput.intent || engineInput.intent === 'review' ? { intentInput: {
                  ...intentInputBase, engineId, reviewers: [selection],
                  engines: { [engineId]: selection.options ?? reviewInput.engines[engineId] ?? {} },
                  reviewRound, reviewReviewerId: reviewerId,
                  reviewRoundSettlement: reviewInput.reviewRoundSettlement ?? (engineIds.length === 1 ? 'execution' : 'workflow'),
                  ...(continueSingleReview ? { outputs: ['walkthrough'], narrator } : {}),
                } } : {}),
              },
              {
                ...reviewLaunchOptions,
                ...(ctx.agentStartWorkDepth !== undefined ? { workDepth: ctx.agentStartWorkDepth, agentStartContext: ctx.agentStartContext, workspaceWrites: ctx.agentStartWorkspaceWrites, sessionAgentSpawnPolicyV1: ctx.sessionAgentSpawnPolicyV1 } : {}),
              }, ctx,
            );
          },
        });

        if (!reviewInput.reviewRound && results.length > 0 && results.every(result => !result.ok
          && readExecutionRunStartRunCreation(result.details) === 'noRunCreated')) await reviewRecords!.settle({ ...reviewRound,
          outcome: ctx.signal?.aborted ? 'cancelled' : 'failed', finishedAt: Date.now(), runs: [],
          ...(ctx.signal?.aborted ? {} : { signal: ctx.signal }) });
        if (!narrationRequested) return { ok: true, result: { intent: 'review', sessionId, results, ...(reviewRound ? { reviewRound } : {}) } };
        const reviewRunIds = results.flatMap((item) => item.ok && typeof readRecord(item.result).runId === 'string'
          ? [String(readRecord(item.result).runId)] : []);
        if (reviewRunIds.length === 0) {
          return { ok: true, result: { intent: 'review', sessionId, results, ...(reviewRound ? { reviewRound } : {}),
            narration: { state: 'failed', errorCode: 'review_launch_failed', error: 'review_launch_failed' } } };
        }
        if (continueSingleReview) {
          return { ok: true, result: { intent: 'review', sessionId, results, ...(reviewRound ? { reviewRound } : {}), narration: {
            runId: reviewRunIds[0], comparisonId: reviewInput.comparisonId, reviewRunIds,
            mode: 'continued_review', state: 'collecting',
          } } };
        }
        const launchFailures = results.flatMap((item) => item.ok ? [] : [{
          engineId: selectedById.get(item.key)!.selection.engineId,
          errorCode: item.errorCode ?? 'execution_run_failed', error: item.error ?? 'execution_run_failed',
        }]);
        if (!deps.executionRunAction) return { ok: true, result: { intent: 'review', sessionId, results, ...(reviewRound ? { reviewRound } : {}),
          narration: { state: 'failed', errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.action' } } };
        let narration: unknown;
        try {
          const response = await deps.executionRunAction(sessionId, {
            runId: reviewRunIds[0], actionId: 'review.walkthrough', input: ReviewWalkthroughRequestSchema.parse({
              reviewRunIds, comparisonId: reviewInput.comparisonId, narrator,
              ...(launchFailures.length > 0 ? { launchFailures } : {}),
            }),
          }, executionRunDispatchOpts);
          const payload = readReviewRunActionPayload(response);
          const actionRecord = readRecord(payload);
          narration = actionRecord.ok === false ? { state: 'failed', ...actionRecord } : payload;
        } catch (error) {
          try {
            deps.recordActionOutputDiagnostic?.({ source: 'action.review.narration', phase: 'action.review.narration', issues: [],
              failureCause: projectActionFailureCauseV1(error, 'action.review.narration', { allowUnknownErrorCode: false }) });
          } catch { /* Diagnostics cannot replace the accepted review result. */ }
          narration = { state: 'failed', ...readFanoutStartError(error) };
        }
        return { ok: true, result: { intent: 'review', sessionId, results, ...(reviewRound ? { reviewRound } : {}), narration } };
      }
  return null;
}
