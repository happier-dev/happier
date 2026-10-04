import {
  ExecutionRunScmDiffSummaryInputV1Schema,
  SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION,
  ScmDiffSummaryGenerateOutputSchema,
  ScmComparisonSchema,
  ScmDiffSummaryOutputKindSchema,
  ScmDiffSummaryMetadataSchema,
  ScmDiffSummaryGeneratorSelectionSchema,
  type ScmDiffSummaryGenerateOutput,
  type ScmDiffSummaryOutputs,
  ProviderBoundModelRefSchema,
  serializeModelVisibilityRefV1,
  buildBackendTargetKeyV2,
  readBackendTargetRefV2,
} from '@happier-dev/protocol';
import type { ExecutionRunIntentProfile, ExecutionRunProfileTurnCompleteParams, ExecutionRunProfileBoundedCompleteResult } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

import { buildDiffSummaryPrompt } from './buildDiffSummaryPrompt';
import { loadScmDiffSummaryContext } from './loadScmDiffSummaryContext';
import { parseDiffSummaryModelOutput } from './parseDiffSummaryModelOutput';
import { presentScmDiffSummaryModelContext } from './presentScmDiffSummaryModelContext';
import { advanceDiffSummaryAnalysis, hasActiveDiffSummaryAnalysis, planDiffSummaryAnalysis,
  readDiffSummaryPartProgress, admitDiffSummaryPart } from './advanceDiffSummaryAnalysis';
import { stripTrailingJsonObjectFromText } from '@/agent/executionRuns/profiles/shared/stripTrailingJsonObjectFromText';
import {
  scmDiffSummaryCacheStore,
  type ScmDiffSummaryCachedValue,
} from '@/agent/executionRuns/tasks/scmDiffSummary/cache/cacheStore';
import type { ScmDiffSummaryCacheKeyInput } from '@/agent/executionRuns/tasks/scmDiffSummary/cache/cacheKey';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { buildPendingScmDiffSummaryOutput, publishSavedScmDiffSummaryTurn, readOrCreateSavedScmResult } from './publishSavedScmDiffSummaryTurn';
import { buildReviewNarrationInputContext, readReviewNarration, readReviewFindingCitationContext } from '@/agent/executionRuns/profiles/review/reviewNarrationContext';
import { findingCitationInstructions, publishReviewFindingCitations } from '@/agent/executionRuns/profiles/review/reviewFindingCitations';

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveVersion(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION;
}

function desiredCacheSelection(request: Parameters<NonNullable<ExecutionRunIntentProfile['prepareStartParams']>>[0]['request']) {
  const selection = ProviderBoundModelRefSchema.safeParse(request.modelSelection);
  const modelId = selection.success ? selection.data.modelId : readNonEmptyString(request.modelId);
  if (!modelId || (request.modelSelection !== undefined && !selection.success)) return null;
  const backendTargetKey = buildBackendTargetKeyV2(readBackendTargetRefV2(request.backendTarget));
  return { requestedModelId: modelId, resolvedSelector: { catalogId: JSON.stringify({ backendTargetKey,
    ...(selection.success ? { selection: serializeModelVisibilityRefV1({ scope: 'agent', ...selection.data }) } : { modelId }),
  }) } };
}

function buildCacheKeyInput(params: Readonly<{
  intentInput: Readonly<Record<string, unknown>>;
}>): ScmDiffSummaryCacheKeyInput | null {
  const outputs = readRequestedOutputs(params.intentInput);
  const comparison = ScmComparisonSchema.safeParse(params.intentInput.comparison);
  const selector = readNonEmptyString(readRecord(params.intentInput.resolvedSelector).catalogId);
  const scopeKey = readNonEmptyString(params.intentInput.cacheScopeKey);
  if (comparison.success && selector && scopeKey) return {
    source: { kind: 'comparison', comparisonId: comparison.data.id },
    summarySchemaVersion: readPositiveVersion(params.intentInput.summarySchemaVersion),
    resolvedSelector: { catalogId: selector }, outputs, scopeKey,
  };
  return null;
}

function isScmDiffSummaryGenerateOutput(value: ScmDiffSummaryCachedValue | null): value is ScmDiffSummaryGenerateOutput {
  return ScmDiffSummaryGenerateOutputSchema.safeParse(value).success;
}

function shouldBypassCache(intentInput: Readonly<Record<string, unknown>>): boolean {
  const cachePolicy = readRecord(intentInput.cachePolicy);
  return cachePolicy.mode === 'bypass';
}

function readRequestedOutputs(input: Readonly<Record<string, unknown>>) {
  const values = Array.isArray(input.outputs) ? input.outputs : ['summary'];
  return values.map((value) => ScmDiffSummaryOutputKindSchema.parse(value));
}

function saveCompletedOutput(start: ExecutionRunProfileTurnCompleteParams['start'], completion: ExecutionRunProfileBoundedCompleteResult | null) {
  if (!completion || completion.nextInput) return completion;
  if (readRecord(readRecord(start.intentInput).reviewNarration).phase === 'writing') return completion;
  const output = ScmDiffSummaryGenerateOutputSchema.safeParse(completion.toolResultOutput);
  if (!output.success || !output.data.success || output.data.producer?.kind === 'review'
    || output.data.requestedOutputs?.some((kind) => output.data.outputs?.[kind]?.state !== 'complete')) return completion;
  const intentInput: Readonly<Record<string, unknown>> = { ...readRecord(start.intentInput), cacheScopeKey: start.sessionId };
  if (!start.effectiveEngine?.modelId || start.effectiveEngine.modelId !== intentInput.requestedModelId) return completion;
  const keyInput = buildCacheKeyInput({ intentInput });
  if (keyInput) scmDiffSummaryCacheStore.set({ keyInput, value: output.data });
  return completion;
}

function withReviewNarrationProvenance(params: ExecutionRunProfileTurnCompleteParams,
  completion: ExecutionRunProfileBoundedCompleteResult | null) {
  if (!completion) return completion;
  const narration = readReviewNarration(params.start.intentInput);
  if (!narration) return completion;
  const output = ScmDiffSummaryGenerateOutputSchema.parse(completion.toolResultOutput);
  const annotated = ScmDiffSummaryGenerateOutputSchema.parse({ ...output, producer: {
    kind: 'review', runId: params.start.runId,
    ...(params.start.effectiveEngine?.modelId ? { modelId: params.start.effectiveEngine.modelId } : {}),
    ...narration.provenance, reviewedBy: [...new Set(narration.provenance.reviewedRuns.map(run => run.backendId))],
    narratedAtMs: params.finishedAtMs,
  } });
  return { ...completion, toolResultOutput: annotated,
    structuredMeta: { kind: 'scm_diff_summary.v1', payload: annotated } };
}

function completeScmDiffSummaryTurn({ start, rawText, previousStructuredMeta }: Pick<ExecutionRunProfileTurnCompleteParams, 'start' | 'rawText' | 'previousStructuredMeta'>): ExecutionRunProfileBoundedCompleteResult {
  const intentInput = readRecord(start.intentInput);
  const comparison = ScmComparisonSchema.safeParse(intentInput.comparison);
  const requestedOutputs = readRequestedOutputs(intentInput);
  const rawModel = parseDiffSummaryModelOutput(rawText, comparison.success
    ? { comparison: comparison.data, requestedOutputs, requireCompleteCoverage: true }
    : undefined);
  const parsed = rawModel ? publishReviewFindingCitations(rawModel, readReviewFindingCitationContext(start.intentInput)) : null;
  const previous = previousStructuredMeta?.kind === 'scm_diff_summary.v1'
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
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: failure } };
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
        ...(start.effectiveEngine?.modelId ? { modelId: start.effectiveEngine.modelId } : {}) },
    } : {}),
  });
  return saveCompletedOutput(start, { status: 'succeeded', summary: 'Diff summary generated.', toolResultOutput: result,
    structuredMeta: { kind: 'scm_diff_summary.v1', payload: result } })!;
}

export const ScmDiffSummaryProfile: ExecutionRunIntentProfile = {
  intent: 'scm_diff_summary',
  transcriptMaterialization: 'full',
  computeSidechainStreamText: ({ fullText }) => {
    const rawText = String(fullText ?? '');
    const stripped = stripTrailingJsonObjectFromText(rawText).trimEnd();
    if (stripped !== rawText.trimEnd()) return stripped;

    const jsonStartIndex = rawText.trimStart().startsWith('{') ? rawText.indexOf('{') : rawText.lastIndexOf('\n{');
    if (jsonStartIndex >= 0) {
      const jsonTail = rawText.slice(jsonStartIndex, Math.min(rawText.length, jsonStartIndex + 800));
      if (jsonTail.includes('"summaryMarkdown"') || jsonTail.includes('"walkthrough"') || jsonTail.includes('"commitPlan"') || jsonTail.includes('"risks"') || jsonTail.includes('"testImpact"')) {
        return rawText.slice(0, jsonStartIndex).trimEnd();
      }
    }

    return rawText;
  },
  prepareStartParams: async ({ request, cwd, sessionId, contextWindowTokens }) => {
    const { cachedOutput: _callerCachedOutput, scmAnalysis: _callerAnalysis, scmContextWindowTokens: _callerCapacity, cacheScopeKey: _callerCacheScope,
      resolvedSelector: _callerSelector, requestedModelId: _callerModel,
      resultGenerator: _callerGenerator, resultBaseRevision: _callerRevision,
      reviewNarration: _callerReviewNarration,
      reviewExplanation: _callerReviewExplanation,
      ...input } = ExecutionRunScmDiffSummaryInputV1Schema.parse(request.intentInput ?? {});
    const context = await loadScmDiffSummaryContext({
      input,
      workingDirectory: input.cwd || cwd,
      ...(sessionId ? { sessionId } : {}),
    });
    const desiredSelection = desiredCacheSelection(request);
    const trustedInput = { ...input, comparison: context.comparison, metadata: context.metadata };
    const modelSelection = ProviderBoundModelRefSchema.safeParse(request.modelSelection);
    const generator = ScmDiffSummaryGeneratorSelectionSchema.parse({
      backendTarget: readBackendTargetRefV2(request.backendTarget),
      ...(readNonEmptyString(request.modelId) ? { modelId: readNonEmptyString(request.modelId) } : {}),
      ...(readNonEmptyString(request.profileId) ? { profileId: readNonEmptyString(request.profileId) } : {}),
      ...(modelSelection.success ? { modelSelection: modelSelection.data } : {}),
    });
    const savedId = typeof input.resultId === 'string' ? input.resultId : undefined;
    const scope = { cwd: input.cwd || cwd, ...(sessionId ? { sessionId } : {}) };
    const existing = savedId ? await scmDiffSummaryResultStore.read({ ...scope, resultId: savedId }) : undefined;
    if (savedId && (!existing?.success || existing.result.output.comparison?.id !== context.comparison.id
      || existing.result.revision !== input.expectedRevision)) throw new Error('Saved result revision or comparison is unavailable for this new generator');
    const saved = existing?.success ? existing.result : await scmDiffSummaryResultStore.create({ ...scope,
      output: buildPendingScmDiffSummaryOutput(trustedInput), generator });
    const retainedScope = savedId ? await scmDiffSummaryResultStore.readStoredScope({ ...scope, resultId: saved.resultId }) : null;
    const citations = retainedScope?.reviewFindingCitations ?? [];
    const savedInput = { ...input, resultId: saved.resultId, resultBaseRevision: saved.revision, resultGenerator: generator,
      reviewNarration: { reviewFindingCitations: citations } };
    const isSeededResult = Boolean(savedId && (saved.output.runId || typeof input.instructions === 'string'
      || Object.values(saved.output.outputs ?? {}).some((output) => output?.value !== undefined)));
    const inputRecord = { ...savedInput, comparison: context.comparison, cacheScopeKey: sessionId, ...(desiredSelection ?? {}) };
    const cacheKeyInput = buildCacheKeyInput({ intentInput: inputRecord });
    const cachedOutput = !isSeededResult && cacheKeyInput && !shouldBypassCache(inputRecord)
      ? scmDiffSummaryCacheStore.get(cacheKeyInput)
      : null;
    if (cacheKeyInput && isScmDiffSummaryGenerateOutput(cachedOutput)) {
      return {
        instructions: '',
        intentInput: {
          ...savedInput,
          sourceKey: context.metadata.sourceKey,
          metadata: context.metadata,
          comparison: context.comparison,
          comparisonId: context.comparison.id,
          summarySchemaVersion: cacheKeyInput.summarySchemaVersion,
          resolvedSelector: cacheKeyInput.resolvedSelector,
          cachedOutput,
          cacheScopeKey: inputRecord.cacheScopeKey,
          ...(desiredSelection ?? {}),
        },
      };
    }

    const summarySchemaVersion = cacheKeyInput?.summarySchemaVersion ?? SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION;

    const instructions = isSeededResult ? ['Start a new conversation seeded from this saved result and its captured evidence.',
        'This conversation is a replacement generator, not a continuation of the previous native thread.',
        findingCitationInstructions,
        `Saved outputs: ${JSON.stringify(presentScmDiffSummaryModelContext(saved.output, context.comparison, citations))}`,
        `Captured evidence: ${JSON.stringify(presentScmDiffSummaryModelContext(context.comparison, context.comparison))}`,
        typeof input.instructions === 'string' ? input.instructions : request.instructions,
      ].filter(Boolean).join('\n\n') : buildDiffSummaryPrompt({
        metadata: context.metadata,
        files: context.files,
        comparison: context.comparison,
        outputs: input.outputs,
        instructions: typeof request.instructions === 'string' ? request.instructions : undefined,
      });
    const analysisInstructions = [isSeededResult ? `Saved outputs: ${JSON.stringify(presentScmDiffSummaryModelContext(saved.output.outputs, context.comparison, citations))}` : '',
      typeof input.instructions === 'string' ? input.instructions : request.instructions].filter(Boolean).join('\n\n');
    // Saved-result starts can be discussions or scoped refinements. Do not turn
    // them into whole-result generation or bypass their admitted output scope.
    const planned = request.runClass === 'long_lived' && !isSeededResult ? planDiffSummaryAnalysis({ comparison: context.comparison,
      metadata: context.metadata, outputs: input.outputs ?? ['summary'], prompt: instructions, contextWindowTokens,
      instructions: analysisInstructions }) : null;
    return {
      instructions: planned?.instructions ?? instructions,
      intentInput: {
        ...savedInput,
        ...(analysisInstructions ? { instructions: analysisInstructions } : {}),
        sourceKey: context.metadata.sourceKey,
        metadata: context.metadata,
        comparison: context.comparison,
        comparisonId: context.comparison.id,
        summarySchemaVersion,
        cacheScopeKey: inputRecord.cacheScopeKey,
        ...(desiredSelection ?? {}),
        ...(planned ? { scmAnalysis: planned.state } : {}),
        ...(contextWindowTokens ? { scmContextWindowTokens: contextWindowTokens } : {}),
      },
    };
  },
  buildPrompt: (params) => params.instructions,
  onBoundedComplete: completeScmDiffSummaryTurn,
  onStarted: async ({ start }) => {
    const input = readRecord(start.intentInput);
    const cached = ScmDiffSummaryGenerateOutputSchema.safeParse(input.cachedOutput);
    if (start.runClass === 'bounded' && (!cached.success || shouldBypassCache(input))) return null;
    const saved = await readOrCreateSavedScmResult(start);
    const initialInputId = `initial:${start.runId}`;
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
    if (!cached.success || shouldBypassCache(input)) return { status: 'succeeded', summary: oldRunId
      ? 'A new conversation was seeded from the saved result and captured evidence.' : 'Captured changes are ready for analysis.',
      toolResultOutput: currentResult.output, structuredMeta: { kind: 'scm_diff_summary.v1', payload: currentResult.output } };
    const comparison = ScmComparisonSchema.safeParse(input.comparison);
    const metadata = ScmDiffSummaryMetadataSchema.safeParse(input.metadata);
    if (comparison.success && cached.data.comparison?.id !== comparison.data.id) return null;
    const originalRunId = cached.data.producer?.runId ?? cached.data.runId;
    const result = ScmDiffSummaryGenerateOutputSchema.parse({ ...cached.data, runId: start.runId,
      ...(comparison.success && metadata.success ? { comparison: comparison.data, metadata: metadata.data, sourceKey: comparison.data.id } : {}),
      ...(originalRunId ? { producer: { ...cached.data.producer, kind: cached.data.producer?.kind ?? 'generation', seededFromRunId: originalRunId } } : {}),
    });
    const published = await scmDiffSummaryResultStore.publishProgress({ ...saved.scope, expectedRevision: bound.result.revision,
      inputId: initialInputId, output: result });
    if (!published.success) throw new Error(published.error);
    await scmDiffSummaryResultStore.abandonInput({ ...saved.scope, inputId: initialInputId });
    return { status: result.success ? 'succeeded' : 'failed',
      summary: 'Diff summary restored from cache.', toolResultOutput: published.result.output,
      toolResultMeta: { cache: 'hit' }, structuredMeta: { kind: 'scm_diff_summary.v1', payload: published.result.output } };
  },
  buildInitialInputContext: ({ start, structuredMeta }) => {
    const input = readRecord(start.intentInput);
    // The admitted multipart prompt already carries its exact bounded evidence.
    if (hasActiveDiffSummaryAnalysis(input)) return '';
    const narration = buildReviewNarrationInputContext(input);
    if (!input.cachedOutput && !input.resultId) return '';
    const comparison = ScmComparisonSchema.safeParse(input.comparison);
    const metadata = ScmDiffSummaryMetadataSchema.safeParse(input.metadata);
    if (!comparison.success || !metadata.success || structuredMeta?.kind !== 'scm_diff_summary.v1') return narration;
    return ['Continue discussing the saved result and its captured evidence. This context does not request generation.',
      `Captured comparison: ${JSON.stringify(presentScmDiffSummaryModelContext(comparison.data, comparison.data))}`,
      `Saved structured result: ${JSON.stringify(presentScmDiffSummaryModelContext(structuredMeta.payload, comparison.data, readReviewFindingCitationContext(input)))}`,
      findingCitationInstructions, narration].filter(Boolean).join('\n\n');
  },
  onBeforeRetainedInput: async ({ start, localId }) => {
    const saved = await readOrCreateSavedScmResult(start);
    if (saved.result.output.runId && saved.result.output.runId !== start.runId) throw new Error('This generator was replaced for the saved result');
    const prepared = await scmDiffSummaryResultStore.beginInput({ ...saved.scope, inputId: localId });
    if (!prepared.success) throw new Error(prepared.error);
  },
  onRetainedInputAdmitted: async ({ start, localId }) => {
    const admittedInput = admitDiffSummaryPart(start.intentInput, localId);
    if (!admittedInput) return null;
    const saved = await readOrCreateSavedScmResult(start);
    if (saved.result.output.runId !== start.runId || !saved.result.output.analysis) return null;
    const published = await scmDiffSummaryResultStore.publishProgress({ ...saved.scope, expectedRevision: saved.result.revision,
      preserveUndo: true, inputId: localId, output: ScmDiffSummaryGenerateOutputSchema.parse({ ...saved.result.output,
        analysis: { ...saved.result.output.analysis, parts: readDiffSummaryPartProgress(admittedInput) } }) });
    if (!published.success) return null;
    return { status: 'succeeded', summary: 'The next diff analysis part was admitted.', toolResultOutput: published.result.output,
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: published.result.output }, updatedIntentInput: admittedInput };
  },
  onTurnComplete: async (params) => {
    const progressive = hasActiveDiffSummaryAnalysis(params.start.intentInput);
    return publishSavedScmDiffSummaryTurn(params, progressive
      ? (turn) => saveCompletedOutput(turn.start, withReviewNarrationProvenance(turn, advanceDiffSummaryAnalysis(turn)))
      : (turn) => withReviewNarrationProvenance(turn, completeScmDiffSummaryTurn(turn)), progressive);
  },
  onTurnFailed: (params) => ScmComparisonSchema.safeParse(readRecord(params.start.intentInput).comparison).success
    ? publishSavedScmDiffSummaryTurn(params, (turn) => withReviewNarrationProvenance(turn,
      advanceDiffSummaryAnalysis({ ...turn, diagnostic: params.diagnostic })), true)
    : null,
  onTerminal: async ({ start, status, finishedAtMs, structuredMeta }) => {
    const input = readRecord(start.intentInput);
    const previous = structuredMeta?.kind === 'scm_diff_summary.v1'
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
        Object.assign(outputs, { [kind]: { ...current, state: status, reason: `Generation ${status} at ${finishedAtMs}.` } });
        changed = true;
      }
    }
    if (!changed) return { toolResultOutput: output, structuredMeta: { kind: 'scm_diff_summary.v1', payload: output } };
    const result = ScmDiffSummaryGenerateOutputSchema.parse({ ...output, runId: start.runId, outputs });
    const published = await scmDiffSummaryResultStore.publishProgress({ ...saved.scope, expectedRevision: saved.result.revision,
      output: result, preserveUndo: true });
    if (!published.success) return { toolResultOutput: output, structuredMeta: { kind: 'scm_diff_summary.v1', payload: output } };
    return { toolResultOutput: published.result.output, structuredMeta: { kind: 'scm_diff_summary.v1', payload: published.result.output } };
  },
  buildInvalidOutputRepairPrompt: ({ start }) => {
    const input = readRecord(start.intentInput);
    const comparison = ScmComparisonSchema.safeParse(input.comparison);
    const metadata = ScmDiffSummaryMetadataSchema.parse(input.metadata);
    return buildDiffSummaryPrompt({ metadata, ...(comparison.success ? { comparison: comparison.data } : {}),
      outputs: readRequestedOutputs(input), files: [],
      instructions: 'The previous result was invalid. Repair only the requested structured output using the retained evidence. Do not run tools.',
    });
  },
};
