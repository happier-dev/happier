import {
  resolveExecutionRunIntentProfile,
  resolveExecutionRunIntentProfileFromCatalog,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import type { ReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import { materializeReviewFindings } from './materializeReviewFindings';
import { ReviewFindingsV2Schema, ReviewPublicationEvidenceSchema, ScmDiffSummaryResultErrorCodeSchema } from '@happier-dev/protocol';
import { readReviewNarration } from '@/agent/executionRuns/profiles/review/reviewWalkthroughTurn';
import { readScmDiffSummaryIntent } from './kinds/scmDiffSummary/publishSavedScmDiffSummaryTurn';

/** One host publisher for retained structured turns, independent of input transport. */
export async function publishExecutionRunTurn(args: Readonly<{
  runId: string;
  turnId: string;
  inputIds?: readonly string[];
  rawText: string;
  finishedAtMs: number;
  diagnostic?: Readonly<{ code: string; message?: string }>;
  started?: boolean;
  admittedInputId?: string;
  controller: ExecutionRunBackendController;
  controllers: ReadonlyMap<string, unknown>;
  runs: Map<string, ExecutionRunState>;
  profileCatalog?: ExecutionRunProfileContributionCatalog;
  sendAcp: ExecutionRunTranscriptPublisher;
  parentProvider: ACPProvider;
  reviewComments?: ReviewRunCommentService;
  onPublicStateUpdated?: (runId: string) => void;
  admitNextInput?: (input: Readonly<{ instructions: string; localId: string }>) => Promise<Readonly<{
    status: 'accepted' | 'rejected' | 'outcomeUnknown'; code?: string; message?: string;
  }>>;
}>): Promise<boolean> {
  const run = args.runs.get(args.runId);
  const current = () => args.controllers.get(args.runId) === args.controller && !args.controller.cancelled;
  if (!run || run.status !== 'running' || !current()) return false;
  const profile = args.profileCatalog
    ? resolveExecutionRunIntentProfileFromCatalog(args.profileCatalog, run.intent, run.profileId, run.profileSourceCustody)
    : resolveExecutionRunIntentProfile(run.intent);
  const params = {
    start: run,
    turnId: args.turnId,
    rawText: args.rawText,
    finishedAtMs: args.finishedAtMs,
    inputIds: args.inputIds ?? [args.controller.currentInputTurn, args.controller.lastInputTurn]
      .find((turn) => turn?.turnId === args.turnId)?.inputIds,
    ...(run.structuredMeta ? { previousStructuredMeta: run.structuredMeta } : {}),
  };
  let completion = args.admittedInputId ? await profile.onRetainedInputAdmitted?.({ start: run, localId: args.admittedInputId })
    : args.started ? await profile.onStarted?.(params) : args.diagnostic
    ? await profile.onTurnFailed?.({ ...params, diagnostic: args.diagnostic })
    : await profile.onTurnComplete?.(params);
  if (!completion || !current()) return false;
  const projected = await materializeReviewFindings({ run,
    toolResult: { output: completion.toolResultOutput, meta: completion.toolResultMeta },
    structuredMeta: completion.structuredMeta, expectFindings: !args.started && !args.admittedInputId && (completion.status === 'succeeded'
      || completion.structuredMeta?.kind === 'review_findings.v2' || completion.structuredMeta?.kind === 'review_findings.v1'),
    reviewComments: args.reviewComments,
    workflowRunId: args.controller.workflowRunId ?? args.controller.workflowObservation?.workflowRunId,
  });
  if (!current()) return false;
  completion = { ...completion, toolResultOutput: projected.toolResult.output,
    toolResultMeta: projected.toolResult.meta, structuredMeta: projected.structuredMeta };
  if (completion.nextInput && projected.structuredMeta?.kind === 'review_findings.v2') {
    const payload = ReviewFindingsV2Schema.safeParse(projected.structuredMeta.payload);
    const narration = readReviewNarration(completion.nextInput.intentInput);
    if (payload.success && narration) {
      const failed = projected.materialization && projected.materialization.status !== 'materialized';
      const receipts = ReviewPublicationEvidenceSchema.parse(payload.data);
      const provenance = { ...narration.provenance, reviewedRuns: narration.provenance.reviewedRuns.map((reviewed) =>
        reviewed.runId === run.runId && reviewed.callId === run.callId && reviewed.backendId === run.backendId
          ? { ...reviewed, ...receipts, status: failed ? 'failed' as const : reviewed.status,
            reviewOutcome: payload.data.reviewOutcome ?? reviewed.reviewOutcome } : reviewed) };
      const input = readScmDiffSummaryIntent(completion.nextInput.intentInput);
      const privateReview = readScmDiffSummaryIntent(input.reviewNarration);
      completion = { ...completion,
        toolResultMeta: { ...completion.toolResultMeta, reviewNarration: { phase: 'writing', provenance } },
        nextInput: { ...completion.nextInput, intentInput: { ...input, reviewNarration: {
          ...privateReview, reviewStatus: failed ? 'failed' : privateReview.reviewStatus, provenance, reviewFindings: [payload.data],
        } } },
      };
    }
  }
  if (run.sessionId !== null && profile.transcriptMaterialization !== 'none') {
    await args.sendAcp(args.parentProvider, {
      type: 'message', message: completion.summary, sidechainId: run.sidechainId,
    }, { meta: {
      ...(!args.started && !args.admittedInputId ? { runtimeTurnId: args.turnId } : {}),
      ...(completion.toolResultMeta ?? {}),
      ...(completion.structuredMeta ? { happier: completion.structuredMeta } : {}),
    } });
  }
  const latest = args.runs.get(args.runId);
  if (!latest || latest.status !== 'running' || !current()) return false;
  const hasPublicationNotice = completion.toolResultMeta?.scmResultUpdate !== undefined;
  const publicationRefusal = ScmDiffSummaryResultErrorCodeSchema.safeParse(
    completion.structuredMeta?.kind === 'scm_diff_summary.v1'
      ? readScmDiffSummaryIntent(completion.toolResultMeta?.scmResultUpdate).status : undefined,
  );
  const successfulCurrentPublication = !args.started && !args.admittedInputId
    && completion.structuredMeta !== undefined && !hasPublicationNotice
    && (!projected.materialization || projected.materialization.status === 'materialized');
  const clearPreviousOperationError = successfulCurrentPublication && (latest.error?.code === 'execution_run_send_outcome_unknown'
    || (completion.status === 'succeeded' && completion.structuredMeta?.kind === 'scm_diff_summary.v1'
      && !args.diagnostic && ScmDiffSummaryResultErrorCodeSchema.safeParse(latest.error?.code).success));
  const updated = {
    ...latest,
    summary: completion.summary,
    latestToolResult: completion.toolResultOutput,
    ...(publicationRefusal.success ? { error: { code: publicationRefusal.data, message: completion.summary } } : {}),
    ...(projected.materialization && projected.materialization.status !== 'materialized'
      ? { error: { code: 'review_comment_materialization_failed', message: 'Review findings could not all be persisted' } } : {}),
    ...(completion.structuredMeta ? { structuredMeta: completion.structuredMeta } : {}),
    ...(completion.updatedIntentInput !== undefined ? { intentInput: completion.updatedIntentInput } :
      completion.nextInput ? { intentInput: completion.nextInput.intentInput } : {}),
  };
  // A published failed model result settles uncertain native admission, but it
  // cannot erase a confirmed refusal or other failed saved-result operation.
  // Cached startup, refused publication and unrelated errors do not resolve it.
  if (clearPreviousOperationError) delete updated.error;
  args.runs.set(args.runId, updated);
  args.onPublicStateUpdated?.(args.runId);
  if (completion.nextInput && current()) {
    let admission: Readonly<{ status: 'accepted' | 'rejected' | 'outcomeUnknown'; code?: string; message?: string }> | undefined;
    try {
      // The host-authored continuation binds its revision before Pending can
      // reject it. Native delivery reuses this same input basis, never a newer one.
      const continuationStart = args.runs.get(args.runId);
      if (!continuationStart || !current()) return true;
      await profile.onBeforeRetainedInput?.({ start: continuationStart, localId: completion.nextInput.localId });
    } catch (error) {
      admission = { status: 'rejected', code: 'execution_run_input_preparation_unavailable',
        message: error instanceof Error ? error.message : 'Continuation preparation failed before admission' };
    }
    if (!current()) return true;
    if (!admission) try {
      admission = args.admitNextInput ? await args.admitNextInput({ instructions: completion.nextInput.instructions,
        localId: completion.nextInput.localId }) : { status: 'rejected', code: 'execution_run_not_allowed',
        message: 'Canonical retained continuation admission is unavailable' };
    } catch (error) {
      // A transport exception cannot prove that Pending/native admission did not happen.
      admission = { status: 'outcomeUnknown', message: error instanceof Error ? error.message : String(error) };
    }
    if (admission.status === 'accepted' && current()) {
      await publishExecutionRunTurn({ ...args, started: false, diagnostic: undefined, rawText: '',
        admittedInputId: completion.nextInput.localId });
    } else if (current()) {
      const code = admission.status === 'outcomeUnknown' ? 'execution_run_send_outcome_unknown'
        : admission.code ?? 'execution_run_not_allowed';
      const message = admission.message ?? `Analysis part admission ${admission.status}: ${admission.code ?? code}`;
      if (admission.status === 'rejected') {
        await publishExecutionRunTurn({ ...args, started: false, rawText: '',
          inputIds: [completion.nextInput.localId], diagnostic: { code, message } });
      }
      const latest = args.runs.get(args.runId);
      if (latest && current()) args.runs.set(args.runId, { ...latest, error: { code, message } });
      args.onPublicStateUpdated?.(args.runId);
    }
  }
  return true;
}
