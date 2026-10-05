import {
  ReviewWalkthroughRequestSchema, ReviewExplainFindingsRequestSchema,
  ReviewFollowUpV1Schema,
  ReviewPublicationEvidenceSchema,
  resolveEffectiveReviewFindingFollowUps, projectReviewFindingsOverlay,
  readExecutionRunStartRunCreation,
  type ReviewWalkthroughRequest, type ReviewFindingsOverlayReview,
  type ScmDiffSummaryReviewProvenance, type SessionInputAdmissionResultV1,
  type ReviewFindingsV2,
  type ReviewPublicationEvidence,
  AccountSettingsSchema,
  resolveReviewNarratorPolicy,
} from '@happier-dev/protocol';
import { buildReviewEngineInventoryItems } from '@/session/actions/inventory/buildReviewEngineInventoryItems';
import { readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { readWorktreeChangeFingerprint } from '@/scm/readWorktreeChangeFingerprint';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { prepareReviewWalkthroughTurn } from '@/agent/executionRuns/profiles/review/reviewWalkthroughTurn';
import { presentReviewFindingCitations } from '@/agent/executionRuns/profiles/review/reviewFindingCitations';
import { readRetainedReviewFindings } from '@/agent/reviews/normalize/readRetainedReviewFindings';
import { buildExecutionRunProfileStartParams } from './profileStart';
import { resolveExecutionRunLifecycle } from './resolveExecutionRunLifecycle';
import { resolveExecutionRunResumeBackendOptions } from './resolveExecutionRunResumeBackendOptions';
import { resolveExecutionRunRuntimeBackendTarget } from './backendTargets';
import { readScmDiffSummaryIntent } from './kinds/scmDiffSummary/publishSavedScmDiffSummaryTurn';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunEnsureResult } from './ensureExecutionRun';
import type { ExecutionRunActionResult, ExecutionRunManagerStartParams, ExecutionRunStartResult, ExecutionRunState } from './executionRunTypes';
import { assertExecutionRunStructuredOutputModelAllowed } from './structuredOutputAdmission';
import { readExecutionRunErrorCode } from './errors';

type Host = Readonly<{
  runId: string; input: unknown; cwd: string;
  runs: Map<string, ExecutionRunState>; controllers: ReadonlyMap<string, ExecutionRunController>;
  startRun: (params: ExecutionRunManagerStartParams) => Promise<ExecutionRunStartResult>;
  ensureRun: (runId: string) => Promise<ExecutionRunEnsureResult>;
  waitForTerminal: (runId: string, signal: AbortSignal) => Promise<void>;
  enqueueInput: (input: Readonly<{ runId: string; text: string; localId: string }>) => Promise<SessionInputAdmissionResultV1>;
  onStateUpdated: (runId: string) => void;
  failNarration: (runId: string, inputId: string | undefined, code: string, message: string) => Promise<void>;
}>;

function failure(errorCode: string, error: string): ExecutionRunActionResult { return { ok: false, errorCode, error }; }

/** Retain host publication receipts while applying full-identity finding follow-ups. */
function readEffectiveReviewFindings(run: ExecutionRunState, runs: ReadonlyMap<string, ExecutionRunState>): ReviewFindingsV2 | null {
  const payload = readRetainedReviewFindings(run);
  if (!payload) return null;
  const runRef = { runId: run.runId, callId: run.callId, backendId: run.backendId };
  const followUps = [...runs.values()].filter(candidate => candidate.sessionId === run.sessionId)
    .sort((a, b) => (a.finishedAtMs ?? a.startedAtMs) - (b.finishedAtMs ?? b.startedAtMs))
    .flatMap(candidate => {
      const parsed = candidate.structuredMeta?.kind === 'review_follow_up.v1'
        ? ReviewFollowUpV1Schema.safeParse(candidate.structuredMeta.payload) : null;
      return parsed?.success ? [parsed.data] : [];
    });
  const findings = resolveEffectiveReviewFindingFollowUps({ runRef,
    initialFindings: payload.findings, followUps }).findings;
  return { ...payload, findings: [...findings] };
}

/** The retained Run registry supplies findings, including full-identity follow-up state. */
function readReview(run: ExecutionRunState, runs: ReadonlyMap<string, ExecutionRunState>): ReviewFindingsOverlayReview
  & Pick<ReviewFindingsV2, 'reviewOutcome'> & ReviewPublicationEvidence {
  const input = readScmDiffSummaryIntent(run.intentInput);
  const narration = readScmDiffSummaryIntent(input.reviewNarration);
  const payload = readEffectiveReviewFindings(run, runs);
  const runRef = { runId: run.runId, callId: run.callId, backendId: run.backendId };
  const comparisonId = typeof input.comparisonId === 'string' ? input.comparisonId : undefined;
  const originalStatus = narration.reviewStatus;
  return { runRef, ...(comparisonId ? { comparisonId } : {}), findings: payload?.findings ?? [], hasOutput: payload !== null,
    status: originalStatus === 'succeeded' || originalStatus === 'failed' || originalStatus === 'cancelled' || originalStatus === 'timeout'
      ? originalStatus : run.status,
    ...(payload ? { ...ReviewPublicationEvidenceSchema.parse(payload), reviewOutcome: payload.reviewOutcome,
      findingsTruncated: payload.limits?.findingsTruncated === true,
      ...(payload.proposedComments
        ? { anchorsByFindingId: Object.fromEntries(payload.proposedComments.map(comment => [comment.findingId, comment.anchor])) } : {}) } : {}),
  };
}

function selectedRuns(host: Host, ids: readonly string[]): ExecutionRunState[] | null {
  const owner = host.runs.get(host.runId);
  if (!owner?.sessionId || !ids.includes(host.runId) || new Set(ids).size !== ids.length) return null;
  const selected = ids.map(id => host.runs.get(id));
  return selected.every((run): run is ExecutionRunState => Boolean(run && run.intent === 'review' && run.sessionId === owner.sessionId))
    ? selected : null;
}

async function provenance(host: Host, runs: readonly ExecutionRunState[], comparisonId: string,
  narrationMode: ScmDiffSummaryReviewProvenance['narrationMode'],
  launchFailures?: ReviewWalkthroughRequest['launchFailures']): Promise<ScmDiffSummaryReviewProvenance> {
  const current = await readWorktreeChangeFingerprint(host.cwd);
  const reviews = runs.map(run => readReview(run, host.runs));
  const comparisonFreshness = runs.some(run => {
    const input = readScmDiffSummaryIntent(run.intentInput);
    return (typeof input.comparisonId === 'string' && input.comparisonId !== comparisonId)
      || (typeof input.reviewedFingerprint === 'string' && current.kind === 'available' && input.reviewedFingerprint !== current.fingerprint);
  }) ? 'changed' : runs.every(run => {
    const input = readScmDiffSummaryIntent(run.intentInput);
    return input.comparisonId === comparisonId && typeof input.reviewedFingerprint === 'string'
      && current.kind === 'available' && input.reviewedFingerprint === current.fingerprint;
  }) ? 'unchanged' : 'unknown';
  return { narrationMode, comparisonFreshness, ...(launchFailures?.length ? { launchFailures } : {}), reviewedRuns: reviews.map(review => ({ ...review.runRef,
    ...ReviewPublicationEvidenceSchema.parse(review),
    status: review.status ?? 'failed', hasOutput: review.hasOutput, ...(review.reviewOutcome ? { reviewOutcome: review.reviewOutcome } : {}),
    ...(review.comparisonId ? { comparisonId: review.comparisonId } : {}) })) };
}

function findingsContext(host: Host, runs: readonly ExecutionRunState[], request: ReviewWalkthroughRequest): string {
  return JSON.stringify({ reviews: runs.map(run => readReview(run, host.runs)), launchFailures: request.launchFailures ?? [] });
}

function recordAdmission(host: Host, runId: string, disposition: SessionInputAdmissionResultV1): ExecutionRunActionResult | null {
  if (disposition.status === 'accepted' || disposition.status === 'alreadyAccepted') return null;
  const errorCode = disposition.status === 'outcomeUnknown' ? 'admission_unknown' : 'admission_failed';
  const run = host.runs.get(runId);
  if (run) {
    host.runs.set(runId, { ...run, error: { code: disposition.status === 'outcomeUnknown' ? 'execution_run_send_outcome_unknown' : errorCode,
      message: disposition.code } });
    host.onStateUpdated(runId);
  }
  return failure(errorCode, disposition.code);
}

async function admitPrepared(host: Host, runId: string, prepared: Awaited<ReturnType<typeof prepareReviewWalkthroughTurn>>,
  current: () => boolean): Promise<ExecutionRunActionResult | null> {
  if (!current()) return failure('execution_run_not_allowed', 'The narrator retired before input admission.');
  const run = host.runs.get(runId)!;
  host.runs.set(runId, { ...run, intentInput: prepared.intentInput });
  host.onStateUpdated(runId);
  let disposition: SessionInputAdmissionResultV1;
  try { disposition = await host.enqueueInput({ runId, text: prepared.instructions, localId: prepared.localId }); }
  catch { disposition = { status: 'outcomeUnknown', localId: prepared.localId, code: 'narration_input_admission_unknown' }; }
  const rejected = recordAdmission(host, runId, disposition);
  if (disposition.status === 'rejected') {
    await host.failNarration(runId, prepared.localId, 'admission_failed', disposition.code);
    const input = readScmDiffSummaryIntent(prepared.intentInput);
    if (typeof input.resultId === 'string') await scmDiffSummaryResultStore.abandonInput({ cwd: host.cwd,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}), resultId: input.resultId, inputId: prepared.localId });
  }
  return rejected;
}

export async function applyReviewWalkthroughAction(host: Host): Promise<ExecutionRunActionResult> {
  const parsed = ReviewWalkthroughRequestSchema.safeParse(host.input);
  if (!parsed.success) return failure('execution_run_invalid_action_input', 'Invalid walkthrough input.');
  const request = parsed.data;
  const runs = selectedRuns(host, request.reviewRunIds);
  if (!runs) return failure('review_context_unavailable', 'The selected review Runs do not belong to this Session.');
  const first = runs[0]!;
  host = { ...host, cwd: typeof readScmDiffSummaryIntent(first.intentInput).cwd === 'string'
    ? String(readScmDiffSummaryIntent(first.intentInput).cwd) : host.cwd };
  const captured = await readCapturedScmComparison({ cwd: host.cwd, comparisonId: request.comparisonId, sessionId: first.sessionId! }).catch(() => null);
  if (!captured) return failure('comparison_unavailable', 'The saved comparison is unavailable for this Session and repository.');
  const inventory = await buildReviewEngineInventoryItems({ accountSettings: first.runtimeSettings?.accountSettings
    ? AccountSettingsSchema.parse(first.runtimeSettings.accountSettings) : null });
  const policy = resolveReviewNarratorPolicy({ selectedEngineIds: runs.map(run =>
    inventory.find(engine => engine.backendId === run.backendId)?.value ?? run.backendId), engines: inventory });
  const firstEngine = runs.length === 1 && policy.defaultNarratorEngineId
    ? inventory.find(engine => engine.value === policy.defaultNarratorEngineId) : undefined;
  const incumbent = host.controllers.get(first.runId);
  const lifecycle = resolveExecutionRunLifecycle(first, incumbent ?? null);
  const continuationSelected = runs.length === 1 && Boolean(firstEngine)
    && readReview(first, host.runs).hasOutput
    && (!request.narrator || (request.narrator.engineId === firstEngine?.engineId
      && (!request.narrator.modelId || request.narrator.modelId === (first.launch?.modelId ?? first.effectiveEngine?.modelId))));
  if (continuationSelected && lifecycle.projection.state === 'current' && incumbent?.kind === 'backend' && incumbent.turnInFlight) {
    return failure('execution_run_busy', 'The reviewer is still processing its current input.');
  }
  const canContinue = continuationSelected && ((first.status !== 'running'
    && (lifecycle.projection.state === 'recoverable' || lifecycle.projection.state === 'recoverable_with_input'))
    || (first.status === 'running' && lifecycle.projection.state === 'current' && incumbent?.kind === 'backend'
      && incumbent.backend.interaction?.kind === 'retained_agent_session.v1' && !incumbent.turnInFlight));
  if (canContinue) {
    try {
      await assertExecutionRunStructuredOutputModelAllowed({
        backendTarget: first.backendTarget,
        modelId: first.launch?.modelId ?? first.effectiveEngine?.modelId,
        modelSelection: first.launch?.modelSelection,
        teamCredentialModel: first.launch?.teamCredentialModel,
        cwd: first.launch?.cwd ?? host.cwd,
        accountSettings: first.runtimeSettings?.accountSettings,
        runtimeDescriptorV1: first.launch?.runtimeDescriptorV1,
      });
    } catch (error) {
      return failure(readExecutionRunErrorCode(error) ?? 'model_structured_output_unsupported',
        error instanceof Error ? error.message : 'Structured output support is unavailable.');
    }
    host.runs.set(first.runId, { ...first, runClass: 'long_lived', ioMode: 'streaming' });
    const ensured = await host.ensureRun(first.runId);
    if (ensured.ok) {
      const basis = await provenance(host, runs, request.comparisonId, 'continued_review', request.launchFailures);
      const current = host.runs.get(first.runId)!;
      const effectiveFindings = readEffectiveReviewFindings(first, host.runs);
      const prepared = await prepareReviewWalkthroughTurn({ start: { ...buildExecutionRunProfileStartParams(current),
        intentInput: { ...readScmDiffSummaryIntent(first.intentInput), cwd: host.cwd, reviewNarration: { phase: 'writing', provenance: basis,
          reviewFindings: effectiveFindings ? [effectiveFindings] : [], reviewStatus: readReview(first, host.runs).status } } }, comparisonId: request.comparisonId,
        provenance: basis, findingsContext: findingsContext(host, runs, request) });
      const controller = host.controllers.get(first.runId);
      const failed = await admitPrepared(host, first.runId, prepared,
        () => Boolean(controller && host.controllers.get(first.runId) === controller && !controller.cancelled));
      const preparedInput = readScmDiffSummaryIntent(prepared.intentInput);
      return failed ?? { ok: true, result: { runId: first.runId, callId: first.callId, sidechainId: first.sidechainId,
        mode: 'continued_review', state: 'writing', comparisonId: request.comparisonId,
        comparison: captured.comparison, reviewRunIds: request.reviewRunIds,
        observation: { kind: 'review_walkthrough', comparisonId: request.comparisonId,
          afterRevision: preparedInput.expectedRevision, resultId: preparedInput.resultId } } };
    }
    if (ensured.resumeFailureKind !== 'permanent') return failure(ensured.errorCode, ensured.error);
    const unavailable = host.runs.get(first.runId);
    if (unavailable) host.runs.set(first.runId, { ...unavailable, runClass: first.runClass, ioMode: first.ioMode });
  }
  const selectedId = request.narrator ? resolveReviewNarratorPolicy({ selectedEngineIds: [request.narrator.engineId], engines: inventory }).defaultNarratorEngineId
    : policy.defaultNarratorEngineId;
  const selected = inventory.find(engine => engine.value === selectedId);
  if (!selected) return failure('review_narrator_required', 'Select an available structured narration engine.');
  const target = resolveExecutionRunRuntimeBackendTarget({ kind: 'builtInAgent', agentId: selected.backendId });
  if (!target) return failure('review_narrator_unavailable', 'The selected narrator target is unavailable.');
  const basis = await provenance(host, runs, request.comparisonId, 'seeded_narrator', request.launchFailures);
  const selectedReviewer = runs.find(run => run.backendId === selected.backendId);
  const launch = resolveExecutionRunResumeBackendOptions({ run: selectedReviewer ?? null });
  const { start: _reviewStart, workspaceWrites: _oldWrites, ...selection } = launch;
  let started: ExecutionRunStartResult;
  try { started = await host.startRun({ sessionId: first.sessionId, intent: 'scm_diff_summary', backendTarget: target,
    ...(selectedReviewer && !request.narrator?.modelId ? selection : {}),
    ...(request.narrator?.modelId ? { modelId: request.narrator.modelId } : {}),
    ...(first.runtimeSettings?.accountSettings ? { accountSettings: first.runtimeSettings.accountSettings } : {}),
    permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
    display: { title: 'Diff walkthrough', participantLabel: 'Reading diffs, not reviewing' },
    initialInput: { kind: 'deferred_session_pending' }, cwd: host.cwd,
    intentInput: { cwd: host.cwd, source: captured.comparison.source, comparisonId: captured.comparison.id, outputs: ['walkthrough'] },
    reviewNarration: { phase: 'writing', provenance: basis },
  }); } catch (error) {
    if (readExecutionRunErrorCode(error) === 'model_structured_output_unsupported'
      || readScmDiffSummaryIntent(error).code === 'model_structured_output_unsupported') {
      return failure('model_structured_output_unsupported', error instanceof Error ? error.message : 'Structured output support is unavailable.');
    }
    return failure(readExecutionRunStartRunCreation(readScmDiffSummaryIntent(error).details) === 'noRunCreated' ? 'admission_failed' : 'admission_unknown',
      'The narrator admission did not confirm a created Run.');
  }
  const collect = async (): Promise<void> => {
    const controller = host.controllers.get(started.runId);
    if (controller?.kind !== 'backend') return;
    const current = () => host.controllers.get(started.runId) === controller && !controller.cancelled
      && !controller.backend.getRuntimeLifetimeSignal().aborted;
    try {
      await controller.provisioningPromise;
      if (!current()) return;
      const signal = controller.backend.getRuntimeLifetimeSignal();
      await Promise.all(request.reviewRunIds.map(id => host.waitForTerminal(id, signal)));
      if (!current()) return;
      const latestRuns = selectedRuns(host, request.reviewRunIds);
      if (!latestRuns) throw new Error('The selected review state is unavailable.');
      const latestBasis = await provenance(host, latestRuns, request.comparisonId, 'seeded_narrator', request.launchFailures);
      const narrator = host.runs.get(started.runId)!;
      const prepared = await prepareReviewWalkthroughTurn({ start: buildExecutionRunProfileStartParams(narrator),
        comparisonId: request.comparisonId, provenance: latestBasis, findingsContext: findingsContext(host, latestRuns, request) });
      await admitPrepared(host, started.runId, prepared, current);
    } catch (error) {
      if (!current()) return;
      await host.failNarration(started.runId, undefined, 'review_narration_failed', error instanceof Error ? error.message : 'Narration preparation failed.');
      const run = host.runs.get(started.runId);
      if (run) { host.runs.set(started.runId, { ...run, error: { code: 'review_narration_failed',
        message: error instanceof Error ? error.message : 'Narration preparation failed.' } }); host.onStateUpdated(started.runId); }
    }
  };
  // The narrator's incumbent occurrence/lifetime owns collection and cancellation.
  void collect();
  return { ok: true, result: { ...started, mode: 'seeded_narrator', state: 'collecting', comparisonId: request.comparisonId,
    comparison: captured.comparison, reviewRunIds: request.reviewRunIds } };
}

/** Resolve exact current findings and matching stops; the Action executor admits the resulting refinement. */
export async function applyReviewExplainFindingsAction(host: Host): Promise<ExecutionRunActionResult> {
  const parsed = ReviewExplainFindingsRequestSchema.safeParse(host.input);
  if (!parsed.success) return failure('execution_run_invalid_action_input', 'Invalid finding explanation input.');
  const request = parsed.data;
  const runs = selectedRuns(host, request.reviewRunIds);
  if (!runs) return failure('review_context_unavailable', 'The selected reviews do not belong to this Session.');
  const saved = await scmDiffSummaryResultStore.read({ cwd: request.cwd, sessionId: runs[0]!.sessionId!, resultId: request.resultId });
  if (!saved.success) return failure(saved.errorCode, saved.error);
  if (saved.result.revision !== request.expectedRevision) return failure('revision_conflict', 'The walkthrough changed before finding explanation.');
  const comparison = saved.result.output.comparison;
  const walkthrough = saved.result.output.outputs?.walkthrough?.value;
  if (!comparison || !walkthrough) return failure('review_explanation_unavailable', 'The saved walkthrough is unavailable.');
  const overlay = projectReviewFindingsOverlay({ comparison, walkthrough, reviews: runs.map(run => readReview(run, host.runs)) });
  const targeted = request.findingIds.map(identity => overlay.entries.find(entry => entry.runRef.runId === identity.runId && entry.finding.id === identity.findingId));
  if (targeted.some(entry => !entry || entry.state !== 'mapped' || entry.stopIds.length === 0)) {
    return failure('review_finding_unmapped', 'A requested finding is unresolved, outdated or cannot be mapped to a walkthrough stop.');
  }
  const entries = targeted.flatMap(entry => entry ? [entry] : []);
  const stopIds = [...new Set(entries.flatMap(entry => entry.stopIds))];
  const storedScope = await scmDiffSummaryResultStore.readStoredScope({ cwd: request.cwd,
    sessionId: runs[0]!.sessionId!, resultId: request.resultId });
  const findingFacts = presentReviewFindingCitations(entries.map(entry => ({ runRef: entry.runRef, findings: [entry.finding] })),
    storedScope?.reviewFindingCitations ?? []);
  return { ok: true, result: { refinement: { actionId: 'scm.diffSummary.refine', input: {
    cwd: request.cwd, resultId: request.resultId, expectedRevision: request.expectedRevision,
    output: 'walkthrough', stopIds,
    reviewExplanation: { targets: stopIds.map(stopId => ({ stopId, findingRefs: entries.filter(entry => entry.stopIds.includes(stopId))
      .map(entry => ({ runId: entry.runRef.runId, findingId: entry.finding.id })) })) },
    instructions: ['Explain only these current review findings as separate finding explanation blocks. Do not replace walkthrough prose or provide a new verdict.',
      JSON.stringify(findingFacts), request.instructions].filter(Boolean).join('\n\n'),
  } } } };
}
