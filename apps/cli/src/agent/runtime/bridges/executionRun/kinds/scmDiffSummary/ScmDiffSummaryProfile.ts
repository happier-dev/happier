import { ExecutionRunScmDiffSummaryInputV1Schema, EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import { ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryModelOutputSchema, ScmDiffSummaryOutputKindSchema, ScmDiffSummaryMetadataSchema, ScmDiffSummaryFailureReasonCodeSchema, normalizeScmDiffSummaryModelOutput } from '@happier-dev/protocol/scm/diffSummary';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ScmDiffSummaryGeneratorSelectionSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import type { ScmDiffSummaryOutputs } from '@happier-dev/protocol';
import { SessionModelRefSchema } from '@happier-dev/protocol/providers/selection/v2';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ExecutionRunIntentProfile, ExecutionRunProfileTurnCompleteParams, ExecutionRunProfileBoundedCompleteResult } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { stripTrailingJsonObjectFromText } from '@/agent/executionRuns/profiles/shared/stripTrailingJsonObjectFromText';

import { buildDiffSummaryPrompt, buildDiffSummaryRefinementTask, SCM_DIFF_SUMMARY_PR_DRAFT_TASK } from './buildDiffSummaryPrompt';
import { loadScmDiffSummaryContext } from './loadScmDiffSummaryContext';
import { parseDiffSummaryModelOutput, type DiffSummaryModelOutput } from './parseDiffSummaryModelOutput';
import { presentScmDiffSummaryModelContext, scopeScmDiffSummaryComparison } from './presentScmDiffSummaryModelContext';
import { advanceDiffSummaryAnalysis, hasActiveDiffSummaryAnalysis, planDiffSummaryAnalysis,
  readDiffSummaryPartProgress } from './advanceDiffSummaryAnalysis';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { buildPendingScmDiffSummaryOutput, buildScmDiffSummaryTurnProducer, publishSavedScmDiffSummaryTurn, readOrCreateSavedScmResult, readInitialScmDiffSummaryInputId, readScmDiffSummaryProducerModelId } from './publishSavedScmDiffSummaryTurn';
import { buildReviewNarrationInputContext, readReviewNarration, readReviewFindingCitationContext } from '@/agent/executionRuns/profiles/review/reviewNarrationContext';
import { findingCitationInstructions, publishReviewFindingCitations } from '@/agent/executionRuns/profiles/review/reviewFindingCitations';
import { resolveScmDiffSummarySettings } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bindScmExecutionRunProfileAccountScope } from '../../profileStart';

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readRequestedOutputs(input: Readonly<Record<string, unknown>>) {
  const values = Array.isArray(input.outputs) ? input.outputs : ['summary'];
  return values.map((value) => ScmDiffSummaryOutputKindSchema.parse(value));
}

function withReviewNarrationProvenance(params: ExecutionRunProfileTurnCompleteParams,
  completion: ExecutionRunProfileBoundedCompleteResult | null) {
  if (!completion) return completion;
  const narration = readReviewNarration(params.start.intentInput);
  if (!narration) return completion;
  const annotated = ScmDiffSummaryGenerateOutputSchema.parse({ ...readRecord(completion.toolResultOutput),
    producer: buildScmDiffSummaryTurnProducer(params) });
  return { ...completion, toolResultOutput: annotated,
    structuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: annotated } };
}

function completeScmDiffSummaryTurn({ start, previousStructuredMeta }: Pick<ExecutionRunProfileTurnCompleteParams, 'start' | 'previousStructuredMeta'>,
  model: DiffSummaryModelOutput | null): ExecutionRunProfileBoundedCompleteResult {
  const intentInput = readRecord(start.intentInput);
  const comparison = ScmComparisonSchema.safeParse(intentInput.comparison);
  const requestedOutputs = readRequestedOutputs(intentInput);
  let rawModel = model;
  if (rawModel && comparison.success) {
    try {
      rawModel = normalizeScmDiffSummaryModelOutput(rawModel,
        { comparison: comparison.data, requestedOutputs, requireCompleteCoverage: true });
    } catch { rawModel = null; }
  }
  const parsed = rawModel ? publishReviewFindingCitations(rawModel, readReviewFindingCitationContext(start.intentInput)) : null;
  const previous = previousStructuredMeta?.kind === EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary
    ? ScmDiffSummaryGenerateOutputSchema.safeParse(previousStructuredMeta.payload)
    : null;
  const sourceKey = readNonEmptyString(intentInput.sourceKey) ?? 'unknown';
  const checkpointReceiptId = readNonEmptyString(intentInput.checkpointReceiptId);
  const metadata = ScmDiffSummaryMetadataSchema.safeParse(intentInput.metadata);
  const supplied = comparison.success ? comparison.data.inventory.files.flatMap((file) =>
    file.occurrences.filter((change) => change.evidence?.state === 'available'
      || (!change.evidence && file.evidence.state === 'available')).map((change) => change.id)) : [];
  if (!parsed || !metadata.success) {
    const failure = ScmDiffSummaryGenerateOutputSchema.parse({
      success: false, error: 'Invalid diff summary output', errorCode: 'SUMMARY_FAILED', sourceKey,
      ...(checkpointReceiptId ? { checkpointReceiptId } : {}),
      ...(metadata.success ? { metadata: metadata.data } : {}),
      ...(comparison.success ? { comparison: comparison.data, requestedOutputs,
        analysis: {
          suppliedChangeRefs: [...new Set([...(previous?.success ? previous.data.analysis?.suppliedChangeRefs ?? [] : []), ...supplied])],
          analysedChangeRefs: previous?.success ? previous.data.analysis?.analysedChangeRefs ?? [] : [],
          remainingChangeRefs: comparison.data.inventory.files.flatMap((file) => file.occurrences.map((change) => change.id))
            .filter((ref) => !previous?.success || !previous.data.analysis?.analysedChangeRefs.includes(ref)),
        },
        outputs: Object.fromEntries(requestedOutputs.map((kind) => [kind, {
          ...(previous?.success ? previous.data.outputs?.[kind] : {}),
          state: previous?.success && previous.data.outputs?.[kind]?.value ? 'partial' : 'failed',
          reason: 'The completed turn did not contain valid structured output.',
        }])),
      } : {}),
    });
    return { status: 'failed', summary: 'Diff summary generation failed.', toolResultOutput: failure,
      structuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: failure } };
  }
  const outputs: ScmDiffSummaryOutputs = { ...(previous?.success ? previous.data.outputs : {}) };
  if (parsed.summaryMarkdown) outputs.summary = { state: 'complete', value: {
    summaryMarkdown: parsed.summaryMarkdown,
    ...(parsed.risks ? { risks: parsed.risks } : {}),
    ...(parsed.testImpact ? { testImpact: parsed.testImpact } : {}),
    ...(parsed.suggestedPrBody ? { suggestedPrBody: parsed.suggestedPrBody } : {}),
  } };
  if (parsed.walkthrough) outputs.walkthrough = { state: 'complete', value: parsed.walkthrough };
  if (parsed.commitPlan) outputs.commitPlan = { state: 'complete', value: parsed.commitPlan };
  for (const kind of requestedOutputs) {
    outputs[kind] ??= { state: 'partial', reason: 'The completed turn omitted this requested output.' };
  }
  const modelId = readScmDiffSummaryProducerModelId(start);
  const result = ScmDiffSummaryGenerateOutputSchema.parse({
    ...(previous?.success && previous.data.success ? previous.data : {}),
    success: true, sourceKey, metadata: metadata.data,
    ...(checkpointReceiptId ? { checkpointReceiptId } : {}),
    ...(parsed.summaryMarkdown ? { summaryMarkdown: parsed.summaryMarkdown } : {}),
    ...(parsed.risks ? { risks: parsed.risks } : {}),
    ...(parsed.testImpact ? { testImpact: parsed.testImpact } : {}),
    ...(parsed.suggestedPrBody ? { suggestedPrBody: parsed.suggestedPrBody } : {}),
    ...(comparison.success ? {
      comparison: comparison.data, requestedOutputs, outputs, runId: start.runId,
      analysis: { suppliedChangeRefs: supplied, analysedChangeRefs: supplied,
        remainingChangeRefs: comparison.data.inventory.files.flatMap((file) => file.occurrences.map((change) => change.id))
          .filter((ref) => !supplied.includes(ref)),
      },
      producer: { kind: 'generation', runId: start.runId,
        ...(modelId ? { modelId } : {}) },
    } : {}),
  });
  return { status: 'succeeded', summary: 'Diff summary generated.', toolResultOutput: result,
    structuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: result } };
}

export const ScmDiffSummaryProfile: ExecutionRunIntentProfile = bindScmExecutionRunProfileAccountScope({
  intent: 'scm_diff_summary',
  supportsDetached: true,
  transcriptMaterialization: 'full',
  computeSidechainStreamText: ({ fullText }) => stripTrailingJsonObjectFromText(fullText,
    Object.keys(ScmDiffSummaryModelOutputSchema.shape)),
  prepareStartParams: async ({ request, cwd, sessionId, contextWindowTokens, captureScmCommitTarget }) => {
    const { scmAnalysis: _callerAnalysis, scmContextWindowTokens: _callerCapacity,
      scmMaxInputUnicodeCharacters: _callerInputCapacity,
      scmAnalysisPrompt: _callerAnalysisPrompt,
      resultGenerator: _callerGenerator, resultBaseRevision: _callerRevision, resultInitialInputId: _callerInitialInputId,
      reviewNarration: _callerReviewNarration,
      reviewExplanation: _callerReviewExplanation,
      ...parsedInput } = ExecutionRunScmDiffSummaryInputV1Schema.parse(request.intentInput ?? {});
    const outputLanguage = parsedInput.outputLanguage ?? resolveScmDiffSummarySettings({
      storedSettings: getActiveAccountSettingsSnapshot()?.settings ?? {}, catalogProfiles: [],
    }).outputLanguage;
    const input = { ...parsedInput, ...(outputLanguage ? { outputLanguage } : {}) };
    const context = await loadScmDiffSummaryContext({
      ...(captureScmCommitTarget ? { captureCommitTarget: captureScmCommitTarget } : {}),
      input,
      workingDirectory: cwd,
      ...(sessionId ? { sessionId } : {}),
    });
    const trustedInput = { ...input, comparison: context.comparison, metadata: context.metadata };
    let generatorModelRef: unknown = input.modelSelector?.modelSelection ?? request.modelSelection;
    if (request.teamCredentialModel) {
      const { kind: _kind, ...teamRef } = request.teamCredentialModel;
      generatorModelRef = { source: 'team_resource', ...teamRef };
    }
    const modelSelection = SessionModelRefSchema.safeParse(generatorModelRef);
    const generator = ScmDiffSummaryGeneratorSelectionSchema.parse({
      backendTarget: readBackendTargetRefV2(request.backendTarget),
      ...(outputLanguage ? { outputLanguage } : {}),
      ...(input.investigateSurroundingFiles === true ? { investigateSurroundingFiles: true } : {}),
      ...(readNonEmptyString(request.modelId) ? { modelId: readNonEmptyString(request.modelId) } : {}),
      ...(readNonEmptyString(request.profileId) ? { profileId: readNonEmptyString(request.profileId) } : {}),
      ...(modelSelection.success ? { modelSelection: modelSelection.data } : {}),
      ...(request.connectedServices !== undefined ? { connectedServices: request.connectedServices } : {}),
      ...(request.sessionConfigOptionOverrides !== undefined ? { sessionConfigOptionOverrides: request.sessionConfigOptionOverrides } : {}),
    });
    const savedId = typeof input.resultId === 'string' ? input.resultId : undefined;
    const scope = { cwd: input.cwd || cwd, ...(sessionId ? { sessionId } : {}) };
    const retainedScope = savedId
      ? await scmDiffSummaryResultStore.readStoredScope({ ...scope, resultId: savedId }).catch(() => null) : null;
    if (savedId) {
      if (!retainedScope || (retainedScope.sessionId && retainedScope.sessionId !== sessionId)
        || (retainedScope.sourceSessionId && retainedScope.sourceSessionId !== sessionId)) {
        throw Object.assign(new Error('Saved comparison evidence is unavailable for this Run scope'), { code: 'DIFF_UNAVAILABLE' });
      }
    }
    const existing = retainedScope?.result;
    if (savedId && (!existing || existing.output.comparison?.id !== context.comparison.id
      || existing.revision !== input.expectedRevision)) throw new Error('Saved result revision or comparison is unavailable for this new generator');
    const saved = existing ?? await scmDiffSummaryResultStore.create({ ...scope,
      output: buildPendingScmDiffSummaryOutput(trustedInput), generator });
    if (input.pullRequestDraft && !retainedScope?.pullRequestDraftEvidence) {
      throw Object.assign(new Error('Host-captured pull request draft evidence is unavailable'), { code: 'DIFF_UNAVAILABLE' });
    }
    const draftEvidence = retainedScope?.pullRequestDraftEvidence;
    const citations = retainedScope?.reviewFindingCitations ?? [];
    const savedInput = { ...input, resultId: saved.resultId, resultBaseRevision: saved.revision, resultGenerator: generator,
      ...(request.localInputId ? { resultInitialInputId: request.localInputId } : {}),
      reviewNarration: { reviewFindingCitations: citations } };
    if (draftEvidence) savedInput.pullRequestDraft ??= {};
    const isSeededResult = Boolean(savedId && (saved.output.runId || typeof input.instructions === 'string'
      || Object.values(saved.output.outputs ?? {}).some((output) => output?.value !== undefined)));
    const investigation = input.investigateSurroundingFiles === true
      ? await scmDiffSummaryResultStore.prepareInvestigation({ ...scope, resultId: saved.resultId }) : null;
    const executionPolicy = { permissionMode: investigation ? 'read_only' : 'no_tools', workspaceWrites: 'deny' as const,
      ...(investigation ? { cwd: investigation.afterDirectory } : {}) };
    const investigationInstructions = investigation ? [
      'Surrounding-file investigation is enabled for this captured comparison.',
      `Read-only before endpoint directory: ${JSON.stringify(investigation.beforeDirectory)}.`,
      `Read-only after endpoint directory (your working directory): ${JSON.stringify(investigation.afterDirectory)}.`,
      'Use these endpoint directories for surrounding-file context. The live repository is not this comparison.',
      'Submodule working files are not available; captured Gitlink identities remain comparison evidence.',
      'Surrounding-file reads do not add change references or establish analysis coverage. Captured references and host coverage remain authoritative.',
    ].join('\n') : '';
    const userInstructions = typeof input.instructions === 'string' ? input.instructions : request.instructions;
    const selectedStops = input.stopIds ? saved.output.outputs?.walkthrough?.value?.stops.filter(stop => input.stopIds!.includes(stop.id)) : undefined;
    if (input.stopIds && selectedStops?.length !== input.stopIds.length) throw new Error('Selected stops are unavailable in the saved revision');
    const promptComparison = scopeScmDiffSummaryComparison(context.comparison, selectedStops ? new Set(selectedStops.flatMap(stop => stop.changeRefs)) : null);
    const explanationInput = input.reviewExplanationInputId ? await scmDiffSummaryResultStore.readInput({ ...scope,
      resultId: saved.resultId, inputIds: [input.reviewExplanationInputId] }) : null;
    if (input.reviewExplanationInputId && !explanationInput?.reviewExplanation) throw new Error('The saved finding explanation request is unavailable');
    const savedContext = isSeededResult
      ? `Saved outputs: ${JSON.stringify(presentScmDiffSummaryModelContext(selectedStops
        ? { comparisonId: promptComparison.id, title: saved.output.outputs?.walkthrough?.value?.title, stops: selectedStops }
        : saved.output, promptComparison, citations))}` : undefined;
    const evidenceContext = [savedContext, ...(draftEvidence ? [`Pull request drafting evidence: ${draftEvidence}`] : [])].filter(Boolean).join('\n\n');
    const taskInstructions = [investigationInstructions,
      ...(draftEvidence && (input.outputs ?? ['summary']).includes('summary') ? [SCM_DIFF_SUMMARY_PR_DRAFT_TASK] : []), ...(savedContext ? [
      'Start a new conversation seeded from this saved result and its captured evidence.',
      'This conversation is a replacement generator, not a continuation of the previous native thread.',
      explanationInput?.reviewExplanation
        ? 'Explain the selected findings, without changing walkthrough prose or giving a verdict. Return only reviewExplanations, one {stopId, markdown} per selected stop.'
        : input.outputs?.length === 0 ? '' : 'Publish only the requested structured outputs; retain exact captured change references.',
      ...(selectedStops && input.outputs?.length !== 0 && !explanationInput?.reviewExplanation ? [
        buildDiffSummaryRefinementTask({ stops: selectedStops,
          editedStopIds: saved.walkthroughProvenance?.stops.filter(stop => stop.titleEdited).map(stop => stop.stopId) ?? [] }),
      ] : []),
      findingCitationInstructions,
    ] : [])].filter(Boolean).join('\n');
    const instructions = buildDiffSummaryPrompt({
        metadata: context.metadata,
        files: selectedStops ? context.files.filter(file => promptComparison.inventory.files.some(selected => selected.path === file.path)) : context.files,
        comparison: promptComparison,
        outputs: input.outputs,
        instructions: userInstructions,
        outputLanguage: input.outputLanguage,
        ...(explanationInput?.reviewExplanation ? { reviewExplanation: true } : {}),
        ...(evidenceContext ? { evidenceContext } : {}),
        ...(taskInstructions ? { taskInstructions } : {}),
      });
    const analysisInstructions = userInstructions;
    // Capture and launch policy are prepared once. Partition only after the
    // runtime has supplied its effective budget for the actual prepared context.
    const analysisPrompt = request.runClass === 'long_lived' && !isSeededResult ? {
      taskPromptCodeUnits: instructions.length,
      instructions: analysisInstructions, outputLanguage: input.outputLanguage,
      ...(evidenceContext ? { evidenceContext } : {}), ...(taskInstructions ? { taskInstructions } : {}),
    } : undefined;
    return {
      ...executionPolicy,
      instructions,
      intentInput: {
        ...savedInput,
        ...(analysisInstructions ? { instructions: analysisInstructions } : {}),
        sourceKey: context.metadata.sourceKey,
        metadata: context.metadata,
        comparison: context.comparison,
        comparisonId: context.comparison.id,
        ...(analysisPrompt ? { scmAnalysisPrompt: analysisPrompt } : {}),
        ...(contextWindowTokens ? { scmContextWindowTokens: contextWindowTokens } : {}),
      },
    };
  },
  finalizeStartParams: async ({ request, maxInputUnicodeCharacters, resolveMaxInputUnicodeCharacters }) => {
    const input = readRecord(request.intentInput);
    if (!Object.hasOwn(input, 'scmAnalysisPrompt')) return undefined;
    const prompt = readRecord(input.scmAnalysisPrompt);
    const composedPrompt = request.instructions ?? '';
    const taskPromptCodeUnits = prompt.taskPromptCodeUnits;
    if (typeof taskPromptCodeUnits !== 'number' || !Number.isSafeInteger(taskPromptCodeUnits)
      || taskPromptCodeUnits < 0 || taskPromptCodeUnits > composedPrompt.length) {
      throw new Error('The prepared analysis prompt is unavailable');
    }
    maxInputUnicodeCharacters ??= await resolveMaxInputUnicodeCharacters?.();
    // Start composition prepends admitted role/profile guidance to this task.
    // Keep that exact prefix on every part while replacing only its evidence.
    const promptPrefix = composedPrompt.slice(0, composedPrompt.length - taskPromptCodeUnits);
    const { scmAnalysisPrompt: _preparedPrompt, scmAnalysis: _oldAnalysis,
      scmMaxInputUnicodeCharacters: _oldCapacity, ...retainedInput } = input;
    const planned = planDiffSummaryAnalysis({ comparison: ScmComparisonSchema.parse(input.comparison),
      metadata: ScmDiffSummaryMetadataSchema.parse(input.metadata), outputs: readRequestedOutputs(input),
      prompt: composedPrompt, promptPrefix, maxInputUnicodeCharacters,
      contextWindowTokens: typeof input.scmContextWindowTokens === 'number' ? input.scmContextWindowTokens : undefined,
      ...(typeof prompt.instructions === 'string' ? { instructions: prompt.instructions } : {}),
      ...(typeof prompt.outputLanguage === 'string' ? { outputLanguage: prompt.outputLanguage } : {}),
      ...(typeof prompt.evidenceContext === 'string' ? { evidenceContext: prompt.evidenceContext } : {}),
      ...(typeof prompt.taskInstructions === 'string' ? { taskInstructions: prompt.taskInstructions } : {}),
    });
    return { instructions: planned?.instructions ?? request.instructions,
      intentInput: { ...retainedInput, ...(planned ? { scmAnalysis: planned.state } : {}),
        ...(maxInputUnicodeCharacters !== undefined ? { scmMaxInputUnicodeCharacters: maxInputUnicodeCharacters } : {}) } };
  },
  buildPrompt: (params) => params.instructions,
  onBoundedComplete: params => completeScmDiffSummaryTurn(params, parseDiffSummaryModelOutput(params.rawText)),
  onStarted: async ({ start }) => {
    const input = readRecord(start.intentInput);
    if (start.runClass === 'bounded') return null;
    const saved = await readOrCreateSavedScmResult(start);
    const initialInputId = readInitialScmDiffSummaryInputId(start);
    const explanationInputId = readNonEmptyString(input.reviewExplanationInputId);
    const explanationInput = explanationInputId
      ? await scmDiffSummaryResultStore.readInput({ ...saved.scope, inputIds: [initialInputId] })
        ?? await scmDiffSummaryResultStore.readInput({ ...saved.scope, inputIds: [explanationInputId] }) : null;
    if (explanationInputId) {
      const stopIds = Array.isArray(input.stopIds) ? input.stopIds : [];
      const outputs = readRequestedOutputs(input);
      const targets = explanationInput?.reviewExplanation?.targets;
      if (!explanationInput?.reviewExplanation || explanationInput.baseRevision !== saved.result.revision
        || outputs.length !== 1 || outputs[0] !== 'walkthrough'
        || explanationInput.outputs.length !== 1 || explanationInput.outputs[0] !== 'walkthrough'
        || !stopIds.length || stopIds.length !== explanationInput.stopIds?.length
        || stopIds.some(id => !explanationInput.stopIds?.includes(id))
        || targets?.length !== stopIds.length || targets.some(target => !stopIds.includes(target.stopId))) {
        throw new Error('The saved finding explanation request is unavailable for this exact revision and selection');
      }
    }
    const oldRunId = saved.result.output.runId;
    const baseRevision = typeof input.resultBaseRevision === 'number' ? input.resultBaseRevision : saved.result.revision;
    const generator = ScmDiffSummaryGeneratorSelectionSchema.safeParse(input.resultGenerator);
    // Credential defaults can resolve after preparation; the admitted Run owns this route.
    if (generator.success && start.connectedServices !== undefined) {
      generator.data.connectedServices = start.connectedServices;
    }
    const bound = oldRunId === start.runId ? { success: true as const, result: saved.result }
      : await scmDiffSummaryResultStore.bindRun({ ...saved.scope, expectedRevision: baseRevision, runId: start.runId,
        ...(generator.success ? { generator: generator.data } : {}),
        ...(oldRunId ? { seededFromRunId: oldRunId } : {}) });
    if (!bound.success) throw new Error(bound.error);
    let currentResult = bound.result;
    const partProgress = readDiffSummaryPartProgress(input);
    if (partProgress && currentResult.output.analysis) {
      const progress = await scmDiffSummaryResultStore.publishProgress({ ...saved.scope, expectedRevision: currentResult.revision,
        preserveUndo: true, output: ScmDiffSummaryGenerateOutputSchema.parse({ ...currentResult.output,
          analysis: { ...currentResult.output.analysis, parts: partProgress } }) });
      if (!progress.success) throw new Error(progress.error);
      currentResult = progress.result;
    }
    const prepared = await scmDiffSummaryResultStore.beginInput({ ...saved.scope, inputId: initialInputId, expectedRevision: currentResult.revision,
      ...(explanationInput?.reviewFindingCitations ? { reviewFindingCitations: explanationInput.reviewFindingCitations }
        : input.reviewNarration ? { reviewFindingCitations: readReviewFindingCitationContext(input) } : {}),
      outputs: readRequestedOutputs(input), ...(Array.isArray(input.stopIds) ? { stopIds: input.stopIds as string[] } : {}),
      ...(explanationInput?.reviewExplanation ? { reviewExplanation: explanationInput.reviewExplanation } : {}) });
    if (!prepared.success) throw new Error(prepared.error);
    if (explanationInputId && explanationInputId !== initialInputId) {
      await scmDiffSummaryResultStore.abandonInput({ ...saved.scope, inputId: explanationInputId });
    }
    return { status: 'succeeded', summary: '', transcriptMaterialization: 'none',
      toolResultOutput: currentResult.output, structuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: currentResult.output } };
  },
  buildInitialInputContext: ({ start, structuredMeta }) => {
    const input = readRecord(start.intentInput);
    // The admitted multipart prompt already carries its exact bounded evidence.
    if (hasActiveDiffSummaryAnalysis(input)) return '';
    const narration = buildReviewNarrationInputContext(input);
    if (!input.resultId) return '';
    // The Action creates the saved record before Run admission. Its pending
    // envelope is not an existing reading to discuss: the initial prompt must
    // retain its generation request.
    const saved = structuredMeta?.kind === EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary
      ? ScmDiffSummaryGenerateOutputSchema.safeParse(structuredMeta.payload) : null;
    if (!saved?.success || (!saved.data.success || !saved.data.summaryMarkdown)
      && !Object.values(saved.data.outputs ?? {}).some(output => output?.value !== undefined)) return narration;
    const comparison = ScmComparisonSchema.safeParse(input.comparison);
    const metadata = ScmDiffSummaryMetadataSchema.safeParse(input.metadata);
    if (!comparison.success || !metadata.success || structuredMeta?.kind !== EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary) return narration;
    return ['Saved result and captured evidence for the current request:',
      `Captured comparison: ${JSON.stringify(presentScmDiffSummaryModelContext(comparison.data, comparison.data))}`,
      `Saved structured result: ${JSON.stringify(presentScmDiffSummaryModelContext(structuredMeta.payload, comparison.data, readReviewFindingCitationContext(input)))}`,
      findingCitationInstructions, narration].filter(Boolean).join('\n\n');
  },
  onBeforeRetainedInput: async ({ start, localId }) => {
    const saved = await readOrCreateSavedScmResult(start);
    if (saved.result.output.runId && saved.result.output.runId !== start.runId) throw new Error('This generator was replaced for the saved result');
    // Structured Actions bind their output scope before Pending admission.
    // Ordinary participant chat has none; automatic analysis parts retain the
    // existing host-authored analysis scope.
    const prepared = await scmDiffSummaryResultStore.beginInput({ ...saved.scope, inputId: localId,
      outputs: hasActiveDiffSummaryAnalysis(start.intentInput)
        && readRecord(readRecord(start.intentInput).scmAnalysis).expectedInputId === localId
        ? readRequestedOutputs(readRecord(start.intentInput)) : [] });
    if (!prepared.success) throw new Error(prepared.error);
  },
  onTurnComplete: async (params) => {
    const progressive = hasActiveDiffSummaryAnalysis(params.start.intentInput);
    const published = await publishSavedScmDiffSummaryTurn(params, progressive
      ? (turn) => withReviewNarrationProvenance(turn, advanceDiffSummaryAnalysis(turn))
      : (turn, model) => withReviewNarrationProvenance(turn, completeScmDiffSummaryTurn(turn, model)), progressive);
    return published;
  },
  onTurnFailed: (params) => ScmComparisonSchema.safeParse(readRecord(params.start.intentInput).comparison).success
    ? publishSavedScmDiffSummaryTurn(params, (turn) => withReviewNarrationProvenance(turn,
      advanceDiffSummaryAnalysis({ ...turn, diagnostic: params.diagnostic })), true)
    : null,
  onTerminal: async ({ start, status, finishedAtMs, structuredMeta, diagnostic }) => {
    const input = readRecord(start.intentInput);
    if (readRequestedOutputs(input).length === 0) return null;
    const previous = structuredMeta?.kind === EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary
      ? ScmDiffSummaryGenerateOutputSchema.safeParse(structuredMeta.payload) : null;
    if (!previous?.success && !ScmComparisonSchema.safeParse(input.comparison).success) return null;
    const saved = await readOrCreateSavedScmResult(start, previous?.success ? previous.data : undefined);
    const output = saved.result.output;
    if (output.runId && output.runId !== start.runId) return null;
    const outputs: ScmDiffSummaryOutputs = { ...output.outputs };
    let changed = false;
    for (const kind of output.requestedOutputs ?? []) {
      const current = outputs[kind];
      if (!current || current.state === 'pending' || current.state === 'writing' || current.state === 'partial') {
        const reasonCode = ScmDiffSummaryFailureReasonCodeSchema.safeParse(diagnostic?.code);
        Object.assign(outputs, { [kind]: { ...current, state: status === 'failed' && current?.value !== undefined ? 'partial' : status,
          reason: status === 'cancelled' ? undefined : diagnostic?.message ?? diagnostic?.code ?? `Generation ${status} at ${finishedAtMs}.`,
          reasonCode: status === 'cancelled' ? 'generation_cancelled' : reasonCode.success ? reasonCode.data : undefined,
        } });
        changed = true;
      }
    }
    if (!changed) return { toolResultOutput: output, structuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: output } };
    const result = ScmDiffSummaryGenerateOutputSchema.parse({ ...output, runId: start.runId, outputs });
    const published = await scmDiffSummaryResultStore.publishProgress({ ...saved.scope, expectedRevision: saved.result.revision,
      output: result, preserveUndo: true });
    if (!published.success) return { toolResultOutput: output, structuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: output } };
    return { toolResultOutput: published.result.output, structuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: published.result.output } };
  },
});
