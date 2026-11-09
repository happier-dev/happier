import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import { z } from 'zod/mini';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';
import { ScmDiffSummaryMetadataSchema, ScmDiffSummaryModelOutputSchema, ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryOutputKindSchema, ScmDiffSummaryOutputLanguageSchema, ScmDiffSummaryFailureReasonCodeSchema } from '@happier-dev/protocol/scm/diffSummary';
import type { ScmComparison, ScmDiffSummaryModelOutput, ScmDiffSummaryOutputs } from '@happier-dev/protocol';
import type { ExecutionRunProfileTurnCompleteParams, ExecutionRunProfileBoundedCompleteResult } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { buildDiffSummaryPrompt } from './buildDiffSummaryPrompt';
import { parseDiffSummaryModelOutput } from './parseDiffSummaryModelOutput';
import { presentScmDiffSummaryModelContext } from './presentScmDiffSummaryModelContext';
import { buildReviewNarrationInputContext, readReviewNarration } from '@/agent/executionRuns/profiles/review/reviewNarrationContext';
import { findingCitationInstructions } from '@/agent/executionRuns/profiles/review/reviewFindingCitations';
import { readScmDiffSummaryProducerModelId } from './publishSavedScmDiffSummaryTurn';

const FragmentSchema = z.strictObject({ path: z.string(), startOffset: z.number().check(z.int(), z.nonnegative()),
  endOffset: z.number().check(z.int(), z.nonnegative()), hunkHeader: z.string(), contextBefore: z.string(), contextAfter: z.string(),
});
const PartSchema = z.strictObject({ refs: z.array(z.string()), diff: z.optional(z.string()), fragment: z.optional(FragmentSchema) });
const AnalysisStateSchema = z.strictObject({
  phase: z.enum(['evidence', 'merge', 'done']), current: z.array(z.string()), currentDiff: z.optional(z.string()),
  currentFragment: z.optional(FragmentSchema), pending: z.array(PartSchema),
  parts: z.array(ScmDiffSummaryModelOutputSchema), supplied: z.array(z.string()), analysed: z.array(z.string()),
  failures: z.array(z.string()), failedRefs: z.array(z.string()),
  failureReasonCode: z.optional(ScmDiffSummaryFailureReasonCodeSchema),
  expectedInputId: z.optional(z.string()),
  instructions: z.optional(z.string()),
  promptPrefix: z.optional(z.string()),
  outputLanguage: z.optional(ScmDiffSummaryOutputLanguageSchema),
  evidenceContext: z.optional(z.string()),
  taskInstructions: z.optional(z.string()),
  completed: z.optional(z.number().check(z.int(), z.nonnegative())),
  totalParts: z.optional(z.number().check(z.int(), z.nonnegative())),
});
type AnalysisState = z.infer<typeof AnalysisStateSchema>;

export function hasActiveDiffSummaryAnalysis(input: unknown): boolean {
  const state = AnalysisStateSchema.safeParse(record(input).scmAnalysis);
  return state.success && state.data.phase !== 'done';
}

export function readDiffSummaryPartProgress(input: unknown) {
  const parsed = AnalysisStateSchema.safeParse(record(input).scmAnalysis);
  if (!parsed.success) return undefined;
  const state = parsed.data;
  const completed = state.completed ?? state.parts.length;
  return { completed, total: state.totalParts ??
    (completed + state.pending.length + (state.phase === 'evidence' && state.current.length ? 1 : 0)),
    phase: state.phase };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}
function allRefs(comparison: ScmComparison): string[] {
  return comparison.inventory.files.flatMap((file) => file.occurrences.map((change) => change.id));
}

/** Preserve original fragment offsets; only the engine decides which headers represent hunks. */
function hunkSourceOffsets(diff: string): readonly number[] {
  const lines = diff.split('\n');
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  const headers: number[] = [];
  let sourceIndex = 0;
  for (const hunk of parseUnifiedDiffHunks(diff)) {
    while (sourceIndex < lines.length && !lines[sourceIndex]!.trimStart().startsWith('@@ ')) sourceIndex += 1;
    headers[hunk.index] = lineOffsets[sourceIndex]!;
    sourceIndex += 1 + hunk.lines.reduce((count, line) => count + (line.noEol ? 2 : 1), 0);
  }
  return headers;
}
function availableRefs(comparison: ScmComparison): string[] {
  return comparison.inventory.files.flatMap((file) => file.occurrences.filter((change) =>
    change.evidence?.state === 'available' || (!change.evidence && file.evidence.state === 'available')).map((change) => change.id));
}

function splitContent(text: string): readonly [string, string] | null {
  const scalars = Array.from(text);
  if (scalars.length < 2) return null;
  const midpoint = Math.ceil(scalars.length / 2);
  const newlines = scalars.flatMap((char, index) => char === '\n' && index + 1 < scalars.length ? [index + 1] : []);
  const boundary = newlines.reduce((nearest, index) => Math.abs(index - midpoint) < Math.abs(nearest - midpoint) ? index : nearest,
    newlines[0] ?? midpoint);
  return [scalars.slice(0, boundary).join(''), scalars.slice(boundary).join('')];
}

function nextPart(state: AnalysisState): void {
  const next = state.pending.shift();
  state.current = next?.refs ?? [];
  state.currentDiff = next?.diff;
  state.currentFragment = next?.fragment;
}

function evidencePrompt(comparison: ScmComparison, metadata: z.infer<typeof ScmDiffSummaryMetadataSchema>,
  outputs: z.infer<typeof ScmDiffSummaryOutputKindSchema>[], state: AnalysisState): string {
  const part = currentComparison(comparison, state);
  const fragment = state.currentFragment;
  return (state.promptPrefix ?? '') + buildDiffSummaryPrompt({ comparison: part, metadata, outputs,
    outputLanguage: state.outputLanguage,
    instructions: state.instructions,
    evidenceContext: state.evidenceContext,
    taskInstructions: [
      state.taskInstructions,
      `Analyse only this ${fragment ? 'textual fragment' : 'part'} of the captured comparison. Other parts are retained by the host. Keep its captured identity and describe only supplied text.`,
      ...(fragment ? [`Fragment offsets: ${fragment.path} unified diff UTF-16 [${fragment.startOffset}, ${fragment.endOffset}).`,
        `Original file/hunk headers: ${fragment.hunkHeader}`, `Context before (partial line orientation, not additional analysed evidence): ${fragment.contextBefore}`,
        `Context after (partial line orientation, not additional analysed evidence): ${fragment.contextAfter}`] : []),
    ].filter(Boolean).join('\n'),
    files: part.inventory.files.map(file => ({ path: file.path, changeKind: file.changeKind,
      unifiedDiff: file.evidence.unifiedDiff, description: file.evidence.state === 'unavailable' ? file.evidence.reason : undefined })),
  });
}

/** Split captured text, retaining exact original offsets and neighboring line context. */
function splitCurrent(comparison: ScmComparison, state: AnalysisState): boolean {
  if (state.current.length > 1) {
    const middle = Math.ceil(state.current.length / 2);
    state.pending.unshift({ refs: state.current.slice(middle) });
    state.current = state.current.slice(0, middle);
    return true;
  }
  const file = comparison.inventory.files.find(value => value.occurrences.some(change => state.current.includes(change.id)));
  if (!file || state.current.length !== 1) return false;
  const path = file.path;
  const source = file.evidence.unifiedDiff ?? '';
  const available = file.occurrences.filter(change => change.evidence?.state === 'available'
    || (!change.evidence && file.evidence.state === 'available'));
  const starts = hunkSourceOffsets(source);
  const index = available.findIndex(change => change.id === state.current[0]);
  if (!state.currentFragment && (index < 0 || starts.length !== available.length)) return false;
  const start = state.currentFragment?.startOffset ?? starts[index]!;
  const end = state.currentFragment?.endOffset ?? starts[index + 1] ?? source.length;
  const pieces = splitContent(source.slice(start, end));
  if (!pieces) return false;
  const boundary = start + pieces[0].length;
  const headerEnd = source.indexOf('\n', starts[index]);
  const hunkHeader = state.currentFragment?.hunkHeader ?? source.slice(0, starts[0])
    + source.slice(starts[index], headerEnd < 0 ? source.length : headerEnd);
  function fragment(from: number, to: number) {
    const beforeStart = source.lastIndexOf('\n', Math.max(0, from - 2)) + 1;
    const afterEnd = source.indexOf('\n', to);
    // Duplicate orientation shrinks with the real fragment, including when a
    // native line itself exceeds the window. All original bytes remain in parts.
    const width = Array.from(source.slice(from, to)).length;
    return { path, startOffset: from, endOffset: to, hunkHeader,
      contextBefore: Array.from(source.slice(beforeStart, from)).slice(-width).join(''),
      contextAfter: Array.from(source.slice(to, afterEnd < 0 ? source.length : afterEnd + 1)).slice(0, width).join('') };
  }
  state.pending.unshift({ refs: [...state.current], diff: pieces[1], fragment: fragment(boundary, end) });
  state.currentDiff = pieces[0];
  state.currentFragment = fragment(start, boundary);
  return true;
}

function inputCapacityReasonCode(prompt: string, limits: Readonly<{ contextWindowTokens?: number; maxInputUnicodeCharacters?: number }>) {
  const { contextWindowTokens, maxInputUnicodeCharacters } = limits;
  if (contextWindowTokens !== undefined && Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0
    && new TextEncoder().encode(prompt).byteLength > contextWindowTokens) return 'agent_context_window_exceeded' as const;
  if (maxInputUnicodeCharacters !== undefined && Number.isSafeInteger(maxInputUnicodeCharacters) && maxInputUnicodeCharacters >= 0) {
    let characters = 0;
    for (let offset = 0; offset < prompt.length; offset++) {
      characters += 1;
      if (characters > maxInputUnicodeCharacters) return 'provider_input_too_large' as const;
      if (prompt.codePointAt(offset)! > 0xffff) offset += 1;
    }
  }
  return undefined;
}

/** Consume independent runtime-character and model-context facts when reported.
 * UTF-8 bytes conservatively charge the token window; this is not a tokenizer
 * or an output/history reservation. Unknown capacity keeps native admission authoritative. */
export function planDiffSummaryAnalysis(params: Readonly<{ comparison: ScmComparison;
  metadata: z.infer<typeof ScmDiffSummaryMetadataSchema>; outputs: z.infer<typeof ScmDiffSummaryOutputKindSchema>[];
  instructions?: string; outputLanguage?: string; evidenceContext?: string; taskInstructions?: string; promptPrefix?: string;
  prompt: string; contextWindowTokens?: number; maxInputUnicodeCharacters?: number }>) {
  if (!inputCapacityReasonCode(params.prompt, params)) return null;
  const state: AnalysisState = { phase: 'evidence', current: allRefs(params.comparison), pending: [],
    parts: [], supplied: [], analysed: [], failures: [], failedRefs: [], instructions: params.instructions, outputLanguage: params.outputLanguage,
    evidenceContext: params.evidenceContext, taskInstructions: params.taskInstructions, promptPrefix: params.promptPrefix,
    completed: 0 };
  // Each split shrinks real evidence; no guessed minimum fragment or local cutoff.
  const planned: z.infer<typeof PartSchema>[] = [];
  for (;;) {
    while (inputCapacityReasonCode(evidencePrompt(params.comparison, params.metadata, params.outputs, state), params)
      && splitCurrent(params.comparison, state)) { /* keep splitting at captured boundaries */ }
    const reasonCode = inputCapacityReasonCode(evidencePrompt(params.comparison, params.metadata, params.outputs, state), {
      maxInputUnicodeCharacters: params.maxInputUnicodeCharacters,
    });
    if (reasonCode) throw Object.assign(new Error('The analysis instructions and indivisible evidence exceed the reported runtime input capacity'), { code: reasonCode });
    planned.push({ refs: state.current, diff: state.currentDiff, fragment: state.currentFragment });
    if (!state.pending.length) break;
    nextPart(state);
  }
  const first = planned.shift()!;
  state.current = first.refs; state.currentDiff = first.diff; state.currentFragment = first.fragment; state.pending = planned;
  state.totalParts = planned.length + 1;
  return { state, instructions: evidencePrompt(params.comparison, params.metadata, params.outputs, state) };
}

function currentComparison(comparison: ScmComparison, state: AnalysisState): ScmComparison {
  const part = partComparison(comparison, state.current);
  if (state.currentDiff === undefined) return part;
  return { ...part, inventory: { ...part.inventory, files: part.inventory.files.map((file) => ({ ...file,
    evidence: file.evidence.state === 'deferred' ? file.evidence : { ...file.evidence, unifiedDiff: state.currentDiff! },
  })) } };
}

/** Captured occurrence order is the order of captured unified-diff hunks. */
function partComparison(comparison: ScmComparison, refs: readonly string[]): ScmComparison {
  const selected = new Set(refs);
  const files = comparison.inventory.files.flatMap((file) => {
    const occurrences = file.occurrences.filter((change) => selected.has(change.id));
    if (!occurrences.length) return [];
    if (occurrences.length === file.occurrences.length) return [file];
    const diff = file.evidence.unifiedDiff ?? '';
    const starts = hunkSourceOffsets(diff);
    const available = file.occurrences.filter((change) => change.evidence?.state === 'available'
      || (!change.evidence && file.evidence.state === 'available'));
    // Do not manufacture an extraction when the capture did not associate each readable hunk.
    if (starts.length !== available.length) {
      const evidence = { state: 'unavailable' as const, reason: 'Captured hunk boundaries cannot be isolated for this analysis part' };
      return [{ ...file, occurrences: occurrences.map((occurrence) => ({ ...occurrence, evidence })), evidence }];
    }
    const unifiedDiff = (starts.length ? diff.slice(0, starts[0]) : '') + available.flatMap((change, index) =>
      selected.has(change.id) ? [diff.slice(starts[index], starts[index + 1] ?? diff.length)] : []).join('');
    return [{ ...file, occurrences, evidence: file.evidence.state === 'available'
      ? { state: 'available' as const, unifiedDiff } : file.evidence.state === 'deferred'
        ? file.evidence : { ...file.evidence, unifiedDiff } }];
  });
  return { ...comparison, inventory: { ...comparison.inventory, files } };
}

function combine(parts: readonly ScmDiffSummaryModelOutput[]): ScmDiffSummaryModelOutput {
  const summaries = parts.flatMap((part) => part.summaryMarkdown ? [part.summaryMarkdown] : []);
  const walkthroughs = parts.flatMap((part, index) => part.walkthrough ? [{ ...part.walkthrough,
    stops: part.walkthrough.stops.map((stop) => ({ ...stop, id: `part-${index}:${stop.id}` })) }] : []);
  const plans = parts.flatMap((part, index) => part.commitPlan ? [{ ...part.commitPlan,
    groups: part.commitPlan.groups.map((group) => ({ ...group, id: `part-${index}:${group.id}` })) }] : []);
  const stops: NonNullable<ScmDiffSummaryModelOutput['walkthrough']>['stops'] = [];
  const stopRefs = new Set<string>();
  for (const stop of walkthroughs.flatMap((walkthrough) => walkthrough.stops)) {
    const existing = stops.find((candidate) => candidate.changeRefs.some((ref) => stop.changeRefs.includes(ref)));
    const changeRefs = stop.changeRefs.filter((ref) => !stopRefs.has(ref));
    if (changeRefs.length) stops.push({ ...stop, changeRefs });
    else if (existing) existing.explanationMarkdown += `\n\n${stop.explanationMarkdown}`;
    changeRefs.forEach((ref) => stopRefs.add(ref));
  }
  const otherChangeRefs = [...new Set(walkthroughs.flatMap((walkthrough) => walkthrough.otherChangeRefs))].filter((ref) => !stopRefs.has(ref));
  const groups: NonNullable<ScmDiffSummaryModelOutput['commitPlan']>['groups'] = [];
  const groupRefs = new Set<string>();
  for (const group of plans.flatMap((plan) => plan.groups)) {
    const existing = groups.find((candidate) => candidate.changeRefs.some((ref) => group.changeRefs.includes(ref)));
    const changeRefs = group.changeRefs.filter((ref) => !groupRefs.has(ref));
    if (changeRefs.length) groups.push({ ...group, changeRefs });
    else if (existing) existing.rationale += `\n\n${group.message}\n${group.rationale}`;
    changeRefs.forEach((ref) => groupRefs.add(ref));
  }
  const leftOutChangeRefs = [...new Set(plans.flatMap((plan) => plan.leftOutChangeRefs))].filter((ref) => !groupRefs.has(ref));
  return {
    ...(summaries.length ? { summaryMarkdown: summaries.join('\n\n') } : {}),
    ...(parts.some((part) => part.risks) ? { risks: parts.flatMap((part) => part.risks ?? []) } : {}),
    ...(parts.some((part) => part.testImpact) ? { testImpact: parts.flatMap((part) => part.testImpact ? [part.testImpact] : []).join('\n\n') } : {}),
    ...(parts.some((part) => part.suggestedPrBody) ? { suggestedPrBody: parts.flatMap((part) => part.suggestedPrBody ? [part.suggestedPrBody] : []).join('\n\n') } : {}),
    ...(walkthroughs.length ? { walkthrough: { title: walkthroughs[0]!.title,
      intro: walkthroughs.map((walkthrough) => walkthrough.intro).filter(Boolean).join('\n\n'),
      stops, otherChangeRefs } } : {}),
    ...(plans.length ? { commitPlan: { groups, leftOutChangeRefs } } : {}),
  };
}

/** Native rejection refines planned boundaries, or selects them when capacity is unknown. */
export function advanceDiffSummaryAnalysis(params: ExecutionRunProfileTurnCompleteParams & Readonly<{
  diagnostic?: Readonly<{ code: string; message?: string }>;
}>): ExecutionRunProfileBoundedCompleteResult | null {
  const input = record(params.start.intentInput);
  const captured = ScmComparisonSchema.safeParse(input.comparison);
  const metadata = ScmDiffSummaryMetadataSchema.safeParse(input.metadata);
  if (!captured.success || !metadata.success) return null;
  const comparison = captured.data;
  const outputs = z.array(ScmDiffSummaryOutputKindSchema).parse(input.outputs ?? ['summary']);
  const saved = AnalysisStateSchema.safeParse(input.scmAnalysis);
  if (!saved.success && !params.diagnostic) return null;
  if (!saved.success && params.previousStructuredMeta) {
    const prior = ScmDiffSummaryGenerateOutputSchema.safeParse(params.previousStructuredMeta.payload);
    if (!prior.success || Object.values(prior.data.outputs ?? {}).some((output) => output?.value !== undefined)) return null;
  }
  const state: AnalysisState = saved.success ? saved.data : {
    phase: 'evidence', current: allRefs(comparison), pending: [], parts: [], supplied: [], analysed: [], failures: [], failedRefs: [],
    instructions: typeof input.instructions === 'string' ? input.instructions : undefined,
    outputLanguage: typeof input.outputLanguage === 'string' ? input.outputLanguage : undefined,
    evidenceContext: buildReviewNarrationInputContext(input) || undefined,
    taskInstructions: readReviewNarration(input) ? findingCitationInstructions : undefined,
  };
  if (state.phase === 'done') return null;
  if (state.expectedInputId && !params.inputIds?.includes(state.expectedInputId)) return null;
  state.totalParts ??= readDiffSummaryPartProgress({ scmAnalysis: state })!.total;
  let value = combine(state.parts);
  let complete = false;
  let next: string | undefined;
  if (params.diagnostic) {
    if (params.diagnostic.code === 'agent_context_window_exceeded' && state.phase === 'evidence' && splitCurrent(comparison, state)) {
      // Replace the refused evidence part with two smaller parts.
      state.totalParts += 1;
    } else {
      state.failures.push(params.diagnostic.message ?? params.diagnostic.code);
      const reasonCode = ScmDiffSummaryFailureReasonCodeSchema.safeParse(params.diagnostic.code);
      if (reasonCode.success) state.failureReasonCode = reasonCode.data;
      state.failedRefs.push(...state.current);
      if (params.diagnostic.code !== 'agent_context_window_exceeded' || state.phase === 'merge') state.phase = 'done';
      else nextPart(state);
    }
  } else if (state.phase === 'merge') {
    const integrated = parseDiffSummaryModelOutput(params.rawText, { comparison, requestedOutputs: outputs, requireCompleteCoverage: true });
    if (integrated) { value = integrated; complete = state.failures.length === 0; }
    else state.failures.push('The integration turn did not return valid structured output');
    state.phase = 'done';
  } else {
    state.completed = (state.completed ?? state.parts.length) + 1;
    const part = currentComparison(comparison, state);
    const parsed = parseDiffSummaryModelOutput(params.rawText, { comparison: part, requestedOutputs: outputs, requireCompleteCoverage: true });
    // Native completion proves this text was delivered independently of whether
    // its model response validated. A whole occurrence is supplied only after
    // every queued fragment has been delivered.
    const supplied = availableRefs(part).filter((ref) => !state.pending.some((pending) => pending.refs.includes(ref)));
    state.supplied = [...new Set([...state.supplied, ...supplied])];
    if (!parsed) {
      state.failures.push('An analysis part did not return valid structured output');
      state.failedRefs.push(...state.current);
    } else {
      state.parts.push(parsed);
      state.analysed = [...new Set([...state.analysed, ...supplied.filter((ref) => !state.failedRefs.includes(ref))])];
      value = combine(state.parts);
    }
    nextPart(state);
  }
  if (state.phase === 'evidence') {
    if (state.current.length) {
      next = evidencePrompt(comparison, metadata.data, outputs, state);
    } else if (state.parts.length) {
      state.phase = 'merge';
      next = (state.promptPrefix ?? '') + [buildDiffSummaryPrompt({ comparison, metadata: metadata.data, outputs, files: [],
        instructions: state.instructions, outputLanguage: state.outputLanguage,
        evidenceContext: state.evidenceContext,
        taskInstructions: [state.taskInstructions, 'Integrate the retained part outputs into one coherent requested result. No new evidence is supplied in this turn. Keep unanalysed changes explicitly reachable.'].filter(Boolean).join('\n') }),
        `Retained part outputs: ${JSON.stringify(presentScmDiffSummaryModelContext(value, comparison))}`,
        `Unanalysed changes: ${JSON.stringify(presentScmDiffSummaryModelContext({ remainingChangeRefs:
          allRefs(comparison).filter((ref) => !state.analysed.includes(ref)) }, comparison))}`,
      ].join('\n\n');
    } else state.phase = 'done';
  }
  const capacityReasonCode = next ? inputCapacityReasonCode(next, {
    contextWindowTokens: typeof input.scmContextWindowTokens === 'number' ? input.scmContextWindowTokens : undefined,
    maxInputUnicodeCharacters: typeof input.scmMaxInputUnicodeCharacters === 'number' ? input.scmMaxInputUnicodeCharacters : undefined,
  }) : undefined;
  if (capacityReasonCode) {
    state.failures.push('The next analysis input exceeds the reported runtime capacity');
    state.failureReasonCode = capacityReasonCode;
    state.phase = 'done';
    next = undefined;
  }
  const progress: ScmDiffSummaryOutputs = {};
  const reason = state.failures.join('\n') || (next ? 'Analysis is continuing in the same run' : 'Analysis did not produce this output');
  for (const kind of outputs) {
    const output = kind === 'summary' ? value.summaryMarkdown ? { summaryMarkdown: value.summaryMarkdown,
      ...(value.risks ? { risks: value.risks } : {}), ...(value.testImpact ? { testImpact: value.testImpact } : {}),
      ...(value.suggestedPrBody ? { suggestedPrBody: value.suggestedPrBody } : {}) } : undefined : value[kind];
    // Assign through schema to retain the output-kind/value correlation.
    Object.assign(progress, { [kind]: { state: next ? 'writing' : output ? complete ? 'complete' : 'partial' : 'failed',
      ...(output ? { value: output } : {}), ...(!complete ? { reason,
        ...(state.failureReasonCode ? { reasonCode: state.failureReasonCode } : {}) } : {}) } });
  }
  const modelId = readScmDiffSummaryProducerModelId(params.start);
  const result = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: comparison.id,
    metadata: metadata.data, comparison, requestedOutputs: outputs, outputs: progress, runId: params.start.runId,
    ...(value.summaryMarkdown ? { summaryMarkdown: value.summaryMarkdown } : {}),
    analysis: { suppliedChangeRefs: state.supplied, analysedChangeRefs: state.analysed,
      remainingChangeRefs: allRefs(comparison).filter((ref) => !state.analysed.includes(ref)),
      parts: readDiffSummaryPartProgress({ scmAnalysis: state }) },
    producer: { kind: 'generation', runId: params.start.runId, ...(modelId ? { modelId } : {}) },
  });
  const nextLocalId = `scm-analysis-part:${params.start.runId}:${params.turnId}`;
  if (next) state.expectedInputId = nextLocalId;
  else delete state.expectedInputId;
  return { status: 'succeeded', summary: '',
    toolResultOutput: result, structuredMeta: { kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary, payload: result },
    updatedIntentInput: { ...input, scmAnalysis: state },
    ...(next ? { nextInput: { instructions: next, intentInput: { ...input, scmAnalysis: state }, localId: nextLocalId } } : {}),
  };
}
