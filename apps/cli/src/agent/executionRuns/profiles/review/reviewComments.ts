import { ReviewRoundBindingV1Schema, type ReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { createHash, randomUUID } from 'node:crypto';

import { buildReviewTriageTransitionRequestV1 } from '@happier-dev/protocol/reviews/comments/triageTransition';
import { createReviewFindingIdentityV1, createReviewFindingMessageHashV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewTriageOverlaySchema } from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import { stringifyReviewCommentPrincipalCanonicalJsonV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { ReviewCommentAnchorV1, ReviewCommentCreateRequestV1, ReviewCommentFingerprintV1, ReviewCommentScopeV1, ReviewCommentV1, ReviewCommentPrincipalHeaderV1, ReviewFinding, ReviewTriageOverlay, ReviewTriageStatus } from '@happier-dev/protocol';

import type { ReviewCommentActionExecutor } from '@/agent/reviews/comments/executor';
import { resolveReviewCommentSnapshot } from '@/agent/reviews/comments/snapshots';
import type { ExecutionRunActionResult, ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';

export type ReviewRunMaterialization = Readonly<{
  engineId: string;
  status: 'materialized' | 'partial' | 'failed';
  commentIds: readonly string[];
  comments: readonly Readonly<{ findingId: string; comment: Pick<ReviewCommentV1, 'id' | 'state' | 'serverRevision' | 'projectId' | 'workspace' | 'sessionId' | 'runId'> }>[];
  failures: readonly Readonly<{ findingId: string; errorCode: string }>[];
}>;

export type ReviewRunCommentService = ReturnType<typeof createReviewRunCommentService>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function errorCode(error: unknown): string {
  const code = record(error)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'review_comment_request_failed';
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
  reviewRecords?: Pick<ReviewRecordPortV1, 'settle'>;
  /** Host-bound live Session Agent; absence never falls back to Account user authority. */
  resolveTriageActor?: () => Extract<ReviewCommentPrincipalHeaderV1['actor'], { kind: 'agent' }> | null;
}>) {
  return {
    async settleRound(run: ExecutionRunState): Promise<void> {
      const input = record(run.intentInput);
      if (run.intent !== 'review' || input?.reviewRoundSettlement !== 'execution') return;
      const binding = ReviewRoundBindingV1Schema.safeParse(input.reviewRound);
      if (!binding.success) return;
      if (!deps.reviewRecords || !deps.scope.workspace) {
        throw Object.assign(new Error('Artifact content is unavailable'), { code: 'artifact_content_unavailable' });
      }
      const outcome = record(run.structuredMeta?.payload)?.reviewOutcome ?? record(run.latestToolResult)?.reviewOutcome;
      await deps.reviewRecords.settle({ ...binding.data,
        outcome: run.status === 'cancelled' ? 'cancelled' : outcome === 'partial' ? 'partial'
          : run.status === 'failed' || outcome === 'failed' ? 'failed' : 'completed',
        finishedAt: run.finishedAtMs ?? Date.now(), summary: run.summary,
        runs: [{ kind: 'execution', runId: run.runId, machineId: deps.scope.workspace.machineId,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}) }],
      });
    },
    async materialize(params: Readonly<{
      run: ExecutionRunState;
      findings: readonly ReviewFinding[];
      reviewedFingerprint: string | null;
      workflowRunId?: string;
      workflowScope?: NonNullable<ReviewCommentPrincipalHeaderV1['workflowScope']>;
    }>): Promise<ReviewRunMaterialization> {
      const engineId = params.run.backendId;
      const reviewGroupId = params.run.display?.groupId;
      const comments: Array<ReviewRunMaterialization['comments'][number]> = [];
      const failures: Array<{ findingId: string; errorCode: string }> = [];
      const input = record(params.run.intentInput);
      const cwd = params.run.launch?.cwd ?? deps.cwd;
      const comparison = typeof input?.comparisonId === 'string'
        ? await readCapturedScmComparison({ cwd, comparisonId: input.comparisonId,
          ...(params.run.sessionId ? { sessionId: params.run.sessionId } : {}) }).then(captured => captured.comparison, () => null)
        : undefined;
      for (const finding of params.findings) {
        try {
          if (!params.run.sessionId && !params.workflowRunId) throw Object.assign(new Error('Review scope is unavailable'), { code: 'review_comment_session_unavailable' });
          const scope = deps.scope.workspace && params.run.launch?.cwd
            ? { ...deps.scope, workspace: { ...deps.scope.workspace, path: params.run.launch.cwd } }
            : deps.scope;
          let anchor = findingAnchor(finding, params.run.runId);
          const resolvedSnapshot = await resolveReviewCommentSnapshot({ cwd, anchor, comparison });
          // Preserve the finding and its original location in the Review payload,
          // without inventing a code location when its evidence cannot be verified.
          if (!resolvedSnapshot && 'filePath' in anchor) anchor = { kind: 'finding', runId: params.run.runId, findingId: finding.id };
          else if (resolvedSnapshot?.kind === 'text' && resolvedSnapshot.diffContext
            && (anchor.kind === 'line' || anchor.kind === 'range')) anchor = { ...anchor, side: resolvedSnapshot.diffContext.side };
          const snapshot = resolvedSnapshot ?? { kind: 'none' as const, capturedAt: Date.now() };
          const fingerprint: ReviewCommentFingerprintV1 = {
            normalizedMessageHash: createReviewFindingMessageHashV1(finding.summary), engineId,
            ...(finding.startLine ? { lineRange: { startLine: finding.startLine, endLine: finding.endLine ?? finding.startLine } } : {}),
          };
          const findingIdentity = createReviewFindingIdentityV1({ path: finding.filePath, title: finding.title, fingerprint });
          const input: ReviewCommentCreateRequestV1 = {
            ...scope, ...(params.run.sessionId ? { sessionId: params.run.sessionId } : {}), runId: params.run.runId, engineId, findingId: finding.id,
            findingIdentity, findingSeverity: finding.severity, reviewedFingerprint: params.reviewedFingerprint,
            ...(reviewGroupId ? { metadata: { reviewGroupIds: [reviewGroupId] } } : {}),
            anchor, snapshot, body: [finding.title, finding.summary, finding.whyItMatters, finding.evidence, finding.suggestion].filter(Boolean).join('\n\n'),
            authorIntent: record(params.run.intentInput)?.reviewCommentAuthorIntent === 'open' ? 'open' : 'propose', fingerprint,
            linkedRefs: [{ kind: 'executionRun', id: params.run.runId }, ...(params.run.sessionId ? [{ kind: 'session' as const, id: params.run.sessionId }] : [])],
            clientMutationId: `review-finding:${createHash('sha256').update(`${params.run.runId}\0${findingIdentity}`).digest('hex')}`,
          };
          let comment = resultComment(await deps.execute('reviews.comments.create', input, {
            principal: {
              ...(params.workflowScope ? { workflowScope: params.workflowScope } : {}),
              actor: params.workflowRunId
                ? { kind: 'workflow', runId: params.workflowRunId }
                : { kind: 'agent', agentId: engineId, sessionId: params.run.sessionId! },
              currentIntent: {
                v: 1, kind: 'review_findings_materialization', actionId: 'reviews.comments.create',
                ...scope, ...(params.run.sessionId ? { sessionId: params.run.sessionId } : {}),
                ...(params.workflowRunId ? { workflowRunId: params.workflowRunId } : {}),
                runId: params.run.runId, callId: params.run.callId, agentId: engineId,
                effectBodySha256Base64Url: createHash('sha256').update(stringifyReviewCommentPrincipalCanonicalJsonV1(input)).digest('base64url'),
              },
            },
          }));
          const reRaised = comment.state === 'dismissed';
          if (reRaised || (reviewGroupId && !comment.metadata?.reviewGroupIds?.includes(reviewGroupId))) {
            const principal = { actor: params.workflowRunId ? { kind: 'workflow' as const, runId: params.workflowRunId } : { kind: 'agent' as const, agentId: engineId, sessionId: params.run.sessionId! },
              ...(params.workflowScope ? { workflowScope: params.workflowScope } : {}) };
            try {
              comment = resultComment(await deps.execute('reviews.comments.transition', {
                ...scope, commentId: comment.id, expectedState: comment.state, expectedServerRevision: comment.serverRevision,
                toState: reRaised ? 'open' : comment.state,
                ...(reRaised ? { reason: 'Re-raised by a later review.' } : {}),
                ...(reviewGroupId ? { reviewGroupId } : {}),
                clientMutationId: `review-materialized:${params.run.runId}:${comment.id}`,
              }, { principal }));
            } catch (error) {
              if (errorCode(error) !== 'review_comment_conflict') throw error;
              // Another engine in this fanout may have attached the same panel first.
              const current = resultComment(await deps.execute('reviews.comments.get', { commentId: comment.id }, { principal }));
              if ((reRaised && current.state === 'dismissed') || !reviewGroupId || !current.metadata?.reviewGroupIds?.includes(reviewGroupId)) throw error;
              comment = current;
            }
          }
          const { id, state, serverRevision, projectId, workspace, sessionId, runId } = comment;
          comments.push({ findingId: finding.id, comment: { id, state, serverRevision, ...(projectId ? { projectId } : {}), ...(workspace ? { workspace } : {}), ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}) } });
        } catch (error) {
          failures.push({ findingId: finding.id, errorCode: errorCode(error) });
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
        for (const finding of parsed.data.findings) {
          const retained = retainedFindings?.find((entry) => entry.id === finding.id);
          const retainedComment = record(retained?.comment);
          const commentId = typeof finding.commentId === 'string' ? finding.commentId
            : typeof retainedComment?.id === 'string' ? retainedComment.id : null;
          if (!commentId) return { ok: false, errorCode: 'review_comment_reference_unavailable', error: 'The finding has no persisted comment reference' };
          const current = resultComment(await deps.execute('reviews.comments.get', { commentId, includeHistory: true }, options));
          const updated = resultComment(await deps.execute('reviews.comments.transition', buildReviewTriageTransitionRequestV1({
            comment: current, decision: finding.status, ...(finding.comment ? { note: finding.comment } : {}),
            clientMutationId: `review-triage:${randomUUID()}`,
          }), options));
          comments.push({ ...updated, findingId: finding.id });
        }
        return { ok: true, result: { triage: projectReviewRunTriage(comments), commentIds: comments.map((comment) => comment.id) } };
      } catch (error) {
        return { ok: false, errorCode: errorCode(error), error: 'Review triage could not be persisted' };
      }
    },
  };
}
