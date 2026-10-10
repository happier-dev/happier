import { randomUUID } from 'node:crypto';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema, ExecutionRunSendResponseSchema, readExecutionRunStartRunCreation } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { resolveExecutionRunInteractionAffordances } from '@happier-dev/protocol/execution/runs/interactionAffordances';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildReviewCommentsOutboundMessage } from '@happier-dev/protocol/messages/structured/reviewCommentsInput';
import { ScmDiffSummaryResultReadInputSchema, ScmDiffSummaryResultEditInputSchema, ScmDiffSummaryResultRevisionInputSchema, ScmDiffSummaryRefineInputSchema, ScmDiffSummaryAddOutputsInputSchema, ScmDiffSummaryDiscussInputSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import type { ScmActionExecute, ScmActionId, ScmDiffSummaryResultResponse, ScmDiffSummaryResultDeleteResponse, ScmDiffSummaryOutputKind, ScmComparison, ScmReviewedMarkResponse, ReviewCommentDraftMessageV1, ActionExecutorContext, ScmReviewExplanationRequester } from '@happier-dev/protocol';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { buildDiffSummaryPrompt } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/buildDiffSummaryPrompt';
import { presentScmDiffSummaryModelContext } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/presentScmDiffSummaryModelContext';
import { findingCitationInstructions, presentReviewFindingCitations } from '@/agent/executionRuns/profiles/review/reviewFindingCitations';

type ExecuteCanonicalAction = Parameters<ScmActionExecute>[0]['executeCanonicalAction'];
export type ScmDiffSummarySavedActionId = Extract<ScmActionId,
  `scm.diffSummary.result.${string}` | 'scm.diffSummary.refine' | 'scm.diffSummary.addOutputs' | 'scm.diffSummary.discuss'>;

/** Transport and model admission are boundaries; saved revisions remain the one machine owner. */
export async function executeScmDiffSummaryResultAction(params: Readonly<{
  actionId: ScmDiffSummarySavedActionId; input: unknown; cwd: string; sessionId?: string;
  executeCanonicalAction?: ExecuteCanonicalAction; signal?: AbortSignal;
  actionContext?: ActionExecutorContext;
  clearReviewedMarks?: (comparison: ScmComparison) => Promise<ScmReviewedMarkResponse>;
}>): Promise<ScmDiffSummaryResultResponse | ScmDiffSummaryResultDeleteResponse> {
  const request = ScmDiffSummaryResultReadInputSchema.parse({
    cwd: params.cwd, resultId: (params.input as { resultId: string }).resultId,
  });
  const scope = { ...request, ...(params.sessionId ? { sessionId: params.sessionId } : {}), ...(params.signal ? { signal: params.signal } : {}) };
  const store = scmDiffSummaryResultStore;
  if (params.actionId === 'scm.diffSummary.result.read') return store.read(scope);
  if (params.actionId === 'scm.diffSummary.result.edit') {
    const input = ScmDiffSummaryResultEditInputSchema.parse(params.input);
    return store.edit({ ...scope, expectedRevision: input.expectedRevision, edit: input.edit });
  }
  if (params.actionId === 'scm.diffSummary.result.undo' || params.actionId === 'scm.diffSummary.result.delete') {
    const input = ScmDiffSummaryResultRevisionInputSchema.parse(params.input);
    if (params.actionId === 'scm.diffSummary.result.undo') return store.undo({ ...scope, expectedRevision: input.expectedRevision });
    const saved = await store.read(scope);
    if (!saved.success) return saved;
    const deleted = await store.delete({ ...scope, expectedRevision: input.expectedRevision });
    if (!deleted.success || !params.clearReviewedMarks || !saved.result.output.comparison) return deleted;
    try {
      const cleanup = await params.clearReviewedMarks(saved.result.output.comparison);
      return { ...deleted, marksCleanup: cleanup.success ? { success: true } : { success: false, errorCode: cleanup.errorCode, error: cleanup.error } };
    } catch (error) {
      return { ...deleted, marksCleanup: { success: false, errorCode: 'reviewed_marks_unavailable', error: error instanceof Error ? error.message : 'Reviewed marks are unavailable' } };
    }
  }
  const read = await store.read(scope);
  if (!read.success) return read;
  const result = read.result;
  const input = params.actionId === 'scm.diffSummary.refine' ? ScmDiffSummaryRefineInputSchema.parse(params.input)
    : params.actionId === 'scm.diffSummary.addOutputs' ? ScmDiffSummaryAddOutputsInputSchema.parse(params.input)
      : ScmDiffSummaryDiscussInputSchema.parse(params.input);
  if (input.expectedRevision !== result.revision) return { success: false, errorCode: 'revision_conflict',
    error: 'The saved result changed. Reconcile the current revision before sending.', latestRevision: result.revision };
  const storedScope = await store.readStoredScope(scope);
  const sessionId = storedScope?.sessionId;
  const machineId = params.actionContext?.externalActionTarget?.kind === 'machine'
    ? params.actionContext.externalActionTarget.machineId : params.actionContext?.executionRunTargetMachineId;
  const runTarget = { sessionId: sessionId ?? null };
  const execute = params.executeCanonicalAction;
  if ((!sessionId && !machineId) || !execute) return { success: false, errorCode: 'discussion_unavailable', error: 'The saved generator target is unavailable.' };
  const previousRunId = result.output.runId;
  const observed = previousRunId ? await execute('execution.run.get', { ...runTarget, runId: previousRunId, includeStructured: true }).catch(() => null) : null;
  const parsedRun = observed?.ok ? ExecutionRunGetResponseSchema.safeParse(observed.result) : null;
  const run = parsedRun?.success ? parsedRun.data.run : null;
  const affordances = resolveExecutionRunInteractionAffordances(run);
  const discuss = params.actionId === 'scm.diffSummary.discuss' ? ScmDiffSummaryDiscussInputSchema.parse(input) : null;
  const outputs: readonly ScmDiffSummaryOutputKind[] = params.actionId === 'scm.diffSummary.refine'
    ? [ScmDiffSummaryRefineInputSchema.parse(input).output]
    : params.actionId === 'scm.diffSummary.addOutputs' ? ScmDiffSummaryAddOutputsInputSchema.parse(input).outputs
      : result.output.requestedOutputs ?? ['summary'];
  const stopIds = 'stopIds' in input ? input.stopIds : undefined;
  const reviewExplanation = params.actionId === 'scm.diffSummary.refine' ? ScmDiffSummaryRefineInputSchema.parse(input).reviewExplanation : undefined;
  const caller = params.actionContext?.actionCaller;
  const requestedBy: ScmReviewExplanationRequester = caller?.kind === 'plugin' ? { kind: 'plugin', id: caller.pluginId }
    : caller?.kind === 'automationRun' ? { kind: 'automation', id: caller.runId }
      : caller?.kind === 'workflowRun' ? { kind: 'workflow', id: caller.runId }
        : caller?.kind === 'session' ? { kind: 'agent', id: caller.sessionId }
          : params.actionContext?.authority === 'present_user' ? { kind: 'user',
            ...(params.actionContext.externalActionCredential?.accountId ? { id: params.actionContext.externalActionCredential.accountId } : {}) }
            : { kind: 'unknown' };
  const explanationRequest = reviewExplanation ? { ...reviewExplanation, requestedBy, requestedAtMs: Date.now() } : undefined;
  const selectedStops = stopIds ? result.output.outputs?.walkthrough?.value?.stops.filter(stop => stopIds.includes(stop.id)) : undefined;
  if (stopIds && selectedStops?.length !== stopIds.length) return { success: false, errorCode: 'invalid_edit', error: 'Selected stops are unavailable in the saved revision.' };
  const comparison = result.output.comparison;
  if (!comparison) return { success: false, errorCode: 'result_unavailable', error: 'Captured comparison evidence is unavailable.' };
  const selectedRefs = selectedStops ? new Set(selectedStops.flatMap(stop => stop.changeRefs)) : null;
  const scopedComparison: ScmComparison = selectedRefs ? { ...comparison, inventory: { ...comparison.inventory,
    files: comparison.inventory.files.flatMap(file => {
      const occurrences = file.occurrences.filter(change => selectedRefs.has(change.id));
      return occurrences.length > 0 ? [{ ...file, occurrences }] : [];
    }) } } : comparison;
  const instruction = reviewExplanation
    ? `Explain the selected findings, without changing walkthrough prose or giving a verdict. Return only reviewExplanations, one {stopId, markdown} per selected stop. ${ScmDiffSummaryRefineInputSchema.parse(input).instructions}`
    : params.actionId === 'scm.diffSummary.refine'
    ? `Refine the ${outputs[0]} output${stopIds ? ` for stops ${stopIds.join(', ')}` : ''}. ${ScmDiffSummaryRefineInputSchema.parse(input).instructions}\nPublish only the requested structured output; retain exact captured change references.${stopIds ? '\nReturn only the selected stops with unchanged stop IDs and exact selected change-ref coverage. Preserve their titles. Set otherChangeRefs to []. Unselected stops are preserved by the saved-result owner.' : ''}`
    : params.actionId === 'scm.diffSummary.addOutputs'
      ? `Add the requested outputs: ${outputs.join(', ')}. Use the saved comparison and existing outputs. Publish the requested structured outputs.`
      : discuss!.message;
  const citations = (await store.readStoredScope(scope))?.reviewFindingCitations ?? [];
  const context = `${instruction}\n${findingCitationInstructions}\nSaved result ${result.resultId}, revision ${result.revision}.\n${JSON.stringify(presentScmDiffSummaryModelContext(selectedStops
    ? { comparisonId: comparison.id, title: result.output.outputs?.walkthrough?.value?.title, stops: selectedStops, files: scopedComparison.inventory.files }
    : { comparisonId: comparison.id, outputs: result.output.outputs }, scopedComparison, citations))}`;
  const drafts: ReviewCommentDraftMessageV1[] = selectedStops?.flatMap(stop => scopedComparison.inventory.files.flatMap(file => file.occurrences.flatMap(change => {
    if (!stop.changeRefs.includes(change.id) || file.evidence.state !== 'available' || change.evidence?.state === 'unavailable') return [];
    const oldLine = change.before.lineCount > 0 && change.before.startLine > 0 ? change.before.startLine : null;
    const newLine = change.after.lineCount > 0 && change.after.startLine > 0 ? change.after.startLine : null;
    if (newLine === null && oldLine === null) return [];
    return [{ id: `${result.resultId}:${stop.id}:${change.alias}`, filePath: file.path, source: 'diff' as const,
      anchor: { kind: 'diffLine' as const, startLine: newLine ?? oldLine!, side: newLine === null ? 'before' as const : 'after' as const, oldLine, newLine },
      // Ranges prove coordinates, not selected bytes. Exact saved file evidence remains in context.
      snapshot: { selectedLines: [], beforeContext: [], afterContext: [] }, body: String(presentReviewFindingCitations(`${stop.title}\n${stop.explanationMarkdown}`, citations)), createdAt: Date.now() }];
  }))) ?? [];
  const reviewInput = selectedStops && sessionId ? buildReviewCommentsOutboundMessage({ sessionId, drafts, additionalMessage: context }) : null;
  const message = params.actionId === 'scm.diffSummary.discuss' ? reviewInput?.text ?? context
    : buildDiffSummaryPrompt({ metadata: result.output.metadata ?? { source: comparison.source, sourceKey: comparison.id }, comparison: scopedComparison, outputs, instructions: context,
      ...(reviewExplanation ? { reviewExplanation: true } : {}),
      files: scopedComparison.inventory.files.map(file => ({ path: file.path, changeKind: file.changeKind,
        unifiedDiff: file.evidence.unifiedDiff, ...(file.binary !== null ? { binary: file.binary } : {}),
        ...(file.evidence.state === 'unavailable' ? { description: file.evidence.reason } : {}) })) });
  if (discuss?.startNew || (!affordances.canSend && !affordances.canResume && params.actionId !== 'scm.diffSummary.discuss')) {
    // Saved admission retains provider binding; public run state intentionally exposes less configuration.
    const generator = result.generator ?? (run ? { backendTarget: readBackendTargetRefV2(run.backendTarget),
      ...(run.requestedConfiguration?.modelId ? { modelId: run.requestedConfiguration.modelId } : {}) } : undefined);
    if (!generator || !result.output.comparison) return { success: false, errorCode: 'discussion_unavailable', error: 'A proven generator selection is unavailable for a new conversation.' };
    const initialInputId = randomUUID();
    const explanationInputId = explanationRequest ? initialInputId : undefined;
    if (explanationInputId) {
      const begun = await store.beginInput({ ...scope, inputId: explanationInputId, expectedRevision: result.revision,
        outputs, ...(stopIds ? { stopIds } : {}), reviewExplanation: explanationRequest });
      if (!begun.success) return begun;
    }
    const started = await execute('execution.run.start', {
      ...runTarget, ...(!sessionId ? { machineId, cwd: scope.cwd } : {}),
      localInputId: initialInputId,
      kind: 'scm_diff_summary.v1', intent: 'scm_diff_summary', ...generator,
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      intentInput: { cwd: scope.cwd, ...(sessionId ? { sessionId } : {}), source: result.output.comparison.source, comparisonId: result.output.comparison.id,
        resultId: result.resultId, expectedRevision: result.revision, outputs, instructions: message,
        ...(previousRunId ? { seededFromRunId: previousRunId } : {}), ...(stopIds ? { stopIds } : {}),
        ...(explanationInputId ? { reviewExplanationInputId: explanationInputId } : {}) },
      waitForCompletion: false,
    }).catch(() => null);
    if (!started || !started.ok) {
      const rejected = started && !started.ok && readExecutionRunStartRunCreation(started.details) === 'noRunCreated';
      if (rejected && explanationInputId) await store.abandonInput({ ...scope, inputId: explanationInputId });
      return { success: false, errorCode: rejected ? 'admission_failed' : 'admission_unknown',
        error: 'The new generator admission did not confirm a created run.' };
    }
    const created = ExecutionRunStartResponseSchema.safeParse(started.result);
    if (!created.success) return { success: false, errorCode: 'admission_unknown', error: 'The new generator admission returned no run identity.' };
    const latest = await store.read(scope);
    return latest.success ? { ...latest, runId: created.data.runId, inputId: initialInputId,
      ...(previousRunId ? { seededFromRunId: previousRunId } : {}) } : latest;
  }
  if (!previousRunId || (!affordances.canSend && !affordances.canResume)) return { success: false,
    errorCode: 'discussion_unavailable', error: 'The generator cannot continue. Start a new conversation explicitly.' };
  const inputId = randomUUID();
  const begun = await store.beginInput({ ...scope, inputId, expectedRevision: input.expectedRevision, outputs, ...(stopIds ? { stopIds } : {}),
    ...(explanationRequest ? { reviewExplanation: explanationRequest } : {}) });
  if (!begun.success) return begun;
  const sent = await (sessionId
    ? execute('session.message.send', { sessionId, recipient: { kind: 'execution_run', runId: previousRunId }, message, localId: inputId,
      ...(reviewInput ? { metaOverrides: reviewInput.metaOverrides } : {}) })
    : execute('execution.run.send', { ...runTarget, runId: previousRunId, message, localInputId: inputId,
      ...(affordances.canResume ? { resume: true } : {}) })).catch(() => null);
  if (!sent || !sent.ok) return { success: false, errorCode: 'admission_unknown', error: 'The generator input admission is unconfirmed.' };
  if (!sessionId) {
    if (!ExecutionRunSendResponseSchema.safeParse(sent.result).success) return { success: false, errorCode: 'admission_unknown', error: 'The generator input admission is unconfirmed.' };
    return { ...begun, runId: previousRunId, inputId };
  }
  const admitted = SessionMessageSendResultV1Schema.safeParse(sent.result);
  if (!admitted.success || admitted.data.status === 'outcomeUnknown') return { success: false, errorCode: 'admission_unknown', error: 'The generator input admission is unconfirmed.' };
  if (admitted.data.status === 'rejected') {
    await store.abandonInput({ ...scope, inputId });
    return { success: false, errorCode: 'admission_failed', error: admitted.data.code };
  }
  if (admitted.data.status !== 'accepted' && admitted.data.status !== 'alreadyAccepted') return { success: false, errorCode: 'admission_failed', error: admitted.data.status };
  return { ...begun, runId: previousRunId, inputId };
}
