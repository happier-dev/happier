import { createHash, randomUUID } from 'node:crypto';

import { createReviewRecordPortV1, ReviewRoundBindingV1Schema, type ReviewRoundBindingV1, type ReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { prepareReviewRoundV1 } from '@happier-dev/protocol/reviews/prepareReviewRoundV1';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { ScmComparisonSourceSchema, type ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { projectReviewQuestionSummaryV1, ReviewPublicationEvidenceSchema } from '@happier-dev/protocol/reviews/reviewPublicationEvidence';
import { buildReviewTriageTransitionRequestV1 } from '@happier-dev/protocol/reviews/comments/triageTransition';
import { createReviewFindingIdentityV1, createReviewFindingMessageHashV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewTriageOverlaySchema } from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import { ReviewFindingContentSchema, ReviewFindingSeveritySchema, reviewFindingFallsBelowThreshold } from '@happier-dev/protocol/reviews/ReviewFinding';
import { ReviewCommentActionOutputSchemasV1, ReviewCommentBulkTransitionResponseV1Schema, stringifyReviewCommentPrincipalCanonicalJsonV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { ActionExecuteFailure, ReviewCommentAnchorV1, ReviewCommentCreateRequestV1, ReviewCommentFingerprintV1, ReviewCommentScopeV1, ReviewCommentV1, ReviewCommentPrincipalHeaderV1, ReviewFinding, ReviewTriageOverlay, ReviewTriageStatus } from '@happier-dev/protocol';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { redactTranscriptSecrets } from '@/api/session/client/transport/transcriptSecretRedaction';

import { createCliReviewCommentActionExecutorFromCredentials, resolveCliReviewCommentPrincipalSigningContext, type ReviewCommentActionExecutor, type ReviewCommentCreateBatchItem } from '@/agent/reviews/comments/executor';
import { createAcknowledgedAccountArtifactTransport, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createReviewCommentSnapshotResolver } from '@/agent/reviews/comments/snapshots';
import type { ExecutionRunActionResult, ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { captureScmComparison, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { runWithScmExecutionRunAccountScope } from '@/agent/runtime/bridges/executionRun/profileStart';

export type ReviewRunMaterialization = Readonly<{
  engineId: string;
  status: 'materialized' | 'partial' | 'failed';
  commentIds: readonly string[];
  comments: readonly Readonly<{ findingId: string; comment: Pick<ReviewCommentV1, 'id' | 'state' | 'serverRevision' | 'reviewId' | 'projectId' | 'workspace' | 'sessionId' | 'runId'> }>[];
  failures: readonly Readonly<{ findingId: string; errorCode: string } & Partial<Omit<ActionExecuteFailure, 'ok'>>>[];
}>;

export type ReviewRunCommentService = ReturnType<typeof createReviewRunCommentService>;

type WorkflowReviewRequester = Pick<AdmittedRequesterSessionBootstrap, 'credentials' | 'serverHttpBaseUrl' | 'attribution'>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function resultComment(value: unknown): ReviewCommentV1 {
  return ReviewCommentV1Schema.parse(record(value)?.comment);
}

function findingAnchor(finding: ReviewFinding, runId: string): ReviewCommentAnchorV1 {
  if (!finding.filePath) return { kind: 'finding', runId, findingId: finding.id };
  if (!finding.startLine) return { kind: 'file', filePath: finding.filePath };
  return finding.endLine && finding.endLine !== finding.startLine
    ? { kind: 'range', filePath: finding.filePath, startLine: finding.startLine, endLine: finding.endLine }
    : { kind: 'line', filePath: finding.filePath, line: finding.startLine };
}

function storedTriageStatus(comment: ReviewCommentV1): ReviewTriageStatus | null {
  if (comment.reviewTriageStatus) return comment.reviewTriageStatus;
  return null;
}

export function projectReviewRunTriage(comments: readonly ReviewCommentV1[]): ReviewTriageOverlay {
  return { findings: comments.flatMap((comment) => {
    const status = storedTriageStatus(comment);
    if (!comment.findingId || !status) return [];
    const latest = comment.transitions.at(-1);
    return [{ id: comment.findingId, status, ...(latest?.reason ? { comment: latest.reason } : {}) }];
  }) };
}

/** Uses only the incumbent signed/encrypted ReviewComment transport and CAS owner. */
export function createReviewRunCommentService(deps: Readonly<{
  cwd: string;
  scope: ReviewCommentScopeV1;
  execute: ReviewCommentActionExecutor;
  reviewRecords?: Pick<ReviewRecordPortV1, 'start' | 'settle'>;
  /** Host-bound live Session Agent; absence never falls back to Account user authority. */
  resolveTriageActor?: () => Extract<ReviewCommentPrincipalHeaderV1['actor'], { kind: 'agent' }> | null;
}>) {
  // These ports spend the installed Account; a Run consumes its start admission.
  const requireInstalledCustody = (run: Pick<ExecutionRunState, 'installedReviewCustody'>) => {
    if (run.installedReviewCustody === 'refused') {
      throw Object.assign(new Error('Review custody was not admitted for this Run'), { code: 'review_comment_permission_denied' });
    }
  };
  return {
    async prepareNewRound(run: ExecutionRunState) {
      requireInstalledCustody(run);
      if (!deps.reviewRecords) throw Object.assign(new Error('Review records are unavailable'), { code: 'review_record_unavailable' });
      const reviewRecords = deps.reviewRecords;
      const reviewInput = ReviewStartInputSchema.parse(run.intentInput);
      const reviewRound = ReviewRoundBindingV1Schema.parse(reviewInput.reviewRound);
      const cwd = run.launch?.cwd ?? deps.cwd;
      const prepare = async () => {
        const captured = reviewInput.comparisonId ? await readCapturedScmComparison({ cwd,
          comparisonId: reviewInput.comparisonId, ...(run.sessionId ? { sessionId: run.sessionId } : {}) }) : null;
        const source = ScmComparisonSourceSchema.safeParse(reviewInput.source ?? captured?.comparison.source);
        const prepared = await prepareReviewRoundV1({ reviewInput, reviewRound,
          ...(captured ? { comparison: captured.comparison } : {}),
          ...(source.success ? { comparisonCapture: { cwd, source: source.data,
            ...(run.sessionId ? { sessionId: run.sessionId } : {}) } } : {}),
          previousRoundContext: {},
        }, { reviewRecords, cwd, sourceKind: 'direct', startedAt: Date.now(),
          ...(deps.scope.workspace ? { comparisonTarget: { kind: 'machine', machineId: deps.scope.workspace.machineId } } : {}),
          captureComparison: async input => (await captureScmComparison({ ...input,
            source: input.source!, // Round preparation always supplies the original selector for fresh capture.
            ...(run.sessionId ? { sessionId: run.sessionId } : {}) })).comparison,
        });
        return { ...prepared, reviewInput };
      };
      return await runWithScmExecutionRunAccountScope(run, prepare);
    },
    async failUnstartedRound(reviewRound: ReviewRoundBindingV1): Promise<void> {
      if (!deps.reviewRecords) throw Object.assign(new Error('Review records are unavailable'), { code: 'review_record_unavailable' });
      await deps.reviewRecords.settle({ ...reviewRound, outcome: 'failed', finishedAt: Date.now(), runs: [] });
    },
    async settleRound(run: ExecutionRunState, requester?: WorkflowReviewRequester): Promise<void> {
      const input = record(run.intentInput);
      if (run.intent !== 'review' || input?.reviewRoundSettlement !== 'execution') return;
      if (!requester) requireInstalledCustody(run);
      const binding = ReviewRoundBindingV1Schema.safeParse(input.reviewRound);
      if (!binding.success) return;
      if ((!requester && !deps.reviewRecords) || !deps.scope.workspace) {
        throw Object.assign(new Error('Artifact content is unavailable'), { code: 'artifact_content_unavailable' });
      }
      const evidence = ReviewPublicationEvidenceSchema.parse(record(run.structuredMeta?.payload) ?? record(run.latestToolResult) ?? {});
      const questionSummary = projectReviewQuestionSummaryV1(run.structuredMeta?.payload ?? run.latestToolResult);
      const outcome = run.status === 'cancelled' ? 'cancelled'
        : run.status === 'failed' || run.status === 'timeout' ? 'failed' : 'completed';
      const settlement = { ...binding.data,
        outcome,
        reviewerOutcomes: typeof input.reviewReviewerId === 'string' ? [{ key: input.reviewReviewerId, runId: run.runId,
          outcome, ...(questionSummary ? { questionSummary } : {}), reviewOutcome: evidence.reviewOutcome, quality: evidence.quality, materialization: evidence.materialization,
          startedAt: run.startedAtMs, ...(run.finishedAtMs === undefined ? {} : { finishedAt: run.finishedAtMs }) }] : [],
        finishedAt: run.finishedAtMs ?? Date.now(), summary: run.summary,
        runs: [{ kind: 'execution', runId: run.runId, machineId: deps.scope.workspace.machineId,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}) }],
      } satisfies Parameters<ReviewRecordPortV1['settle']>[0];
      if (requester) {
        await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, async () => {
          const store = createCredentialedAccountArtifactStore(requester.credentials);
          await createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(store)).settle(settlement);
        });
      } else {
        await deps.reviewRecords!.settle(settlement);
      }
    },
    async materialize(params: Readonly<{
      findings: readonly ReviewFinding[];
      reviewedFingerprint: string | null;
      comparison?: ScmComparison;
      review?: ReviewRoundBindingV1;
      workflowRunId?: string;
      workflowScope?: NonNullable<ReviewCommentPrincipalHeaderV1['workflowScope']>;
      workflowRequester?: WorkflowReviewRequester;
    }> & (Readonly<{ run: ExecutionRunState; session?: never }> | Readonly<{ run?: never; session: Readonly<{
      sessionId: string; localInputId: string; workflowRunId: string; stepId: string; invocationId: string;
      agentId: string; reviewerId: string; cwd?: string; intentInput?: unknown;
    }> }>)): Promise<ReviewRunMaterialization> {
      const engineId = params.run ? params.run.backendId : params.session.agentId;
      const requester = params.workflowRequester;
      if (params.run?.installedReviewCustody === 'refused' && !requester) return { engineId, status: 'failed', commentIds: [], comments: [],
        failures: params.findings.map(finding => ({ findingId: finding.id, errorCode: 'review_comment_permission_denied' })) };
      const producingRunId = params.run ? params.run.runId : params.session.workflowRunId;
      const producingCallId = params.run ? params.run.callId : params.session.localInputId;
      const producingSessionId = params.run ? params.run.sessionId : params.session.sessionId;
      const workflowRunId = params.run ? params.workflowRunId : params.session.workflowRunId;
      const intentInput = params.run ? params.run.intentInput : params.session.intentInput;
      const launchCwd = params.run ? params.run.launch?.cwd : params.session.cwd;
      const runReview = ReviewRoundBindingV1Schema.safeParse(record(intentInput)?.reviewRound);
      const review = params.review ?? (runReview.success ? runReview.data : undefined);
      const comments: Array<ReviewRunMaterialization['comments'][number]> = [];
      const pending: Array<ReviewCommentCreateBatchItem & { findingId: string }> = [];
      const failures: Array<ReviewRunMaterialization['failures'][number]> = [];
      const input = record(intentInput);
      const inlineThreshold = ReviewFindingSeveritySchema.safeParse(input?.inlineThreshold);
      const reviewerId = params.session?.reviewerId ?? (typeof input?.reviewReviewerId === 'string' ? input.reviewReviewerId : review ? null : engineId);
      const cwd = launchCwd ?? deps.cwd;
      const comparison = params.comparison ?? (typeof input?.comparisonId === 'string'
        ? await readCapturedScmComparison({ cwd, comparisonId: input.comparisonId,
          ...(producingSessionId ? { sessionId: producingSessionId } : {}) }).then(captured => captured.comparison, () => null)
        : undefined);
      const resolveSnapshot = createReviewCommentSnapshotResolver();
      const prepared = await Promise.all(params.findings.map(async finding => {
        try {
          if (!reviewerId) throw createActionExecuteFailureError({ ok: false, error: 'Review reviewer provenance is unavailable', errorCode: 'review_comment_invalid_request' });
          if (!review && !producingSessionId && !workflowRunId) throw createActionExecuteFailureError({ ok: false, error: 'Review scope is unavailable', errorCode: 'review_comment_session_unavailable' });
          const scope = deps.scope.workspace && launchCwd
            ? { ...deps.scope, workspace: { ...deps.scope.workspace, path: launchCwd } }
            : deps.scope;
          let anchor = findingAnchor(finding, producingRunId);
          const resolvedSnapshot = await resolveSnapshot({ cwd, anchor, comparison });
          // Preserve the finding and its original location in the Review payload,
          // without inventing a code location when its evidence cannot be verified.
          if (!resolvedSnapshot && 'filePath' in anchor) anchor = { kind: 'finding', runId: producingRunId, findingId: finding.id };
          else if (resolvedSnapshot?.kind === 'text' && resolvedSnapshot.diffContext
            && (anchor.kind === 'line' || anchor.kind === 'range')) anchor = { ...anchor, side: resolvedSnapshot.diffContext.side };
          const snapshot = resolvedSnapshot ?? { kind: 'none' as const, capturedAt: Date.now() };
          const fingerprint: ReviewCommentFingerprintV1 = {
            normalizedMessageHash: createReviewFindingMessageHashV1(finding.summary), engineId,
            ...(finding.startLine ? { lineRange: { startLine: finding.startLine, endLine: finding.endLine ?? finding.startLine } } : {}),
          };
          const findingIdentity = createReviewFindingIdentityV1({ path: finding.filePath, title: finding.title, fingerprint });
          const mutationSource = review
            ? JSON.stringify([review.reviewId, review.roundOrdinal, producingRunId, reviewerId,
              scope.workspace?.machineId ?? null, producingSessionId ?? null,
              ...(params.session ? [params.session.stepId, params.session.invocationId, params.session.localInputId] : []), findingIdentity])
            : `${producingRunId}\0${findingIdentity}`;
          const input: ReviewCommentCreateRequestV1 = {
            ...scope, ...(producingSessionId ? { sessionId: producingSessionId } : {}), runId: producingRunId, engineId, findingId: finding.id,
            findingIdentity, findingSeverity: finding.severity, reviewedFingerprint: params.reviewedFingerprint,
            ...(finding.scopeAttribution === undefined ? {} : { scopeAttribution: finding.scopeAttribution }),
            ...(finding.extensions === undefined ? {} : { extensions: finding.extensions }),
            finding: ReviewFindingContentSchema.parse({ ...finding,
              publicationPlacement: inlineThreshold.success && reviewFindingFallsBelowThreshold(finding.severity, inlineThreshold.data)
                ? 'summary' : undefined,
            }),
            ...(review ? { reviewId: review.reviewId, appearance: { roundOrdinal: review.roundOrdinal,
              runId: producingRunId, reviewerId,
              ...(scope.workspace ? { machineId: scope.workspace.machineId } : {}),
              ...(producingSessionId ? { sessionId: producingSessionId } : {}) } } : {}),
            anchor, snapshot, body: [finding.title, finding.summary, finding.whyItMatters, finding.evidence, finding.suggestion].filter(Boolean).join('\n\n'),
            authorIntent: record(intentInput)?.reviewCommentAuthorIntent === 'open' ? 'open' : 'propose', fingerprint,
            linkedRefs: [...(comparison?.source.kind === 'pullRequest' && comparison.pullRequest?.url
              ? [{ kind: 'pullRequest' as const, url: comparison.pullRequest.url }] : []), ...(params.run ? [{ kind: 'executionRun' as const, id: producingRunId }] : []), ...(producingSessionId ? [{ kind: 'session' as const, id: producingSessionId }] : [])],
            clientMutationId: `review-finding:${createHash('sha256').update(mutationSource).digest('hex')}`,
          };
          return { pending: { findingId: finding.id, input,
            principal: {
              ...(params.workflowScope ? { workflowScope: params.workflowScope } : {}),
              actor: workflowRunId
                ? { kind: 'workflow', runId: workflowRunId }
                : producingSessionId ? { kind: 'agent', agentId: engineId, sessionId: producingSessionId }
                  : { kind: 'executionRun', agentId: engineId, runId: producingRunId },
              currentIntent: {
                v: 1, kind: 'review_findings_materialization', actionId: 'reviews.comments.create',
                ...scope, ...(producingSessionId ? { sessionId: producingSessionId } : {}),
                ...(workflowRunId ? { workflowRunId: workflowRunId } : {}),
                runId: producingRunId, callId: producingCallId, agentId: engineId,
                effectBodySha256Base64Url: createHash('sha256').update(stringifyReviewCommentPrincipalCanonicalJsonV1(input)).digest('base64url'),
              },
            },
          } satisfies ReviewCommentCreateBatchItem & { findingId: string } };
        } catch (error) {
          const failure = normalizeActionExecutorThrownError(error, 'review.comments.materialize');
          return { failure: { findingId: finding.id, ...failure, error: redactTranscriptSecrets(failure.error) } };
        }
      }));
      for (const item of prepared) {
        if (item.pending) pending.push(item.pending);
        else if (item.failure) failures.push(item.failure);
      }
      if (pending.length) {
        try {
          const createBatch = async (execute: ReviewCommentActionExecutor) => {
            if (!execute.createBatch) throw createActionExecuteFailureError({ ok: false, error: 'Review Comment batch transport is unavailable', errorCode: 'review_comment_request_failed' });
            return await execute.createBatch(pending);
          };
          const results = requester
            ? await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, () => createBatch(createCliReviewCommentActionExecutorFromCredentials({
              credentials: requester.credentials,
              resolvePrincipalSigningContext: () => resolveCliReviewCommentPrincipalSigningContext(requester.attribution.machineId),
            })))
            : await createBatch(deps.execute);
          for (const [index, result] of results.entries()) {
            const finding = pending[index]!;
            if (!result.ok) {
              const { ok: _ok, ...failure } = result;
              failures.push({ findingId: finding.findingId, ...failure });
              continue;
            }
            const comment = result.comment;
            const { id, state, serverRevision, reviewId, projectId, workspace, sessionId, runId } = comment;
            comments.push({ findingId: finding.findingId, comment: { id, state, serverRevision, ...(reviewId ? { reviewId } : {}), ...(projectId ? { projectId } : {}), ...(workspace ? { workspace } : {}), ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}) } });
          }
        } catch (error) {
          const failure = normalizeActionExecutorThrownError(error, 'review.comments.materialize');
          failures.push(...pending.map(finding => ({ findingId: finding.findingId, ...failure, error: redactTranscriptSecrets(failure.error) })));
        }
      }
      return {
        engineId, status: failures.length === 0 ? 'materialized' : comments.length > 0 ? 'partial' : 'failed',
        commentIds: [...new Set(comments.map((entry) => entry.comment.id))], comments, failures,
      };
    },
    async triage(_runId: string, input: unknown, retainedFindings?: readonly ReviewFinding[]): Promise<ExecutionRunActionResult> {
      const parsed = ReviewTriageOverlaySchema.safeParse(input);
      if (!parsed.success) return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid triage overlay' };
      try {
        const actor = deps.resolveTriageActor?.();
        if (!actor) return { ok: false, errorCode: 'review_comment_principal_unavailable', error: 'The Session review principal is unavailable' };
        const options = { principal: { actor } };
        const comments: ReviewCommentV1[] = [];
        const targets = parsed.data.findings.map(finding => {
          const retained = retainedFindings?.find((entry) => entry.id === finding.id);
          const retainedComment = record(retained?.comment);
          const commentId = typeof finding.commentId === 'string' ? finding.commentId
            : typeof retainedComment?.id === 'string' ? retainedComment.id : null;
          return { finding, commentId };
        });
        if (targets.some(target => !target.commentId)) return { ok: false, errorCode: 'review_comment_reference_unavailable', error: 'The finding has no persisted comment reference' };
        if (!targets.length) return { ok: true, result: { triage: projectReviewRunTriage([]), commentIds: [] } };
        const listed = await deps.execute('reviews.comments.list', { commentIds: [...new Set(targets.map(target => target.commentId!))], includeHistory: true, allPages: true }, options);
        const currentById = new Map(ReviewCommentActionOutputSchemasV1['reviews.comments.list'].parse(listed).items.map(comment => [comment.id, comment]));
        const requests = [];
        for (const { finding, commentId } of targets) {
          const current = currentById.get(commentId!) ?? resultComment(await deps.execute('reviews.comments.get', { commentId, includeHistory: true }, options));
          currentById.set(current.id, current);
          requests.push(buildReviewTriageTransitionRequestV1({ comment: current, decision: finding.status,
            ...(finding.comment ? { note: finding.comment } : {}), clientMutationId: `review-triage:${randomUUID()}` }));
        }
        const commonFields = ({ commentId: _id, expectedServerRevision: _revision, clientMutationId: _mutation, ...fields }: typeof requests[number]) => fields;
        const first = requests[0]!;
        const common = commonFields(first);
        if (requests.length > 1 && currentById.size === requests.length
          && requests.every(request => stringifyReviewCommentPrincipalCanonicalJsonV1(commonFields(request)) === stringifyReviewCommentPrincipalCanonicalJsonV1(common))) {
          const result = ReviewCommentBulkTransitionResponseV1Schema.parse(await deps.execute('reviews.comments.bulkTransition', {
            ...common, commentIds: requests.map(request => request.commentId),
            expectedServerRevisions: Object.fromEntries(requests.map(request => [request.commentId, request.expectedServerRevision])),
            clientMutationId: `review-triage:${randomUUID()}`,
          }, options));
          if (result.failed.length) throw createActionExecuteFailureError({ ok: false, ...result.failed[0]! });
          const updatedById = new Map(result.updated.map(comment => [comment.id, comment]));
          for (const { finding, commentId } of targets) comments.push({ ...ReviewCommentV1Schema.parse(updatedById.get(commentId!)), findingId: finding.id });
        } else for (const { finding, commentId } of targets) {
          const current = currentById.get(commentId!)!;
          const updated = resultComment(await deps.execute('reviews.comments.transition', buildReviewTriageTransitionRequestV1({
            comment: current, decision: finding.status, ...(finding.comment ? { note: finding.comment } : {}),
            clientMutationId: `review-triage:${randomUUID()}`,
          }), options));
          comments.push({ ...updated, findingId: finding.id });
          currentById.set(updated.id, updated);
        }
        return { ok: true, result: { triage: projectReviewRunTriage(comments), commentIds: comments.map((comment) => comment.id) } };
      } catch (error) {
        const failure = normalizeActionExecutorThrownError(error, 'review.comments.triage');
        return { ok: false, ...failure, error: redactTranscriptSecrets(failure.error) };
      }
    },
  };
}
