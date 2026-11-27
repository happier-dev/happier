import { isActionFamilyId } from '../actionFamilies.js';
import { deriveActionRequestActorV1 } from '../../actionRequestAttributionV1.js';
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
import { requiresReviewWorkflowCompositionV1, reviewReviewerIdentitiesForStartV1, reviewReviewerIdForSelectionV1, reviewReviewerIdsForStartV1, ReviewEngineReviewerSelectionV1Schema, type ReviewStartInput } from '../../../reviews/reviewStart.js';
import { SESSION_TRANSCRIPT_GET_MAX_LIMIT, SessionTranscriptGetResultSchema } from '../../specs/session/transcript.js';
import { createPermissionPolicyResult, resolveAgentExecutionRunPermission } from '../callerContext.js';
import { EXECUTION_RUN_ACTION_PERMISSION_MODES } from '../../executionRunActionPermissionMode.js';
import { tryNormalizeExecutionBackendOptionValue, readReviewNarratorOptions } from '../../../inputs/inputOptions.js';
import { ReviewEngineInventorySchema, refreshReviewNewRoundCostConsentV1, resolveReviewNarratorPolicy, reviewScopeForInput } from '../../../reviews/reviewEngines.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { readExecutionRunStartRunCreation, withExecutionRunStartFailureDetails } from '../../../execution/runs/responseSchemas.js';
import { REVIEW_SETTLE_ROUND_ACTION_ID_V1, type ActionId } from '../../actionIds.js';
import { REVIEW_HUMAN_ACTION_IDS_V1 } from '../../actionIdsReviewHumanV1.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import { createActionExecuteFailureError, isActionOutcomeUnknownErrorCodeV1, projectActionFailureCauseV1 } from '../../actionExecutionResult.js';
import { captureReviewComparisonV1, dispatchReviewRoundAction, readReviewSessionStatusV1, resolveReviewComparisonTargetV1, resolveReviewProjectSourceV1 } from './rounds.js';
import type { ScmComparison } from '../../../scm/comparison.js';
import { ScmStatusSnapshotResponseSchema } from '../../../scm/index.js';
import { prepareReviewRoundV1, preparedReviewTitleV1, resolveReviewComparisonSourceV1 } from '../../../reviews/prepareReviewRoundV1.js';
import { collectReviewRoundOutcomes, dispatchReviewSettlementAction } from './settlement.js';
import { invokeHostReviewedChildV1 } from '../deploymentRoleChild.js';
import type { JsonObject } from '../../../json/strictJsonValue.js';
import { SessionStatusResultSchema } from '../../../sessions/control/contract.js';
import { AgentsBackendsListOutputSchema } from '../../agentBackendInventory.js';
import { buildQualifiedPluginContributionKey } from '../../../plugins/contributionIdentity.js';
import { resolveBackendTargetKeyV2 } from '../../../backends/targets/backendTargetRefV2.js';
import { reviewStartExecutionRunCompletion } from '../../specs/executionRunCompletion.js';
import { readReviewStartEngineInventoryV1, selectReviewEngineItemV1, type ReviewEngineAdmissionV1 } from './engineAdmission.js';

export { reviewScopeForInput } from '../../../reviews/reviewEngines.js';

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
            return { ok: false, errorCode: 'review_comment_permission_denied', error: 'Review Workflow principal must match the admitted Workflow Run' };
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
            return { ok: false, errorCode: 'review_comment_permission_denied', error: 'Review Agent principal must identify the calling Session' };
          }
          // Review roots can be authored without a Session attachment. Only legacy
          // comment scopes default to the actor's Session; explicit filters stay intact.
          if (reviewCommentActionId === 'reviews.comments.list' && !data.reviewId) {
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
              error: 'Review plugin principal must be derived from the host-stamped plugin caller',
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
          if ('sessionId' in apply && typeof apply.sessionId !== 'string') return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const comments: ReviewCommentV1[] = [];
          const scopes = 'reviewId' in apply ? [{ reviewId: apply.reviewId }]
            : [...new Set(apply.reviews.map(review => review.runId))].map(runId => ({ sessionId: apply.sessionId, runId }));
          for (const scope of scopes) {
            let cursor: string | undefined;
            do {
              ctx.signal?.throwIfAborted();
              const result = await deps.reviewCommentAction({ actionId: 'reviews.comments.list',
                input: ReviewCommentListActionRequestV1Schema.parse({ ...scope, includeHistory: true,
                  ...('reviewId' in apply && apply.commentIds !== undefined ? { commentIds: apply.commentIds } : {}),
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
            return { ok: false, errorCode: 'review_comment_permission_denied', error: 'Review apply findings must belong to the requested Session' };
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
          const findings = buildAcceptedReviewFindingsForVerifyV1(reviews, comments, 'reviewId' in apply ? apply.commentIds : undefined);
          if (findings.length === 0) return { ok: true, result: { status: 'unchanged', commentIds: [] } };
          if ('reviewId' in apply && findings.some(finding => typeof comments.find(comment => comment.id === finding.comment?.id)?.body !== 'string')) {
            return { ok: false, errorCode: 'review_comment_encryption_material_unavailable', error: 'review_comment_encryption_material_unavailable' };
          }
          ctx.signal?.throwIfAborted();
          const prompt = `${REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1}\n\n${renderReviewFindingsForVerifyV1(findings)}`;
          if ('destination' in apply) return { ok: true, result: { status: 'prepared', prompt,
            commentIds: findings.flatMap(finding => finding.comment ? [finding.comment.id] : []),
          } };
          // Plugin delivery retains the existing host invocation identity; the message owner
          // still owns admission, local-id derivation and idempotency. Never mint a second id.
          const idempotencyKey = ctx.actionCaller?.kind === 'plugin' ? normalizeId(ctx.actionRequestId) : null;
          return await executeHostChild('session.message.send', { sessionId: apply.sessionId,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            message: prompt }, ctx);
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
  reviewEngineAdmission?: ReviewEngineAdmissionV1;
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
        const requestedBy = deriveActionRequestActorV1(ctx, 'review.start');
        // Workflow reviewers execute detached, but the admitted Session still owns the reviewed changes.
        const sourceSessionId = normalizeId(reviewInput.sessionId) || sessionId || undefined;
        // Plugin-mediated starts retain the creating Workflow in host context;
        // their immediate Action caller remains the plugin for authorization.
        const creatingWorkflowRunId = ctx.actionCaller?.kind === 'workflowRun'
          ? ctx.actionCaller.runId : ctx.executionRunWorkflowRunId;
        const workflowComposition = requiresReviewWorkflowCompositionV1(reviewInput);
        const needsWorkflowProject = workflowComposition && reviewReviewerIdsForStartV1(reviewInput).length > 0;
        let initialComparison: ScmComparison | undefined;
        let comparisonCwd = reviewInput.cwd ?? (sessionId && sessionId !== ctx.defaultSessionId ? undefined : ctx.agentStartContext?.baseline.directory);
        comparisonCwd ??= ctx.externalActionTarget?.kind === 'machine' ? ctx.externalActionTarget.project?.directory : undefined;
        const readComparisonSnapshot = async () => {
          const response = await executeHostChild('scm.status.snapshot', { ...(sessionId ? { sessionId } : {}),
            ...(comparisonCwd ? { cwd: comparisonCwd } : {}), detail: 'facts' }, ctx);
          if (!response.ok) throw createActionExecuteFailureError(response);
          const status = ScmStatusSnapshotResponseSchema.safeParse(response.result);
          if (!status.success) throw createActionExecuteFailureError({ ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
          if (!status.data.success) throw createActionExecuteFailureError({ ok: false,
            errorCode: status.data.errorCode ?? 'workspace_unavailable', error: status.data.error ?? 'workspace_unavailable' });
          comparisonCwd ??= status.data.snapshot?.repo.rootPath ?? undefined;
          return status.data.snapshot;
        };
        let selectedSource = reviewInput.reviewRound ? undefined : await resolveReviewComparisonSourceV1(reviewInput, readComparisonSnapshot);
        const needsComparison = !reviewInput.reviewRound && Boolean(selectedSource || reviewInput.comparisonId);
        const sourceSessionStatus = !reviewInput.reviewRound && sourceSessionId && deps.sessionStatusGet
          ? await readReviewSessionStatusV1(ctx, sourceSessionId, executeHostChild, true) : undefined;
        const comparisonTarget = needsComparison || needsWorkflowProject
          ? await resolveReviewComparisonTargetV1(deps, ctx, sessionId, actionId, executeHostChild,
            sessionId === sourceSessionId ? sourceSessionStatus : undefined) : undefined;
        if ((needsComparison || needsWorkflowProject) && !comparisonCwd) await readComparisonSnapshot();
        if (needsComparison && (!comparisonCwd || !comparisonTarget)) {
          return { ok: false, errorCode: 'workspace_unavailable', error: 'workspace_unavailable' };
        }
        // PR After observers need the captured head, including when reusing a retained capture.
        if (needsComparison && comparisonCwd && (!reviewInput.comparisonId || !selectedSource || selectedSource.kind === 'pullRequest')) {
          initialComparison = await captureReviewComparisonV1({ ctx, executeHostChild }, { cwd: comparisonCwd,
            ...(selectedSource ? { source: selectedSource } : {}),
            ...(reviewInput.comparisonId ? { comparisonId: reviewInput.comparisonId } : {}),
            ...(sessionId ? { sessionId } : {}) });
          selectedSource = initialComparison.source;
          reviewInput = { ...reviewInput, source: initialComparison.source, comparisonId: initialComparison.id };
        }
        const subjectKind = reviewInput.scmPullRequestReviewScope ? 'pull_request'
          : reviewInput.comparisonId ? 'comparison' : 'repository';
        const comparisonCapture = reviewInput.comparisonId && selectedSource && comparisonCwd && comparisonTarget
          ? { target: comparisonTarget, input: { cwd: comparisonCwd, source: selectedSource,
            comparisonId: reviewInput.comparisonId, ...(sessionId ? { sessionId } : {}) } } : undefined;
        // Private Action output only; public Automation evidence never includes outputs.
        const pr = initialComparison?.source.kind === 'pullRequest' ? initialComparison : undefined;
        const privateTarget = pr?.source.kind === 'pullRequest' && pr.endpoints.after
          ? { reviewTarget: { locator: { providerId: pr.source.locator.providerId,
            repository: pr.source.locator.repository, number: pr.source.locator.number }, headOid: pr.endpoints.after,
            ...(pr.pullRequest?.url === undefined ? {} : { url: pr.pullRequest.url }) } }
          : {};
        const reviewers = reviewInput.steps?.flatMap(step => step.reviewers) ?? reviewInput.reviewers;
        const transcriptReviewers = reviewers.filter(reviewer => reviewer.kind !== 'person' && reviewer.includeSessionTranscript === true);
        const workflowReviewRound = reviewInput.reviewRoundSettlement === 'workflow' ? reviewInput.reviewRound : undefined;
        const workflowReviewerId = reviewInput.reviewReviewerId;
        const completedLaunchRefusals = (results: readonly Readonly<{ key: string; ok: boolean; errorCode?: string }>[]) => ({
          ok: true as const,
          result: { ...readRecord(reviewStartExecutionRunCompletion.terminal({ intent: 'review', sessionId, results, reviewRound: workflowReviewRound }, [])), ...privateTarget },
        });
        const readReviewEngineInventory = async (dispatchOptions = opts) => {
          return readReviewStartEngineInventoryV1(deps, reviewInput, ctx, dispatchOptions?.targetMachineId);
        };
        let reviewEngineInventory: unknown = inv.reviewEngineAdmission?.inventory;
        if (transcriptReviewers.some(reviewer => reviewer.kind === 'engine')) {
          if (!deps.reviewEnginesList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          if (reviewEngineInventory === undefined || reviewEngineInventory === null) {
            const inventory = await readReviewEngineInventory();
            if (!inventory.ok) return inventory.result;
            reviewEngineInventory = inventory.inventory;
          }
          const defaultOptions = readReviewNarratorOptions(reviewEngineInventory);
          const profileOptions = readReviewNarratorOptions({ items: readRecord(reviewEngineInventory).selectionItems });
          if (reviewers.some((selection, index) => {
            if (selection.kind !== 'engine' || selection.includeSessionTranscript !== true) return false;
            const engineInput = { ...reviewInput, ...selection,
              ...(!workflowComposition ? ctx.reviewReviewerLaunchInputs?.[index] : undefined) };
            return selectReviewEngineItemV1(selection.engineId, engineInput.profileId,
              defaultOptions, profileOptions)?.capabilities.sessionTranscript !== true;
          })) return { ok: false, errorCode: 'invalid_input', error: 'The selected review profile does not accept ordinary instructions.' };
        }
        const transcript = transcriptReviewers.length > 0 && reviewInput.sourceSession
          ? await readReviewTranscriptInput(reviewInput.sourceSession, executeHostChild, ctx) : null;
        if (transcript && !transcript.ok) return transcript;
        const projectSourceId = reviewInput.reviewRound ? undefined
          : await resolveReviewProjectSourceV1(deps, ctx, sourceSessionId, serverId ?? undefined, comparisonCwd, executeHostChild, sourceSessionStatus);
        if (workflowComposition) {
          const selectedConsents: { consent: NonNullable<ReviewStartInput['teamCredentialSessionBindingConsent']>;
            model: NonNullable<ReviewStartInput['teamCredentialModel']> }[] = [];
          for (const reviewer of reviewers) {
            if (reviewer.kind !== 'engine') continue;
            const selection = { ...reviewInput, ...reviewer };
            const consent = selection.teamCredentialSessionBindingConsent;
            if (!consent) continue;
            // Root defaults can be overridden per reviewer. Validate their merged
            // selection with the same public owner before consuming its consent.
            const selected = ReviewEngineReviewerSelectionV1Schema.safeParse({ ...reviewer,
              teamCredentialModel: selection.teamCredentialModel, teamCredentialSessionBindingConsent: consent });
            if (!selected.success || !selected.data.teamCredentialModel || consent.sessionId !== sourceSessionId) {
              return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            }
            selectedConsents.push({ consent, model: selected.data.teamCredentialModel });
          }
          // Match attached Run admission: the source Session's access owner consumes
          // explicit visibility consent before the reviewers become detached Runs.
          for (const { consent, model } of selectedConsents) {
            const granted = await invokeHostReviewedChildV1({
              parent: { actionId, input: parsed.data as JsonObject }, context: ctx,
              child: { action: 'session.access.grant.set', role: 'session.access.grant.set', input: {
                sessionId: consent.sessionId, subject: { kind: 'team', teamId: consent.teamId },
                accessLevel: 'edit', canApprovePermissions: false, requiredTeamCredential: {
                  resourceId: model.resourceId, expectedResourceRevision: model.expectedResourceRevision,
                  deliveryMode: model.deliveryMode,
                },
              } },
              execute: (input, context, childId) => executeHostChild(childId, input, context),
            });
            if (!granted.ok) return granted;
          }
          const consumeConsent = (reviewer: ReviewStartInput['reviewers'][number]) => {
            if (reviewer.kind !== 'engine') return reviewer;
            const { teamCredentialSessionBindingConsent: _consent, ...selection } = reviewer;
            return selection;
          };
          const { teamCredentialSessionBindingConsent: _consent, ...admittedReviewInput } = reviewInput;
          reviewInput = { ...admittedReviewInput, reviewers: reviewInput.reviewers.map(consumeConsent),
            ...(reviewInput.steps ? { steps: reviewInput.steps.map(step => ({ ...step, reviewers: step.reviewers.map(consumeConsent) })) } : {}),
          };
          // Retain admitted ordinary reviewer prompts so Workflow leaves do not reread the source.
          const records = deps.reviewRecords?.(ctx);
          if (!records) return { ok: false, errorCode: 'review_record_unavailable', error: 'review_record_unavailable' };
          // Resolve display content once from each selected Session's own Home.
          // Later rounds retain these identities with the admitted roster in the Artifact.
          const sessionKey = (session: Readonly<{ serverId: string; sessionId: string }>) => JSON.stringify([session.serverId, session.sessionId]);
          const selectedSessions = new Map(reviewers.flatMap(reviewer => reviewer.kind === 'session'
            ? [[sessionKey(reviewer.session), reviewer.session] as const] : []));
          type ReviewerCatalog = { ok: true; items: ReturnType<typeof AgentsBackendsListOutputSchema.parse>['items'] }
            | Extract<ActionExecuteResult, { ok: false }>;
          const catalogs = new Map<string, Promise<ReviewerCatalog>>();
          const catalogFor = (serverId: string, machineId?: string | null) => {
            const key = JSON.stringify([serverId, machineId ?? null]);
            const cached = catalogs.get(key);
            if (cached) return cached;
            const read = (async (): Promise<ReviewerCatalog> => {
              const listed = await executeHostChild('agents.backends.list', { ...(machineId ? { machineId } : {}) }, { ...ctx, serverId });
              return listed.ok ? { ok: true, items: AgentsBackendsListOutputSchema.parse(listed.result).items } : listed;
            })();
            catalogs.set(key, read);
            return read;
          };
          const modelNames = new Map(await Promise.all(reviewers.flatMap(reviewer => reviewer.kind !== 'model' ? [] : [(async () => {
            const { executionTarget, agentTarget } = reviewer.launch;
            const targetKey = resolveBackendTargetKeyV2(agentTarget);
            // The catalog supplies copy only. Its availability does not decide whether to launch this reviewer.
            const catalog = await catalogFor(executionTarget.serverId, executionTarget.machineId);
            return [reviewer, catalog.ok ? catalog.items.find(item => item.targetKey === targetKey)?.label : undefined] as const;
          })()])));
          const sessionIdentities = new Map(await Promise.all([...selectedSessions].map(async ([key, session]) => {
            const context = { ...ctx, serverId: session.serverId };
            const response = await executeHostChild('session.status.get', { sessionId: session.sessionId, live: false }, context);
            if (!response.ok) throw createActionExecuteFailureError(response);
            const status = SessionStatusResultSchema.parse(response.result);
            if (status.session.id !== session.sessionId) throw createActionExecuteFailureError({
              ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' });
            const target = status.agentTarget;
            const agentId = target ? buildQualifiedPluginContributionKey(target.identity) : undefined;
            if (status.session.title || !target) return [key, { displayName: status.session.title, agentId }] as const;
            const catalog = await catalogFor(session.serverId, status.session.machineId);
            if (!catalog.ok) throw createActionExecuteFailureError(catalog);
            const item = catalog.items.find(item => {
              const candidate = item.agentTarget?.identity ?? item.identity;
              return candidate && buildQualifiedPluginContributionKey(candidate) === agentId
                && item.agentTarget?.definitionId === target.definitionId;
            });
            return [key, { displayName: item?.label, agentId }] as const;
          })));
          const composedRunId = globalThis.crypto.randomUUID();
          const { reviewRound } = await prepareReviewRoundV1({ reviewInput,
            ...(initialComparison ? { comparison: initialComparison } : {}),
            ...(comparisonCapture ? { comparisonCapture: comparisonCapture.input } : {}),
            reviewStart: { reviewId: globalThis.crypto.randomUUID(),
              ...(requestedBy ? { requestedBy } : {}),
              ...(projectSourceId ? { projectSourceId } : {}),
              subjectKind,
              sourceKind: creatingWorkflowRunId ? 'workflow' : 'direct',
              ...(ctx.actionCaller?.kind === 'workflowRun' ? { workflowId: ctx.actionCaller.workflowId } : {}),
              // The Workflow run a person watches: the calling run, else the run composed below.
              workflowRunId: creatingWorkflowRunId ?? composedRunId,
              ...(reviewInput.comparisonId ? { comparisonId: reviewInput.comparisonId } : {}),
              ...(comparisonCapture ? { comparisonCapture } : {}),
              ...(sourceSessionId ? { sourceSessionId } : {}),
              reviewerIds: reviewReviewerIdsForStartV1(reviewInput),
              ...reviewReviewerIdentitiesForStartV1(reviewInput, undefined,
                reviewer => sessionIdentities.get(sessionKey(reviewer.session)), reviewer => modelNames.get(reviewer)),
            },
          }, { reviewRecords: records, startedAt: Date.now(), signal: ctx.signal,
            captureComparison: request => captureReviewComparisonV1({ ctx, executeHostChild }, request) });
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
            return { ok: true, result: { ...privateTarget, intent: 'review', sessionId, reviewRound,
              reviewedFingerprint: null, results: [] } };
          }
          const { buildReviewStepsWorkflowV1 } = await import('../../../workflows/builtins/reviewAndConverge.js');
          const built = buildReviewStepsWorkflowV1(reviewInput, reviewRound, initialComparison, comparisonCapture?.input, transcript?.ok ? transcript.instructions : undefined);
          // The child Workflow consumes the same resolved Machine/workspace as
          // this Review; retain the original signed target for every effect.
          const workflowContext = { ...ctx,
            ...(workflowScope ? { workflowStartSessionScope: workflowScope } : {}),
            ...(comparisonTarget && comparisonCwd ? { workflowStartProject: comparisonTarget.project ?? {
              machineId: comparisonTarget.machineId, directory: comparisonCwd,
            } } : {}),
          };
          const started = await invokeHostReviewedChildV1({
            // Core admission already parsed these JSON operands.
            parent: { actionId, input: parsed.data as JsonObject }, context: workflowContext,
            child: { action: 'workflow.run.start', role: 'workflow.run.start', input: {
              runId: composedRunId, source: { kind: 'inline', definition: built.definition }, inputs: built.inputs,
              metadata: { title: preparedReviewTitleV1(reviewInput, initialComparison?.source ?? comparisonCapture?.input.source) },
            } as JsonObject },
            execute: (input, context, childId) => executeHostChild(childId, input, context),
          });
          if (!started.ok) {
            if (!isActionOutcomeUnknownErrorCodeV1(started.errorCode)) {
              await records.settle({ ...reviewRound, outcome: ctx.signal?.aborted ? 'cancelled' : 'failed',
                finishedAt: Date.now(), runs: [], ...(ctx.signal?.aborted ? {} : { signal: ctx.signal }) });
            }
            return started;
          }
          return { ok: true, result: { ...readRecord(started.result), ...privateTarget, reviewRound } };
        }
        if (!deps.reviewEnginesList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        // Retained graphs lack the fresh binding; a later round must still clear prior acknowledgement.
        if ((reviewInput.reviewRound?.roundOrdinal ?? 1) > 1 || typeof reviewInput.newRoundCostConsent === 'boolean') {
          if (reviewEngineInventory === undefined || reviewEngineInventory === null) {
            const inventory = await readReviewEngineInventory();
            if (!inventory.ok) return inventory.result;
            reviewEngineInventory = inventory.inventory;
          }
          reviewInput = refreshReviewNewRoundCostConsentV1(reviewInput,
            ReviewEngineInventorySchema.parse(reviewEngineInventory), reviewInput.newRoundCostConsent === true);
        }
        const engineSelections = reviewInput.reviewers.flatMap((selection, index) => selection.kind === 'engine'
          ? [{ selection, index, reviewerId: reviewInput.reviewReviewerId ?? reviewReviewerIdForSelectionV1(index) }] : []);
        const admittedEngineSelections = [];
        for (const entry of engineSelections) {
          const hostLaunch = ctx.reviewReviewerLaunchInputs?.[entry.index];
          const engineInput = { ...reviewInput, ...entry.selection, ...hostLaunch, intent: hostLaunch?.intent };
          const connections = resolveFanoutConnectedServicesSelections(engineInput, [entry.selection.engineId]);
          const modelTarget = engineInput.runnerAgentTarget
            ? resolveBackendTargetKeyV2(engineInput.runnerAgentTarget) : entry.selection.engineId;
          const team = resolveFanoutTeamCredentialModel(engineInput, [modelTarget]);
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
        if (reviewEngineInventory === undefined || reviewEngineInventory === null) {
          const inventory = await readReviewEngineInventory(executionRunDispatchOpts);
          if (!inventory.ok) return inventory.result;
          reviewEngineInventory = inventory.inventory;
        }
        const narratorOptions = readReviewNarratorOptions(reviewEngineInventory);
        const explicitProfileOptions = readReviewNarratorOptions({ items: readRecord(reviewEngineInventory).selectionItems });
        const selectedReviewEngineItems = inv.reviewEngineAdmission?.selectedItems
          ?? new Map(admittedEngineSelections.map(({ reviewerId, selection, engineInput }) => [reviewerId,
            selectReviewEngineItemV1(selection.engineId, engineInput.profileId, narratorOptions, explicitProfileOptions)] as const));
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
        const originalSelection = engineSelections[0]?.selection;
        const originalModelId = originalSelection?.teamCredentialModel?.modelId ?? originalSelection?.modelId
          ?? (typeof data.modelId === 'string' ? data.modelId : undefined);
        const continueSingleReview = narrationRequested && engineIds.length === 1 && !narrationPolicy.requiresSeparateNarrator
          && narrator !== undefined && normalizeExecutionBackendOptionValue(narrator.engineId) === normalizeExecutionBackendOptionValue(engineIds[0]!)
          && (narrator.modelId === undefined || narrator.modelId === originalModelId);
        const availableNarratorOptions = continueSingleReview
          ? [selectedReviewEngineItems.get(engineSelections[0]!.reviewerId)!]
          : narratorOptions;
        if (narrationRequested && (!narrator || !availableNarratorOptions.some((option) =>
          option.value === tryNormalizeExecutionBackendOptionValue(narrator.engineId)
          && option.disabled !== true && option.capabilities.structuredNarration))) {
          return { ok: false, errorCode: 'review_narrator_unavailable', error: 'review_narrator_unavailable' };
        }

        const reviewIdBytes = randomBytes(16);
        reviewIdBytes[6] = (reviewIdBytes[6]! & 0x0f) | 0x40;
        reviewIdBytes[8] = (reviewIdBytes[8]! & 0x3f) | 0x80;
        const reviewIdHex = bytesToHex(reviewIdBytes);
        const reviewId = `${reviewIdHex.slice(0, 8)}-${reviewIdHex.slice(8, 12)}-${reviewIdHex.slice(12, 16)}-${reviewIdHex.slice(16, 20)}-${reviewIdHex.slice(20)}`;
        const reviewRecords = deps.reviewRecords?.(ctx);
        if (!reviewInput.reviewRound && !reviewRecords) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:review.start' };
        const reviewRound = reviewInput.reviewRound ?? (await prepareReviewRoundV1({ reviewInput,
          ...(initialComparison ? { comparison: initialComparison } : {}),
          ...(comparisonCapture ? { comparisonCapture: comparisonCapture.input } : {}),
          reviewStart: { reviewId,
            ...(requestedBy ? { requestedBy } : {}),
            ...(projectSourceId ? { projectSourceId } : {}),
            subjectKind,
            sourceKind: creatingWorkflowRunId ? 'workflow' : 'direct',
            ...(ctx.actionCaller?.kind === 'workflowRun' ? { workflowId: ctx.actionCaller.workflowId } : {}),
            ...(creatingWorkflowRunId ? { workflowRunId: creatingWorkflowRunId } : {}),
            ...(reviewInput.comparisonId ? { comparisonId: reviewInput.comparisonId } : {}),
            ...(comparisonCapture ? { comparisonCapture } : {}),
            ...(sourceSessionId ? { sourceSessionId } : {}),
            reviewerIds: reviewReviewerIdsForStartV1(reviewInput),
            ...reviewReviewerIdentitiesForStartV1(reviewInput, (_selection, id) => selectedReviewEngineItems.get(id)?.label),
          },
        }, { reviewRecords: reviewRecords!, startedAt: Date.now(), signal: ctx.signal,
          captureComparison: request => captureReviewComparisonV1({ ctx, executeHostChild }, request) })).reviewRound;
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
              const errorCode = selectedItem?.unavailableCode ?? 'review_engine_unavailable';
              return {
                ok: false,
                errorCode,
                error: errorCode,
                details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
              };
            }
            return startExecutionRunWithSelection(
              sessionId,
              {
                intent: engineInput.intent ?? 'review',
                ...(engineInput.runnerAgentTarget ? { runnerAgentTarget: engineInput.runnerAgentTarget } : {}),
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
                ...(engineInput.childSelection ? { childSelection: engineInput.childSelection } : {}),
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

        if (results.length > 0 && results.every(result => !result.ok
          && readExecutionRunStartRunCreation(result.details) === 'noRunCreated')) {
          if (workflowReviewRound && !ctx.signal?.aborted) return completedLaunchRefusals(results);
          if (!reviewInput.reviewRound) await reviewRecords!.settle({ ...reviewRound,
            outcome: ctx.signal?.aborted ? 'cancelled' : 'failed', finishedAt: Date.now(), runs: [],
            reviewerOutcomes: collectReviewRoundOutcomes({ reviewRound, reviewerResults: [
              reviewStartExecutionRunCompletion.terminal({ intent: 'review', sessionId, results, reviewRound }, []),
            ] }).map(outcome => ctx.signal?.aborted
              ? { ...outcome, outcome: 'cancelled' as const } : outcome),
            ...(ctx.signal?.aborted ? {} : { signal: ctx.signal }) });
        }
        if (!narrationRequested) return { ok: true, result: { ...privateTarget, intent: 'review', sessionId, results, ...(reviewRound ? { reviewRound } : {}) } };
        const reviewRunIds = results.flatMap((item) => item.ok && typeof readRecord(item.result).runId === 'string'
          ? [String(readRecord(item.result).runId)] : []);
        if (reviewRunIds.length === 0) {
          return { ok: true, result: { ...privateTarget, intent: 'review', sessionId, results, ...(reviewRound ? { reviewRound } : {}),
            narration: { state: 'failed', errorCode: 'review_launch_failed', error: 'review_launch_failed' } } };
        }
        if (continueSingleReview) {
          return { ok: true, result: { ...privateTarget, intent: 'review', sessionId, results, ...(reviewRound ? { reviewRound } : {}), narration: {
            runId: reviewRunIds[0], comparisonId: reviewInput.comparisonId, reviewRunIds,
            mode: 'continued_review', state: 'collecting',
          } } };
        }
        const launchFailures = results.flatMap((item) => item.ok ? [] : [{
          engineId: selectedById.get(item.key)!.selection.engineId,
          errorCode: item.errorCode ?? 'execution_run_failed', error: item.error ?? 'execution_run_failed',
        }]);
        if (!deps.executionRunAction) return { ok: true, result: { ...privateTarget, intent: 'review', sessionId, results, ...(reviewRound ? { reviewRound } : {}),
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
        return { ok: true, result: { ...privateTarget, intent: 'review', sessionId, results, ...(reviewRound ? { reviewRound } : {}), narration } };
      }
  return null;
}
