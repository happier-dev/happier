import { isActionFamilyId } from '../actionFamilies.js';
import { ReviewCommentActionIdV1Schema, ReviewCommentListActionRequestV1Schema, ReviewCommentListResponseV1Schema, type ReviewCommentListResponseV1 } from '../../../reviews/comments/actions.js';
import { resolveActionWorkflowSessionScopeV1 } from '../workflowSessionScope.js';
import { normalizeId } from '../inputReading.js';
import { ReviewFindingsApplyInputV1Schema } from '../../../reviews/reviewApplyV1.js';
import type { ReviewCommentV1 } from '../../../reviews/comments/v1.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import { ReviewCommentGetResponseV1Schema } from '../../../reviews/comments/actions.js';
import { buildAcceptedReviewFindingsForVerifyV1, REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1, renderReviewFindingsForVerifyV1 } from '../../../reviews/reviewFindingsApplyInputV1.js';
import { ReviewWalkthroughInputSchema, ReviewWalkthroughRequestSchema, ReviewExplainFindingsInputSchema, ReviewExplainFindingsRequestSchema, ReviewExplainFindingsRefinementSchema } from '../../../reviews/reviewNarration.js';
import { resolveSessionIdFromInput, resolveServerIdForExecutionRunScope } from '../sessionScope.js';
import { resolveExecutionRunLaunchOrigin, buildExecutionRunCallOptions, checkDetachedExecutionRunProtocolV2, normalizeExecutionBackendOptionValue, normalizeExecutionBackendTargetValue, resolveFanoutTeamCredentialModel, resolveFanoutConnectedServicesSelections, buildAvailableExecutionBackendOptionKeys, readReviewRunActionPayload, readFanoutStartError, fanoutStarts, classifyExecutionRunStartFailure } from '../executionRuns.js';
import { readRecord, hasOwn } from '../../../inputs/inputRecords.js';
import type { ReviewStartInput } from '../../../reviews/reviewStart.js';
import { createPermissionPolicyResult, resolveAgentExecutionRunPermission } from '../callerContext.js';
import { EXECUTION_RUN_ACTION_PERMISSION_MODES } from '../../executionRunActionPermissionMode.js';
import { tryNormalizeExecutionBackendOptionValue, readReviewNarratorOptions } from '../../../inputs/inputOptions.js';
import { resolveReviewNarratorPolicy } from '../../../reviews/reviewEngines.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { withExecutionRunStartFailureDetails } from '../../../execution/runs/responseSchemas.js';
import { type ActionId } from '../../actionIds.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';

export function reviewScopeForInput(input: unknown): 'paths' | undefined {
  const record = readRecord(input);
  return hasOwn(record, 'selectedPaths') || hasOwn(record, 'selectedFiles') ? 'paths' : undefined;
}

export async function dispatchReviewDispatch1(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'ctx' | 'parsed' | 'data'> & Readonly<{
  executeHostChild: (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, ctx, parsed, data, executeHostChild } = inv;

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
          // Caller-supplied projections never supply authority. Reconstruct it
          // from this host-derived invocation and authenticated accepted leaves.
          const workflowScope = await resolveActionWorkflowSessionScopeV1(actionId, ctx, deps);
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
          const apply = ReviewFindingsApplyInputV1Schema.parse(parsed.data);
          // SessionTarget preparation owns selector resolution; leaves accept only its exact address.
          if (typeof apply.sessionId !== 'string') return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const comments: ReviewCommentV1[] = [];
          for (const runId of new Set(apply.reviews.map(review => review.runId))) {
            let cursor: string | undefined;
            do {
              ctx.signal?.throwIfAborted();
              const result = await deps.reviewCommentAction({ actionId: 'reviews.comments.list',
                input: ReviewCommentListActionRequestV1Schema.parse({ sessionId: apply.sessionId, runId, includeHistory: true, ...(cursor ? { cursor } : {}) }),
                ...requestContext });
              const failure = readActionFailureEnvelope(result);
              if (failure) return failure;
              const page = ReviewCommentListResponseV1Schema.parse(result);
              comments.push(...page.items);
              cursor = page.cursor ?? undefined;
            } while (cursor !== undefined);
          }
          // A materialized finding can reuse an earlier round's canonical comment.
          for (const id of new Set(apply.reviews.flatMap(review => review.findings.flatMap(finding => finding.comment ? [finding.comment.id] : [])))) {
            if (comments.some(comment => comment.id === id)) continue;
            ctx.signal?.throwIfAborted();
            const result = await deps.reviewCommentAction({ actionId: 'reviews.comments.get', input: { commentId: id, includeHistory: true }, ...requestContext });
            const failure = readActionFailureEnvelope(result);
            if (failure) return failure;
            comments.push(ReviewCommentGetResponseV1Schema.parse(result).comment);
          }
          if (comments.some(comment => comment.sessionId !== apply.sessionId)) {
            return { ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' };
          }
          const findings = buildAcceptedReviewFindingsForVerifyV1(apply.reviews, comments);
          if (findings.length === 0) return { ok: true, result: { status: 'unchanged', commentIds: [] } };
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
                input: { ...request, ...(cursor ? { cursor } : {}) },
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
  executeHostChild: (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
  startExecutionRunWithSelection: (sessionId: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[0], input: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[1], opts: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[2], context: ActionExecutorContext) => ReturnType<NonNullable<ActionExecutorDeps['executionRunStart']>>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, parsed, ctx, executeHostChild, data, deps, startExecutionRunWithSelection } = inv;

      if (actionId === 'review.walkthrough' || actionId === 'review.explain_findings') {
        const input = actionId === 'review.walkthrough'
          ? ReviewWalkthroughInputSchema.parse(parsed.data)
          : ReviewExplainFindingsInputSchema.parse(parsed.data);
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
        if (!deps.reviewEnginesList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        const detached = readRecord(data.target).kind === 'detached'
          || (ctx.actionCaller?.kind === 'workflowRun' && data.sessionId === undefined);
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
        const workflowScope = ctx.actionCaller?.kind === 'workflowRun'
          ? await resolveActionWorkflowSessionScopeV1(actionId, ctx, deps) : null;
        ctx.signal?.throwIfAborted();
        const opts = workflowScope ? { ...baseOptions, workflowScope } : baseOptions;

        const reviewInput = data as ReviewStartInput;
        const engineIds = reviewInput.engineIds;
        const connectedSelections = resolveFanoutConnectedServicesSelections(reviewInput, engineIds);
        if (!connectedSelections.ok) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        const teamCredentialModel = resolveFanoutTeamCredentialModel(
          reviewInput as Readonly<Record<string, unknown>>,
          engineIds,
        );
        if (!teamCredentialModel.ok) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (
          reviewInput.teamCredentialSessionBindingConsent
          && reviewInput.teamCredentialSessionBindingConsent.sessionId !== sessionId
        ) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (reviewInput.profileId && engineIds.length !== 1) {
          return {
            ok: false,
            errorCode: 'execution_run_profile_requires_single_engine',
            error: 'execution_run_profile_requires_single_engine',
          };
        }
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
          || teamCredentialModel.selection !== null;
        if (detached || reviewInput.secretReferenceOverlay || runScopedAgentBindings) {
          const capability = await checkDetachedExecutionRunProtocolV2(
            deps,
            sessionId,
            executionRunOpts,
            {
              startAndWait: false,
              runScopedAgentBindings,
              secretReferenceOverlay: reviewInput.secretReferenceOverlay !== undefined,
            },
          );
          if (!capability.ok) return classifyExecutionRunStartFailure(capability, 'noRunCreated');
          executionRunDispatchOpts = capability.opts;
        }
        const {
          teamCredentialSessionBindingConsent: _teamCredentialSessionBindingConsent,
          secretReferenceOverlay: _secretReferenceOverlay,
          outputs: _outputs,
          narrator: _narrator,
          ...reviewIntentInput
        } = reviewInput;
        const intentInputBase = { ...reviewIntentInput, permissionMode };
        const reviewEngineInventory = await deps.reviewEnginesList({
          sessionId,
          ...(detached && executionRunDispatchOpts?.targetMachineId
            ? { machineId: executionRunDispatchOpts.targetMachineId } : {}),
          includeDisabled: false,
          ...(reviewScopeForInput(reviewInput) ? { scope: 'paths' as const } : {}),
        });
        const availableReviewEngineKeys = buildAvailableExecutionBackendOptionKeys(reviewEngineInventory);
        const narrationRequested = reviewInput.outputs?.includes('walkthrough') === true;
        const narratorOptions = readReviewNarratorOptions(reviewEngineInventory);
        const narrationPolicy = resolveReviewNarratorPolicy({
          selectedEngineIds: engineIds.map((engineId) => tryNormalizeExecutionBackendOptionValue(engineId) ?? engineId),
          engines: narratorOptions,
        });
        const narrator = reviewInput.narrator ?? (narrationPolicy.defaultNarratorEngineId
          ? { engineId: engineIds.find((engineId) => tryNormalizeExecutionBackendOptionValue(engineId) === narrationPolicy.defaultNarratorEngineId)! }
          : undefined);
        if (narrationRequested && !reviewInput.comparisonId) {
          return { ok: false, errorCode: 'review_narration_comparison_required', error: 'review_narration_comparison_required' };
        }
        if (narrationRequested && (!narrator || !narratorOptions.some((option) =>
          option.value === tryNormalizeExecutionBackendOptionValue(narrator.engineId)
          && option.disabled !== true && option.capabilities.structuredNarration))) {
          return { ok: false, errorCode: 'review_narrator_unavailable', error: 'review_narrator_unavailable' };
        }
        const originalModelId = teamCredentialModel.selection?.modelId ?? (typeof data.modelId === 'string' ? data.modelId : undefined);
        const continueSingleReview = narrationRequested && engineIds.length === 1 && !narrationPolicy.requiresSeparateNarrator
          && narrator !== undefined && normalizeExecutionBackendOptionValue(narrator.engineId) === normalizeExecutionBackendOptionValue(engineIds[0]!)
          && (narrator.modelId === undefined || narrator.modelId === originalModelId);

        const reviewGroupId = `review_${bytesToHex(randomBytes(16))}`;
        const results = await fanoutStarts({
          keys: engineIds,
          startOne: async (engineId) => {
            const normalizedBackendTargetKey = normalizeExecutionBackendOptionValue(engineId);
            const rawEngineId = normalizeId(engineId);
            if (
              !availableReviewEngineKeys.has(normalizedBackendTargetKey)
              && (!rawEngineId || !availableReviewEngineKeys.has(rawEngineId))
            ) {
              return {
                ok: false,
                errorCode: 'review_engine_unavailable',
                error: 'review_engine_unavailable',
                details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
              };
            }
            const connectedSelection = connectedSelections.selections.get(engineId)!;
            return startExecutionRunWithSelection(
              sessionId,
              {
                intent: data.intent ?? 'review',
                ...(typeof data.roleId === 'string' ? { roleId: data.roleId } : {}),
                ...(typeof data.launchProfileId === 'string' ? { launchProfileId: data.launchProfileId } : {}),
                display: { groupId: reviewGroupId },
                ...(machineTarget?.project ? { cwd: machineTarget.project.directory }
                  : detached && typeof reviewInput.cwd === 'string' ? { cwd: reviewInput.cwd } : {}),
                ...(reviewInput.notifyParentOnCompletion !== undefined
                  ? { notifyParentOnCompletion: reviewInput.notifyParentOnCompletion }
                  : {}),
                backendTarget: data.roleId && data.backendTarget ? data.backendTarget : normalizeExecutionBackendTargetValue(engineId),
                instructions,
                ...(reviewInput.childSelection ? { childSelection: reviewInput.childSelection }
                  : sessionId === null && data.modelId === undefined && data.modelSelection === undefined && !teamCredentialModel.selection
                    && connectedSelection.bindings === undefined && connectedSelection.defaultServiceIds.length === 0
                    && !reviewInput.roleId && !reviewInput.launchProfileId && !reviewInput.profileId
                    && (!data.intent || data.intent === 'review') ? { childSelection: 'agentDefault' as const } : {}),
                ...(typeof data.modelId === 'string' ? { modelId: data.modelId } : {}),
                ...(data.modelSelection !== undefined ? { modelSelection: data.modelSelection } : {}),
                ...(data.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: data.sessionConfigOptionOverrides } : {}),
                ...(connectedSelection.bindings !== undefined ? { connectedServices: connectedSelection.bindings } : {}),
                ...(connectedSelection.defaultServiceIds.length > 0
                  ? { connectedServicesDefaultServiceIds: connectedSelection.defaultServiceIds }
                  : {}),
                permissionMode,
                retentionPolicy: 'resumable',
                runClass: continueSingleReview ? 'long_lived' : 'bounded',
                // Reviews should stream sidechain progress (and tool traffic) into the parent session.
                ioMode: 'streaming',
                ...(teamCredentialModel.selection
                  ? {
                      modelId: teamCredentialModel.selection.modelId,
                      teamCredentialModel: teamCredentialModel.selection,
                      ...(reviewInput.teamCredentialSessionBindingConsent
                        ? { teamCredentialSessionBindingConsent: reviewInput.teamCredentialSessionBindingConsent }
                        : {}),
                    }
                  : {}),
                launchOrigin: resolveExecutionRunLaunchOrigin(ctx),
                ...(reviewInput.profileId && reviewInput.profileSourceCustody
                  ? {
                      profileId: reviewInput.profileId,
                      profileSourceCustody: reviewInput.profileSourceCustody,
                    }
                  : {}),
                ...(reviewInput.secretReferenceOverlay
                  ? { secretReferenceOverlay: reviewInput.secretReferenceOverlay }
                  : {}),
                ...(!data.intent || data.intent === 'review' ? { intentInput: {
                  ...intentInputBase, engineId,
                  ...(continueSingleReview ? { outputs: ['walkthrough'], narrator } : {}),
                } } : {}),
              },
              {
                ...executionRunDispatchOpts,
                ...(ctx.agentStartWorkDepth !== undefined ? { workDepth: ctx.agentStartWorkDepth, agentStartContext: ctx.agentStartContext, workspaceWrites: ctx.agentStartWorkspaceWrites, sessionAgentSpawnPolicyV1: ctx.sessionAgentSpawnPolicyV1 } : {}),
              }, ctx,
            );
          },
        });

        if (!narrationRequested) return { ok: true, result: { intent: 'review', sessionId, results } };
        const reviewRunIds = results.flatMap((item) => item.ok && typeof readRecord(item.result).runId === 'string'
          ? [String(readRecord(item.result).runId)] : []);
        if (reviewRunIds.length === 0) {
          return { ok: true, result: { intent: 'review', sessionId, results,
            narration: { state: 'failed', errorCode: 'review_launch_failed', error: 'review_launch_failed' } } };
        }
        if (continueSingleReview) {
          return { ok: true, result: { intent: 'review', sessionId, results, narration: {
            runId: reviewRunIds[0], comparisonId: reviewInput.comparisonId, reviewRunIds,
            mode: 'continued_review', state: 'collecting',
          } } };
        }
        const launchFailures = results.flatMap((item) => item.ok ? [] : [{
          engineId: item.key, errorCode: item.errorCode ?? 'execution_run_failed', error: item.error ?? 'execution_run_failed',
        }]);
        if (!deps.executionRunAction) return { ok: true, result: { intent: 'review', sessionId, results,
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
          narration = { state: 'failed', ...readFanoutStartError(error) };
        }
        return { ok: true, result: { intent: 'review', sessionId, results, narration } };
      }
  return null;
}
