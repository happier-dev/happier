import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import { randomUUID } from 'node:crypto';
import { bindScmRefineSavedSessionV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExecutionRunGetResponseSchema, ExecutionRunStartResponseSchema, ExecutionRunSendResponseSchema, readExecutionRunStartRunCreation } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionInputAdmissionRejectionCodeV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmissionRejectionV1';
import { resolveExecutionRunInteractionAffordances } from '@happier-dev/protocol/execution/runs/interactionAffordances';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ScmDiffSummaryResultReadInputSchema, ScmDiffSummaryResultEditInputSchema, ScmDiffSummaryResultRevisionInputSchema, ScmDiffSummaryRefineInputSchema, ScmDiffSummaryAddOutputsInputSchema, ScmDiffSummaryDiscussInputSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import type { ScmActionExecute, ScmActionId, ScmDiffSummaryResultResponse, ScmDiffSummaryResultDeleteResponse, ScmDiffSummaryOutputKind, ActionExecutorContext, ActionExecuteResult, ScmReviewExplanationRequester, ScmDiffSummaryGeneratorSelection } from '@happier-dev/protocol';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { buildDiffSummaryPrompt, buildDiffSummaryRefinementTask } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/buildDiffSummaryPrompt';
import { presentScmDiffSummaryModelContext, scopeScmDiffSummaryComparison } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/presentScmDiffSummaryModelContext';
import { findingCitationInstructions } from '@/agent/executionRuns/profiles/review/reviewFindingCitations';

type ExecuteCanonicalAction = Parameters<ScmActionExecute>[0]['executeCanonicalAction'];
export type ScmDiffSummarySavedActionId = Extract<ScmActionId,
  `scm.diffSummary.result.${string}` | 'scm.diffSummary.refine' | 'scm.diffSummary.addOutputs' | 'scm.diffSummary.discuss'>;

/** Transport and model admission are boundaries; saved revisions remain the one machine owner. */
export async function executeScmDiffSummaryResultAction(params: Readonly<{
  actionId: ScmDiffSummarySavedActionId; input: unknown; cwd: string; sessionId?: string;
  executeCanonicalAction?: ExecuteCanonicalAction; signal?: AbortSignal;
  actionContext?: ActionExecutorContext;
}>): Promise<ScmDiffSummaryResultResponse | ScmDiffSummaryResultDeleteResponse | Extract<ActionExecuteResult, { ok: false }>> {
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
    return store.delete({ ...scope, expectedRevision: input.expectedRevision });
  }
  const storedScope = await store.readStoredScope(scope);
  if (!storedScope) return { success: false, errorCode: 'result_not_found', error: 'Saved result is unavailable in this repository/session.' };
  const result = storedScope.result;
  const input = params.actionId === 'scm.diffSummary.refine' ? ScmDiffSummaryRefineInputSchema.parse(params.input)
    : params.actionId === 'scm.diffSummary.addOutputs' ? ScmDiffSummaryAddOutputsInputSchema.parse(params.input)
      : ScmDiffSummaryDiscussInputSchema.parse(params.input);
  if (input.expectedRevision !== result.revision) return { success: false, errorCode: 'revision_conflict',
    error: 'The saved result changed. Reconcile the current revision before sending.', latestRevision: result.revision };
  const sessionId = storedScope.sessionId;
  const machineId = params.actionContext?.externalActionTarget?.kind === 'machine'
    ? params.actionContext.externalActionTarget.machineId : params.actionContext?.executionRunTargetMachineId;
  const runTarget = { sessionId: sessionId ?? null };
  const execute = params.executeCanonicalAction;
  if ((!sessionId && !machineId) || !execute) return { success: false, errorCode: 'discussion_unavailable', error: 'The saved generator target is unavailable.' };
  const root = params.actionContext?.externalActionExecutionAuthorization;
  const scopedAuthorization = sessionId && root
    ? params.actionContext?.signExternalActionApprovalInput
      ? bindScmRefineSavedSessionV1({ authorization: root, sessionId, sign: params.actionContext.signExternalActionApprovalInput })
      : null : undefined;
  if (scopedAuthorization === null) return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
  const previousRunId = result.output.runId;
  const observed = previousRunId ? await execute('execution.run.get', { ...runTarget, runId: previousRunId, includeStructured: true }).catch(() => null) : null;
  const parsedRun = observed?.ok ? ExecutionRunGetResponseSchema.safeParse(observed.result) : null;
  const run = parsedRun?.success ? parsedRun.data.run : null;
  const affordances = resolveExecutionRunInteractionAffordances(run);
  const discuss = params.actionId === 'scm.diffSummary.discuss' ? ScmDiffSummaryDiscussInputSchema.parse(input) : null;
  const outputs: readonly ScmDiffSummaryOutputKind[] = params.actionId === 'scm.diffSummary.refine'
    ? [ScmDiffSummaryRefineInputSchema.parse(input).output]
    : params.actionId === 'scm.diffSummary.addOutputs' ? ScmDiffSummaryAddOutputsInputSchema.parse(input).outputs
      : discuss?.startNew ? [] : result.output.requestedOutputs ?? [];
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
  // A conversation's stop is context, not a restriction on a later requested merge.
  // Explicit targeted refinements retain their exact selected-output contract.
  const targetedStops = discuss ? undefined : selectedStops;
  const selectedRefs = targetedStops ? new Set(targetedStops.flatMap(stop => stop.changeRefs)) : null;
  const scopedComparison = scopeScmDiffSummaryComparison(comparison, selectedRefs);
  const userInstructions = params.actionId === 'scm.diffSummary.refine' ? ScmDiffSummaryRefineInputSchema.parse(input).instructions : discuss?.message;
  const outputLanguage = input.outputLanguage ?? result.generator?.outputLanguage;
  const taskInstructions = reviewExplanation
    ? 'Explain the selected findings, without changing walkthrough prose or giving a verdict. Return only reviewExplanations, one {stopId, markdown} per selected stop.'
    : params.actionId === 'scm.diffSummary.refine'
    ? `Refine the ${outputs[0]} output${stopIds ? ` for stops ${stopIds.join(', ')}` : ''}.\nPublish only the requested structured output; retain exact captured change references.${selectedStops ? '\n' + buildDiffSummaryRefinementTask({
      stops: selectedStops, editedStopIds: result.walkthroughProvenance?.stops.filter(stop => stop.titleEdited).map(stop => stop.stopId) ?? [],
    }) : ''}`
    : params.actionId === 'scm.diffSummary.addOutputs'
      ? `Add the requested outputs: ${outputs.join(', ')}. Use the saved comparison and existing outputs. Publish the requested structured outputs.`
      : '';
  const citations = storedScope.reviewFindingCitations ?? [];
  const evidenceContext = `Saved result ${result.resultId}, revision ${result.revision}.\n${JSON.stringify(presentScmDiffSummaryModelContext(targetedStops
    ? { comparisonId: comparison.id, title: result.output.outputs?.walkthrough?.value?.title, stops: targetedStops, files: scopedComparison.inventory.files }
    : { comparisonId: comparison.id, outputs: result.output.outputs, ...(selectedStops ? { selectedStopIds: stopIds } : {}) }, scopedComparison, citations))}`;
  const message = buildDiffSummaryPrompt({ metadata: result.output.metadata ?? { source: comparison.source, sourceKey: comparison.id }, comparison: scopedComparison, outputs,
      ...(discuss ? { conversation: true } : {}),
      instructions: userInstructions, taskInstructions: [taskInstructions, findingCitationInstructions].filter(Boolean).join('\n'), evidenceContext, outputLanguage,
      ...(reviewExplanation ? { reviewExplanation: true } : {}),
      files: scopedComparison.inventory.files.map(file => ({ path: file.path, changeKind: file.changeKind,
        unifiedDiff: file.evidence.unifiedDiff, ...(file.binary !== null ? { binary: file.binary } : {}),
        ...(file.evidence.state === 'unavailable' ? { description: file.evidence.reason } : {}) })) });
  if (discuss?.startNew || (!affordances.canSend && !affordances.canResume && params.actionId !== 'scm.diffSummary.discuss')) {
    const originalSelection = run?.resolvedSelection;
    const originalModelId = originalSelection?.modelSelection?.modelId ?? originalSelection?.modelId ?? run?.requestedConfiguration?.modelId;
    // Historical results can recover their exact observed Run selection. Team custody
    // is not representable by this saved generator and cannot become a native choice.
    const generator: ScmDiffSummaryGeneratorSelection | undefined = result.generator ?? (run && !originalSelection?.teamCredentialModel
      ? { backendTarget: readBackendTargetRefV2(run.backendTarget),
        ...(originalModelId ? { modelId: originalModelId } : {}),
        ...(originalSelection?.modelSelection ? { modelSelection: originalSelection.modelSelection } : {}),
        ...(originalSelection?.connectedServices !== undefined ? { connectedServices: originalSelection.connectedServices } : {}) } : undefined);
    if (!generator || !result.output.comparison) return { success: false, errorCode: 'discussion_unavailable', error: 'A proven generator selection is unavailable for a new conversation.' };
    const savedModelId = generator.modelSelection?.modelId ?? generator.modelId;
    // Historical saved generators omitted the credential route. Recover only an observed
    // original selection for this exact Agent/model/Provider, never a different saved choice.
    const sameOriginalAgentAndModel = run && originalSelection
      && buildBackendTargetKeyV2(generator.backendTarget) === buildBackendTargetKeyV2(readBackendTargetRefV2(run.backendTarget))
      && savedModelId !== undefined && savedModelId === (originalSelection.modelSelection?.modelId ?? originalSelection.modelId);
    if (sameOriginalAgentAndModel && originalSelection.teamCredentialModel
      && generator.modelSelection === undefined && generator.connectedServices === undefined) {
      return { success: false, errorCode: 'discussion_unavailable', error: 'A proven generator selection is unavailable for a new conversation.' };
    }
    const sameOriginalRoute = sameOriginalAgentAndModel && !originalSelection.teamCredentialModel
      && (generator.modelSelection?.providerConnectionId ?? null) === (originalSelection.modelSelection?.providerConnectionId ?? null);
    const connectedServices = generator.connectedServices !== undefined ? generator.connectedServices
      : sameOriginalRoute ? originalSelection.connectedServices : undefined;
    const { investigateSurroundingFiles, outputLanguage: _savedLanguage, ...engine } = generator;
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
      kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, intent: 'scm_diff_summary', ...engine,
      ...(connectedServices !== undefined ? { connectedServices } : {}),
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      intentInput: { cwd: scope.cwd, ...(sessionId ? { sessionId } : {}), source: result.output.comparison.source, comparisonId: result.output.comparison.id,
        resultId: result.resultId, expectedRevision: result.revision, outputs,
        ...(userInstructions ? { instructions: userInstructions } : {}),
        ...(outputLanguage ? { outputLanguage } : {}),
        ...(investigateSurroundingFiles === true ? { investigateSurroundingFiles: true } : {}),
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
  // Refine and Discuss explicitly recover their retained generator. Ordinary
  // Pending input never grants authority to reopen a terminal Run.
  if (sessionId && affordances.canResume
    && (params.actionId === 'scm.diffSummary.refine' || params.actionId === 'scm.diffSummary.discuss')) {
    const ensured = await execute('execution.run.ensure', { ...runTarget, runId: previousRunId, resume: true });
    // The canonical child Action already normalizes transport failures. Keep its
    // failure envelope intact rather than recoding it as a saved-result failure.
    if (!ensured.ok) return ensured;
  }
  const inputId = scopedAuthorization?.binding.requestId ?? randomUUID();
  const begun = await store.beginInput({ ...scope, inputId, expectedRevision: input.expectedRevision, outputs, ...(stopIds && !discuss ? { stopIds } : {}),
    ...(explanationRequest ? { reviewExplanation: explanationRequest } : {}) });
  if (!begun.success) return begun;
  const sent = await (sessionId
    ? execute('session.message.send', { sessionId, recipient: { kind: 'execution_run', runId: previousRunId }, message, localId: inputId,
        ...(params.actionId === 'scm.diffSummary.refine' ? { requestedAction: { v: 1, kind: 'send_now' } } : {}) },
      { sessionMessageDisplayText: userInstructions ?? taskInstructions,
        ...(scopedAuthorization ? { scmRefineInputAuthorization: scopedAuthorization } : {}),
        ...(discuss && stopIds ? { sessionMessageScmWalkthroughQuestion: { resultId: result.resultId, revision: result.revision, stopIds: [...stopIds] } } : {}) })
    : execute('execution.run.send', { ...runTarget, runId: previousRunId, message, localInputId: inputId,
      ...(affordances.canResume ? { resume: true } : {}) })).catch(() => null);
  if (!sent) return { success: false, errorCode: 'admission_unknown', error: 'The generator input admission is unconfirmed.' };
  // A transport failure does not prove that the input was never admitted.
  // Preserve its typed reason while retaining the uncertain input basis.
  if (!sent.ok) {
    const rejection = SessionInputAdmissionRejectionCodeV1Schema.safeParse(sent.errorCode);
    if (sent.errorCode === 'invalid_parameters' || rejection.success) {
      await store.abandonInput({ ...scope, inputId });
      return { success: false, errorCode: rejection.success ? rejection.data : 'invalid_parameters', error: sent.errorCode };
    }
    return { success: false, errorCode: 'admission_unknown', error: sent.errorCode ?? 'admission_unknown' };
  }
  if (!sessionId) {
    if (!ExecutionRunSendResponseSchema.safeParse(sent.result).success) return { success: false, errorCode: 'admission_unknown', error: 'The generator input admission is unconfirmed.' };
    return { ...begun, runId: previousRunId, inputId };
  }
  const admitted = SessionMessageSendResultV1Schema.safeParse(sent.result);
  if (!admitted.success) return { success: false, errorCode: 'admission_unknown', error: 'The generator input admission is unconfirmed.' };
  if (admitted.data.status === 'outcomeUnknown') return { success: false, errorCode: 'admission_unknown', error: admitted.data.code };
  if (admitted.data.status === 'rejected') {
    await store.abandonInput({ ...scope, inputId });
    return { success: false, errorCode: admitted.data.code, error: admitted.data.code };
  }
  if (admitted.data.status !== 'accepted' && admitted.data.status !== 'alreadyAccepted') return { success: false, errorCode: 'admission_failed', error: admitted.data.status };
  return { ...begun, runId: previousRunId, inputId };
}
