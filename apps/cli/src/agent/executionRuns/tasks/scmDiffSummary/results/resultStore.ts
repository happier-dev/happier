import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { z } from 'zod';
import { ScmDiffSummaryGenerateOutputSchema, ScmDiffSummaryOutputKindSchema, normalizeScmDiffSummaryModelOutput, ScmReviewExplanationTargetsSchema, ScmReviewExplanationRequesterSchema, ScmDiffSummaryModelOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { ScmDiffSummaryResultSchema, ScmDiffSummaryResultEditSchema, ScmWalkthroughProvenanceSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import { ScmCommitPlanAcceptanceSchema, ScmCommitPlanApplicationSchema, isScmCommitPlanApplicationLocked } from '@happier-dev/protocol/scm/diffSummaryCommitPlan';
import type { ScmDiffSummaryGenerateOutput, ScmDiffSummaryModelOutput, ScmDiffSummaryOutputKind, ScmDiffSummaryOutputs, ScmDiffSummaryResult, ScmDiffSummaryResultEdit, ScmDiffSummaryResultResponse, ScmDiffSummaryResultFailure, ScmDiffSummaryResultDeleteResponse, ScmDiffSummaryGeneratorSelection, ScmDiffSummarySavedResultItem, ScmCommitPlanAcceptance, ScmCommitPlanApplication } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { reviewFindingCitationsSchema, publishReviewFindingCitations, publishFindingCitationMarkdown, validatePublishedFindingCitationMarkdown,
  type ReviewFindingCitations } from '@/agent/executionRuns/profiles/review/reviewFindingCitations';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import {
  ensureProtectedLocalStateDirectory, readProtectedLocalStateFile, writeProtectedLocalStateFileAtomic,
  removeProtectedLocalStateFile,
} from '@/utils/fs/protectedLocalState';

export type ScmDiffSummaryResultScope = Readonly<{ cwd: string; sessionId?: string; resultId: string; signal?: AbortSignal }>;
const explanationRequestSchema = z.object({ targets: ScmReviewExplanationTargetsSchema,
  requestedBy: ScmReviewExplanationRequesterSchema, requestedAtMs: z.number().int().nonnegative().optional(),
}).strict();
type InputScope = Readonly<{ inputId: string; expectedRevision?: number; outputs?: readonly ScmDiffSummaryOutputKind[]; stopIds?: readonly string[];
  reviewExplanation?: z.infer<typeof explanationRequestSchema>; reviewFindingCitations?: ReviewFindingCitations }>;
const pendingInputSchema = z.object({ inputId: z.string().min(1), baseRevision: z.number().int().nonnegative(),
  outputs: z.array(ScmDiffSummaryOutputKindSchema).min(1), stopIds: z.array(z.string().min(1)).optional(),
  reviewExplanation: explanationRequestSchema.optional(),
  reviewFindingCitations: reviewFindingCitationsSchema.optional(),
}).strict();
const storedSchema = z.object({
  result: ScmDiffSummaryResultSchema, cwd: z.string().min(1), sessionId: z.string().min(1).optional(),
  undoOutput: ScmDiffSummaryGenerateOutputSchema.optional(), inputs: z.array(pendingInputSchema),
  undoWalkthroughProvenance: ScmWalkthroughProvenanceSchema.optional(),
  reviewFindingCitations: reviewFindingCitationsSchema.optional(),
  generation: z.object({ key: z.string().min(1), runId: z.string().min(1).optional() }).strict().optional(),
}).strict();
type Stored = z.infer<typeof storedSchema>;
export type ScmDiffSummaryResultStore = Readonly<{
  admitGeneration(input: Readonly<{ cwd: string; sessionId?: string; key: string; outputs: readonly ScmDiffSummaryOutputKind[]; bypass?: boolean; signal?: AbortSignal }>,
    generate: () => Promise<ScmDiffSummaryGenerateOutput>): Promise<ScmDiffSummaryGenerateOutput>;
  list(): Promise<Readonly<{ results: readonly ScmDiffSummarySavedResultItem[]; count: number; bytes: number }>>;
  create(input: Readonly<{ cwd: string; sessionId?: string; output: ScmDiffSummaryGenerateOutput; generator?: ScmDiffSummaryGeneratorSelection }>): Promise<ScmDiffSummaryResult>;
  read(scope: ScmDiffSummaryResultScope): Promise<ScmDiffSummaryResultResponse>;
  readStoredScope(scope: ScmDiffSummaryResultScope): Promise<Readonly<{ cwd: string; sessionId?: string; reviewFindingCitations?: ReviewFindingCitations }> | null>;
  edit(input: ScmDiffSummaryResultScope & Readonly<{ expectedRevision: number; edit: ScmDiffSummaryResultEdit }>): Promise<ScmDiffSummaryResultResponse>;
  undo(input: ScmDiffSummaryResultScope & Readonly<{ expectedRevision: number }>): Promise<ScmDiffSummaryResultResponse>;
  delete(input: ScmDiffSummaryResultScope & Readonly<{ expectedRevision: number }>): Promise<ScmDiffSummaryResultDeleteResponse>;
  beginInput(input: ScmDiffSummaryResultScope & InputScope): Promise<ScmDiffSummaryResultResponse>;
  readInput(scope: ScmDiffSummaryResultScope & Readonly<{ inputIds: readonly string[] }>): Promise<z.infer<typeof pendingInputSchema> | null>;
  beginRefinement(input: ScmDiffSummaryResultScope & Readonly<{ expectedRevision: number; output: ScmDiffSummaryOutputKind;
    inputId: string; stopIds?: readonly string[] }>): Promise<ScmDiffSummaryResultResponse>;
  abandonInput(input: ScmDiffSummaryResultScope & Readonly<{ inputId: string }>): Promise<void>;
  bindRun(input: ScmDiffSummaryResultScope & Readonly<{ expectedRevision: number; runId: string; seededFromRunId?: string;
    generator?: ScmDiffSummaryGeneratorSelection }>): Promise<ScmDiffSummaryResultResponse>;
  publish(input: ScmDiffSummaryResultScope & Readonly<{ inputId: string; modelOutput: unknown;
    outputEnvelope?: ScmDiffSummaryGenerateOutput; modelId?: string; runId?: string; generatedAtMs?: number }>): Promise<ScmDiffSummaryResultResponse>;
  publishProgress(input: ScmDiffSummaryResultScope & Readonly<{ expectedRevision: number;
    output: ScmDiffSummaryGenerateOutput; preserveUndo?: true; inputId?: string }>): Promise<ScmDiffSummaryResultResponse>;
  beginApplication(input: ScmDiffSummaryResultScope & Readonly<{ expectedRevision: number;
    acceptance: ScmCommitPlanAcceptance }>): Promise<ScmDiffSummaryResultResponse>;
  mutateApplication(scope: ScmDiffSummaryResultScope, transition: (result: ScmDiffSummaryResult) =>
    ScmCommitPlanApplication | ScmDiffSummaryResultFailure): Promise<ScmDiffSummaryResultResponse>;
}>;

function failure(errorCode: ScmDiffSummaryResultFailure['errorCode'], error: string, latestRevision?: number): ScmDiffSummaryResultFailure {
  return { success: false, errorCode, error, ...(latestRevision !== undefined ? { latestRevision } : {}) };
}
function conflict(stored: Stored, revision: number) {
  return stored.result.revision === revision ? null : failure('revision_conflict', 'The saved result changed. Reconcile the retained draft against the current revision.', stored.result.revision);
}
function withRevision(output: ScmDiffSummaryGenerateOutput, resultId: string, revision: number) {
  return ScmDiffSummaryGenerateOutputSchema.parse({ ...output, resultId, revision });
}
function preserveReviewExplanations(incoming: NonNullable<ScmDiffSummaryModelOutput['walkthrough']>,
  previous: ScmDiffSummaryModelOutput['walkthrough']) {
  return { ...incoming, stops: incoming.stops.map(stop => {
    const original = previous?.stops.find(saved => saved.id === stop.id);
    const sameSelection = original && original.changeRefs.length === stop.changeRefs.length
      && stop.changeRefs.every(ref => original.changeRefs.includes(ref));
    return sameSelection && original.reviewExplanations
      ? { ...stop, reviewExplanations: original.reviewExplanations } : stop;
  }) };
}
/** Saved domain state. Every machine/session writer rereads under the existing filesystem exclusion owner. */
export function createScmDiffSummaryResultStore(options: Readonly<{ directory: string }>): ScmDiffSummaryResultStore {
  const directory = options.directory;
  function path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Saved result identity is invalid');
    return join(directory, `${id}.json`);
  }
  async function load(scope: ScmDiffSummaryResultScope): Promise<Stored | null> {
    try {
      const stored = storedSchema.parse(JSON.parse(await readProtectedLocalStateFile(path(scope.resultId))));
      if (stored.result.resultId !== scope.resultId || stored.cwd !== resolve(scope.cwd)
        || (scope.sessionId !== undefined && stored.sessionId !== scope.sessionId)) return null;
      return stored;
    } catch (error) {
      if (error instanceof Error && ('code' in error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async function save(stored: Stored) {
    await writeProtectedLocalStateFileAtomic(path(stored.result.resultId), JSON.stringify(storedSchema.parse(stored)));
  }
  async function locked<T>(scope: ScmDiffSummaryResultScope, operation: (stored: Stored | null) => Promise<T>): Promise<T> {
    await ensureProtectedLocalStateDirectory(directory);
    // Session hosts and the machine RPC executor can write this same result.
    // Their containing cancellation signal owns waiting; this phase has no independent deadline or lease.
    return withJsonOwnerFileLock({ lockPath: `${path(scope.resultId)}.lock`, timeoutMs: Infinity,
      staleAfterMs: Infinity, errorCode: 'result_unavailable', ...(scope.signal ? { signal: scope.signal } : {}) },
    async () => operation(await load(scope)));
  }
  async function change(scope: ScmDiffSummaryResultScope, expectedRevision: number,
    apply: (stored: Stored) => Stored | ScmDiffSummaryResultFailure): Promise<ScmDiffSummaryResultResponse> {
    return locked(scope, async (stored) => {
      if (!stored) return failure('result_not_found', 'Saved result is unavailable in this repository/session.');
      const stale = conflict(stored, expectedRevision);
      if (stale) return stale;
      if (isScmCommitPlanApplicationLocked(stored.result.application)) return failure('application_locked', 'Resolve the accepted commit application before editing the saved result.', stored.result.revision);
      let next: Stored | ScmDiffSummaryResultFailure;
      try { next = apply(stored); } catch (error) { return failure('invalid_edit', error instanceof Error ? error.message : 'Invalid edit'); }
      if ('success' in next) return next;
      await save(next);
      return { success: true, result: next.result };
    });
  }
  function updated(stored: Stored, output: ScmDiffSummaryGenerateOutput, undo: 'capture' | 'preserve' | 'clear' = 'capture',
    edit?: ScmDiffSummaryResultEdit | 'undo'): Stored {
    const revision = stored.result.revision + 1;
    const undoOutput = undo === 'capture' ? stored.result.output : undo === 'preserve' ? stored.undoOutput : undefined;
    const previous = stored.result.output.outputs?.walkthrough?.value;
    const next = output.outputs?.walkthrough?.value;
    const oldProvenance = stored.result.walkthroughProvenance;
    const affectedStopIds = [...new Set([...(previous?.stops.map(stop => stop.id) ?? []), ...(next?.stops.map(stop => stop.id) ?? [])])]
      .filter(id => JSON.stringify(previous?.stops.find(stop => stop.id === id)) !== JSON.stringify(next?.stops.find(stop => stop.id === id))
        || previous?.stops.findIndex(stop => stop.id === id) !== next?.stops.findIndex(stop => stop.id === id));
    const visibleChange = JSON.stringify(stored.result.output.outputs) !== JSON.stringify(output.outputs);
    const provenance = edit === 'undo' ? stored.undoWalkthroughProvenance : next ? {
      titleEdited: (edit?.kind === 'renameWalkthrough' && previous?.title !== next.title)
        || (oldProvenance?.titleEdited === true && previous?.title === next.title),
      stops: next.stops.map((stop, index) => {
        const oldIndex = previous?.stops.findIndex(value => value.id === stop.id) ?? -1;
        const original = previous?.stops[oldIndex];
        const prior = oldProvenance?.stops.find(value => value.stopId === stop.id);
        return { ...prior, stopId: stop.id,
          titleEdited: (edit?.kind === 'renameStop' && edit.stopId === stop.id && original?.title !== stop.title)
            || (edit?.kind === 'mergeStops' && edit.targetStopId === stop.id && edit.title !== undefined && original?.title !== stop.title)
            || (prior?.titleEdited === true && original?.title === stop.title),
          ...(original && JSON.stringify(original) !== JSON.stringify(stop) ? { changedAtRevision: revision } : {}),
          ...(original && oldIndex !== index ? { movedAtRevision: revision } : {}),
        };
      }),
    } : undefined;
    return { ...stored, undoOutput,
      undoWalkthroughProvenance: undo === 'capture' ? oldProvenance : undo === 'preserve' ? stored.undoWalkthroughProvenance : undefined,
      result: { ...stored.result, revision, output: withRevision(output, stored.result.resultId, revision), canUndo: undoOutput !== undefined,
        walkthroughProvenance: provenance,
        ...(visibleChange ? { updateNotice: { kind: edit === 'undo' ? 'undo' : edit ? 'edit' : 'generation', revision, affectedStopIds,
          ...(edit && edit !== 'undo' && edit.kind === 'mergeStops' ? { mergedStopIds: edit.stopIds } : {}) } } : {}),
      } };
  }
  function assertPublishedCommitGroupsPreserved(stored: Stored, nextCommitPlan: ScmDiffSummaryModelOutput['commitPlan']) {
    const published = stored.result.application?.steps.filter((step) => step.state === 'published') ?? [];
    const currentPlan = stored.result.output.outputs?.commitPlan?.value;
    for (const [index, step] of published.entries()) {
      const original = currentPlan?.groups.find((group) => group.id === step.groupId);
      const next = nextCommitPlan?.groups[index];
      if (!original || !next || next.id !== original.id || next.message !== original.message || next.rationale !== original.rationale
        || next.changeRefs.length !== original.changeRefs.length || next.changeRefs.some((ref, position) => ref !== original.changeRefs[position])) {
        throw new Error('Landed commit groups must retain their original proposal and exact selections at the start of the plan');
      }
    }
  }
  function replaceValues(stored: Stored, model: ScmDiffSummaryModelOutput, kinds: readonly ScmDiffSummaryOutputKind[], envelope?: ScmDiffSummaryGenerateOutput) {
    const output = stored.result.output;
    if (!output.comparison) throw new Error('Saved comparison is required');
    const outputs: ScmDiffSummaryOutputs = { ...output.outputs };
    const summary = model.summaryMarkdown ? { summaryMarkdown: model.summaryMarkdown,
      ...(model.risks ? { risks: model.risks } : {}), ...(model.testImpact ? { testImpact: model.testImpact } : {}),
      ...(model.suggestedPrBody ? { suggestedPrBody: model.suggestedPrBody } : {}) } : undefined;
    if (summary) outputs.summary = { state: 'complete', value: summary };
    if (model.walkthrough) outputs.walkthrough = { state: 'complete', value: model.walkthrough };
    if (model.commitPlan) outputs.commitPlan = { state: 'complete', value: model.commitPlan };
    const requestedOutputs = [...new Set([...(output.requestedOutputs ?? []), ...kinds])];
    for (const kind of requestedOutputs) outputs[kind] ??= { state: 'pending' };
    assertPublishedCommitGroupsPreserved(stored, outputs.commitPlan?.value);
    const next = { ...output,
      ...(envelope ? { analysis: envelope.analysis ?? output.analysis, producer: envelope.producer ?? output.producer,
        runId: envelope.runId ?? output.runId, cost: envelope.cost ?? output.cost } : {}),
      requestedOutputs, outputs,
      ...(summary ? { summaryMarkdown: summary.summaryMarkdown, risks: summary.risks, testImpact: summary.testImpact,
        suggestedPrBody: summary.suggestedPrBody } : {}),
    };
    return ScmDiffSummaryGenerateOutputSchema.parse(next);
  }
  const store: ScmDiffSummaryResultStore = {
    async admitGeneration(input, generate) {
      await ensureProtectedLocalStateDirectory(directory);
      const identity = createHash('sha256').update(JSON.stringify([resolve(input.cwd), input.sessionId, input.key])).digest('hex');
      // Different clients reach the same machine result owner. Hold only admission;
      // native provisioning/publication use the ordinary result lock independently.
      return withJsonOwnerFileLock({ lockPath: join(directory, `generation-${identity}.lock`), timeoutMs: Infinity,
        staleAfterMs: Infinity, errorCode: 'result_unavailable', ...(input.signal ? { signal: input.signal } : {}) }, async () => {
        if (!input.bypass) {
          const inventory = await store.list();
          for (const entry of inventory.results) {
            if (entry.cwd !== resolve(input.cwd) || entry.sessionId !== input.sessionId) continue;
            const stored = await load({ ...input, resultId: entry.resultId });
            if (stored?.generation?.key !== input.key) continue;
            if (input.outputs.some(kind => !stored.result.output.outputs?.[kind])
              || (stored.generation.runId && stored.result.output.runId && stored.generation.runId !== stored.result.output.runId)) continue;
            // Start can return before the profile binds its run. This is the actual
            // admission receipt, never authority to retry or provision another run.
            return ScmDiffSummaryGenerateOutputSchema.parse({ ...stored.result.output,
              ...(!stored.result.output.runId && stored.generation.runId ? { runId: stored.generation.runId } : {}) });
          }
        }
        const output = await generate();
        if (output.resultId) {
          await locked({ ...input, resultId: output.resultId }, async (stored) => {
            if (stored) await save({ ...stored, generation: { key: input.key, ...(output.runId ? { runId: output.runId } : {}) } });
          });
        }
        return output;
      });
    },
    async list() {
      let entries: string[];
      try { entries = await readdir(directory); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { results: [], count: 0, bytes: 0 }; throw error; }
      const results: ScmDiffSummarySavedResultItem[] = [];
      for (const entry of entries.sort()) {
        if (!/^[a-f0-9-]{36}\.json$/.test(entry)) continue;
        let raw: string;
        let updatedAtMs: number;
        try { raw = await readProtectedLocalStateFile(join(directory, entry)); updatedAtMs = Math.floor((await stat(join(directory, entry))).mtimeMs); }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error; }
        const stored = storedSchema.parse(JSON.parse(raw));
        const { result } = stored;
        if (`${result.resultId}.json` !== entry || !result.output.comparison) throw new Error('Saved result inventory identity is invalid');
        results.push({ cwd: stored.cwd, ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
          resultId: result.resultId, revision: result.revision, comparisonId: result.output.comparison.id,
          ...(result.output.outputs?.walkthrough?.value ? { title: result.output.outputs.walkthrough.value.title } : {}),
          source: result.output.comparison.source, bytes: Buffer.byteLength(raw, 'utf8'), updatedAtMs });
      }
      results.sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.resultId.localeCompare(right.resultId));
      return { results, count: results.length, bytes: results.reduce((sum, item) => sum + item.bytes, 0) };
    },
    async create({ cwd, sessionId, output, generator }) {
      if (!output.comparison) throw new Error('Saved results require captured comparison evidence');
      const resultId = randomUUID();
      const result = ScmDiffSummaryResultSchema.parse({ resultId, revision: 0, output: withRevision(output, resultId, 0), canUndo: false,
        ...(generator ? { generator } : {}) });
      await ensureProtectedLocalStateDirectory(directory);
      await save({ result, cwd: resolve(cwd), ...(sessionId ? { sessionId } : {}), inputs: [] });
      return result;
    },
    async read(scope) {
      const stored = await load(scope);
      return stored ? { success: true, result: stored.result } : failure('result_not_found', 'Saved result is unavailable in this repository/session.');
    },
    async readStoredScope(scope) {
      const stored = await load(scope);
      return stored ? { cwd: stored.cwd, ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
        ...(stored.reviewFindingCitations ? { reviewFindingCitations: stored.reviewFindingCitations } : {}) } : null;
    },
    async edit(input) {
      return change(input, input.expectedRevision, (stored) => {
        const edit = ScmDiffSummaryResultEditSchema.parse(input.edit);
        const output = stored.result.output;
        if (edit.kind === 'removeOutput') {
          const remaining = (output.requestedOutputs ?? []).filter((kind) => kind !== edit.output);
          if (!output.outputs?.[edit.output]) throw new Error('That output is not part of this saved result');
          // The last output is the result itself; deleting the result is its explicit, separate operation.
          if (remaining.length === 0) throw new Error('A saved result keeps at least one output; delete the result instead');
          const { [edit.output]: _removed, ...outputs } = output.outputs;
          if (edit.output === 'commitPlan') assertPublishedCommitGroupsPreserved(stored, undefined);
          const next = ScmDiffSummaryGenerateOutputSchema.parse({ ...output, requestedOutputs: remaining, outputs,
            ...(edit.output === 'summary' ? { summaryMarkdown: undefined, risks: undefined, testImpact: undefined, suggestedPrBody: undefined } : {}) });
          const discarded = updated(stored, next, 'capture', edit);
          // A proposal's settled, unlanded application describes that proposal only; it goes with it.
          return edit.output === 'commitPlan' ? { ...discarded, result: { ...discarded.result, application: undefined } } : discarded;
        }
        const walkthrough = output.outputs?.walkthrough?.value;
        let model: ScmDiffSummaryModelOutput;
        let kind: ScmDiffSummaryOutputKind;
        if (edit.kind === 'replaceSummary') { model = edit.value; kind = 'summary'; }
        else if (edit.kind === 'replaceWalkthrough') {
          if (edit.value.stops.some(stop => stop.reviewExplanations && JSON.stringify(stop.reviewExplanations)
            !== JSON.stringify(walkthrough?.stops.find(original => original.id === stop.id)?.reviewExplanations))) {
            throw new Error('Explanation provenance is host-owned');
          }
          model = { walkthrough: edit.value }; kind = 'walkthrough';
        }
        else if (edit.kind === 'replaceCommitPlan') { model = { commitPlan: edit.value }; kind = 'commitPlan'; }
        else if (edit.kind === 'editCommitGroup' || edit.kind === 'reorderCommitGroups'
          || edit.kind === 'mergeCommitGroups' || edit.kind === 'moveCommitChanges') {
          const commitPlan = output.outputs?.commitPlan?.value;
          if (!commitPlan) throw new Error('Commit proposal output is unavailable');
          const value = { ...commitPlan, groups: commitPlan.groups.map((group) => ({ ...group, changeRefs: [...group.changeRefs] })),
            leftOutChangeRefs: [...commitPlan.leftOutChangeRefs] };
          if (edit.kind === 'editCommitGroup') {
            const group = value.groups.find((group) => group.id === edit.groupId);
            if (!group) throw new Error('Selected commit group is unavailable');
            if (edit.message !== undefined) group.message = edit.message;
            if (edit.rationale !== undefined) group.rationale = edit.rationale;
          } else if (edit.kind === 'reorderCommitGroups') {
            if (edit.groupIds.length !== value.groups.length || edit.groupIds.some((id) => !value.groups.some((group) => group.id === id))) {
              throw new Error('Reorder must contain every current commit group exactly once');
            }
            value.groups = edit.groupIds.map((id) => value.groups.find((group) => group.id === id)!);
          } else if (edit.kind === 'mergeCommitGroups') {
            const selected = value.groups.filter((group) => edit.groupIds.includes(group.id));
            if (selected.length !== edit.groupIds.length || !edit.groupIds.includes(edit.targetGroupId)) {
              throw new Error('Merge requires current selected commit groups and a selected target');
            }
            const target = selected.find((group) => group.id === edit.targetGroupId)!;
            const merged = { ...target, message: edit.message ?? target.message, rationale: edit.rationale ?? target.rationale,
              changeRefs: selected.flatMap((group) => group.changeRefs) };
            const firstIndex = value.groups.findIndex((group) => edit.groupIds.includes(group.id));
            value.groups = value.groups.flatMap((group, index) => index === firstIndex ? [merged] : edit.groupIds.includes(group.id) ? [] : [group]);
          } else {
            const selected = new Set(edit.changeRefs);
            const assigned = new Set([...value.groups.flatMap((group) => group.changeRefs), ...value.leftOutChangeRefs]);
            if (edit.changeRefs.some((ref) => !assigned.has(ref))) throw new Error('Moves require exact changes already assigned in this comparison');
            const target = edit.target;
            if (target.kind === 'newGroup') {
              if (value.groups.some((group) => group.id === target.group.id)) throw new Error('A new commit group requires a unique identity');
              value.groups.push({ ...target.group, changeRefs: [] });
            }
            const targetGroup = target.kind === 'leftOut' ? undefined
              : value.groups.find((group) => group.id === (target.kind === 'group' ? target.groupId : target.group.id));
            if (target.kind !== 'leftOut' && !targetGroup) throw new Error('Target commit group is unavailable');
            for (const group of value.groups) group.changeRefs = group.changeRefs.filter((ref) => !selected.has(ref));
            value.leftOutChangeRefs = value.leftOutChangeRefs.filter((ref) => !selected.has(ref));
            (targetGroup ? targetGroup.changeRefs : value.leftOutChangeRefs).push(...edit.changeRefs);
          }
          model = { commitPlan: value }; kind = 'commitPlan';
        }
        else {
          if (!walkthrough) throw new Error('Walkthrough output is unavailable');
          let value = { ...walkthrough, stops: walkthrough.stops.map((stop) => ({ ...stop })) };
          if (edit.kind === 'renameWalkthrough') value.title = edit.title;
          else if (edit.kind === 'reorderStops') {
            if (edit.stopIds.length !== value.stops.length || edit.stopIds.some((id) => !value.stops.some((stop) => stop.id === id))) throw new Error('Reorder must contain every current stop exactly once');
            value.stops = edit.stopIds.map((id) => value.stops.find((stop) => stop.id === id)!);
          } else if (edit.kind === 'mergeStops') {
            const selected = value.stops.filter((stop) => edit.stopIds.includes(stop.id));
            if (selected.length !== edit.stopIds.length || !edit.stopIds.includes(edit.targetStopId)) throw new Error('Merge requires current selected stops and a selected target');
            const target = selected.find((stop) => stop.id === edit.targetStopId)!;
            const merged = { ...target, title: edit.title ?? target.title, explanationMarkdown: edit.explanationMarkdown,
              changeRefs: selected.flatMap((stop) => stop.changeRefs),
              ...(selected.some((stop) => stop.findingRefs) ? { findingRefs: [...new Set(selected.flatMap((stop) => stop.findingRefs ?? []))] } : {}),
              ...(selected.some(stop => stop.reviewExplanations) ? { reviewExplanations: selected.flatMap(stop => stop.reviewExplanations ?? []) } : {}) };
            const firstIndex = value.stops.findIndex((stop) => edit.stopIds.includes(stop.id));
            value.stops = value.stops.flatMap((stop, index) => index === firstIndex ? [merged] : edit.stopIds.includes(stop.id) ? [] : [stop]);
          } else {
            const stop = value.stops.find((stop) => stop.id === edit.stopId);
            if (!stop) throw new Error('Selected stop is unavailable');
            if (edit.kind === 'renameStop') stop.title = edit.title;
            else stop.explanationMarkdown = edit.explanationMarkdown;
          }
          model = { walkthrough: value }; kind = 'walkthrough';
        }
        const normalized = normalizeScmDiffSummaryModelOutput(model, { comparison: output.comparison!, requestedOutputs: [kind],
          allowHostReviewExplanations: true, referenceMode: 'canonical',
          requireCompleteCoverage: output.outputs?.[kind]?.state === 'complete' });
        return updated(stored, replaceValues(stored, normalized, [kind]), 'capture', edit);
      });
    },
    async undo(input) {
      return change(input, input.expectedRevision, (stored) => {
        if (!stored.undoOutput) return failure('nothing_to_undo', 'There is no immediate edit to undo.');
        assertPublishedCommitGroupsPreserved(stored, stored.undoOutput.outputs?.commitPlan?.value);
        return updated(stored, { ...stored.undoOutput, runId: stored.result.output.runId,
          ...(stored.undoOutput.analysis ? { analysis: { ...stored.undoOutput.analysis,
            parts: stored.result.output.analysis?.parts } } : {}),
          producer: stored.undoOutput.producer ? { ...stored.undoOutput.producer,
            ...(stored.result.output.producer?.seededFromRunId ? { seededFromRunId: stored.result.output.producer.seededFromRunId } : {}) }
            : stored.result.output.producer,
        }, 'clear', 'undo');
      });
    },
    async delete(input) {
      return locked(input, async (stored) => {
        if (!stored) return failure('result_not_found', 'Saved result is unavailable.');
        const stale = conflict(stored, input.expectedRevision); if (stale) return stale;
        if (isScmCommitPlanApplicationLocked(stored.result.application)) return failure('application_locked', 'Resolve the accepted commit application before deleting its result.', stored.result.revision);
        await removeProtectedLocalStateFile(path(input.resultId));
        return { success: true, resultId: input.resultId, comparisonId: stored.result.output.comparison!.id };
      });
    },
    async beginInput(input) {
      return locked(input, async (stored) => {
        if (!stored) return failure('result_not_found', 'Saved result is unavailable.');
        const stale = input.expectedRevision === undefined ? null : conflict(stored, input.expectedRevision); if (stale) return stale;
        if (isScmCommitPlanApplicationLocked(stored.result.application)) return failure('application_locked', 'Resolve the accepted commit application before requesting output.', stored.result.revision);
        // A refinement Action has already bound this input's base before Pending admission.
        if (stored.inputs.some((pending) => pending.inputId === input.inputId)) return { success: true, result: stored.result };
        const outputs = input.outputs ?? stored.result.output.requestedOutputs ?? ['summary'];
        if (input.stopIds && (!outputs.includes('walkthrough') || input.stopIds.some((id) => !stored.result.output.outputs?.walkthrough?.value?.stops.some((stop) => stop.id === id)))) {
          return failure('invalid_edit', 'Targeted stops must exist in the saved walkthrough.');
        }
        if (outputs.includes('commitPlan') && stored.result.output.comparison?.source.kind !== 'workingTree') return failure('invalid_edit', 'Commit proposals require a pending comparison.');
        const explanation = input.reviewExplanation ? explanationRequestSchema.parse(input.reviewExplanation) : undefined;
        if (explanation && (outputs.length !== 1 || outputs[0] !== 'walkthrough' || !input.stopIds
          || explanation.targets.length !== input.stopIds.length || explanation.targets.some(target => !input.stopIds!.includes(target.stopId)))) {
          return failure('invalid_edit', 'Finding explanations must target exactly the selected walkthrough stops.');
        }
        const citations = input.reviewFindingCitations === undefined ? stored.reviewFindingCitations
          : reviewFindingCitationsSchema.parse(input.reviewFindingCitations);
        if (citations) stored.reviewFindingCitations = citations;
        stored.inputs.push(pendingInputSchema.parse({ inputId: input.inputId, baseRevision: stored.result.revision,
          outputs, ...(input.stopIds ? { stopIds: input.stopIds } : {}),
          ...(citations ? { reviewFindingCitations: citations } : {}),
          ...(explanation ? { reviewExplanation: { ...explanation, requestedAtMs: explanation.requestedAtMs ?? Date.now() } } : {}) }));
        await save(stored);
        return { success: true, result: stored.result };
      });
    },
    async beginRefinement(input) { return store.beginInput({ ...input, outputs: [input.output] }); },
    async readInput(input) {
      const stored = await load(input);
      return stored?.inputs.find((pending) => input.inputIds.includes(pending.inputId)) ?? null;
    },
    async abandonInput(input) {
      await locked(input, async (stored) => {
        if (!stored) return;
        stored.inputs = stored.inputs.filter((pending) => pending.inputId !== input.inputId);
        await save(stored);
      });
    },
    async bindRun(input) {
      return change(input, input.expectedRevision, (stored) => updated({ ...stored,
        result: { ...stored.result, ...(input.generator ? { generator: input.generator } : {}) } }, {
        ...stored.result.output, runId: input.runId,
        producer: { ...stored.result.output.producer, kind: stored.result.output.producer?.kind ?? 'generation',
          runId: stored.result.output.producer?.runId ?? input.runId,
          ...(input.seededFromRunId ? { seededFromRunId: input.seededFromRunId } : {}) },
      }, 'preserve'));
    },
    async publish(input) {
      return locked(input, async (stored) => {
        if (!stored) return failure('result_not_found', 'Saved result is unavailable.');
        if (input.runId && stored.result.output.runId && input.runId !== stored.result.output.runId) {
          return failure('invalid_output', 'This generator was replaced for the saved result.');
        }
        if (isScmCommitPlanApplicationLocked(stored.result.application)) return failure('application_locked', 'Structured output cannot replace an accepted commit application.', stored.result.revision);
        const pending = stored.inputs.find((request) => request.inputId === input.inputId);
        if (!pending) return failure('invalid_output', 'The structured output has no admitted revision basis.');
        const stale = conflict(stored, pending.baseRevision); if (stale) return stale;
        try {
          if (pending.reviewExplanation) {
            const incoming = ScmDiffSummaryModelOutputSchema.parse(input.modelOutput);
            const blocks = incoming.reviewExplanations;
            const current = stored.result.output.outputs?.walkthrough?.value;
            const targets = pending.reviewExplanation.targets;
            if (!blocks || !current || Object.keys(incoming).length !== 1 || blocks.length !== targets.length
              || new Set(blocks.map(block => block.stopId)).size !== targets.length
              || blocks.some(block => !targets.some(target => target.stopId === block.stopId))) {
              throw new Error('Finding explanation output must contain only the exact admitted stop explanations');
            }
            const generatedAtMs = input.generatedAtMs ?? Date.now();
            const walkthrough = { ...current, stops: current.stops.map(stop => {
              const block = blocks.find(value => value.stopId === stop.id);
              if (!block) return stop;
              const refs = targets.find(target => target.stopId === stop.id)!.findingRefs;
              const aliases = (pending.reviewFindingCitations ?? []).filter(item => refs.some(ref => ref.runId === item.runId && ref.findingId === item.findingId)
                && stop.findingRefs?.includes(`${item.runId}:${item.findingId}`)).map(item => item.alias);
              return { ...stop, reviewExplanations: [{ markdown: publishFindingCitationMarkdown(block.markdown, aliases, pending.reviewFindingCitations ?? []),
                findingRefs: targets.find(target => target.stopId === stop.id)!.findingRefs,
                provenance: { requestedBy: pending.reviewExplanation!.requestedBy,
                  requestedAtMs: pending.reviewExplanation!.requestedAtMs!, generatedAtMs,
                  ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.runId ? { runId: input.runId } : {}) } }] };
            }) };
            const next = updated(stored, replaceValues(stored, { walkthrough }, pending.outputs));
            next.inputs = next.inputs.filter(request => request.inputId !== input.inputId);
            await save(next);
            return { success: true, result: next.result };
          }
          let normalized = publishReviewFindingCitations(normalizeScmDiffSummaryModelOutput(input.modelOutput, { comparison: stored.result.output.comparison!,
            requestedOutputs: pending.outputs, requireCompleteCoverage: !pending.stopIds }), pending.reviewFindingCitations ?? []);
          if (pending.stopIds) {
            const current = stored.result.output.outputs?.walkthrough?.value;
            const incoming = normalized.walkthrough;
            if (!current || !incoming) throw new Error('Targeted refinement requires structured walkthrough stops');
            const selected = current.stops.filter((stop) => pending.stopIds!.includes(stop.id));
            const selectedRefs = new Set(selected.flatMap((stop) => stop.changeRefs));
            const incomingRefs = incoming.stops.flatMap((stop) => stop.changeRefs);
            if (incoming.otherChangeRefs.length || incomingRefs.length !== selectedRefs.size
              || incomingRefs.some((ref) => !selectedRefs.has(ref)) || incoming.stops.some((stop) => !pending.stopIds!.includes(stop.id))) {
              throw new Error('Targeted refinement must preserve exactly its selected coverage and stop identities');
            }
            const firstIndex = current.stops.findIndex((stop) => pending.stopIds!.includes(stop.id));
            const stops = current.stops.flatMap((stop, index) => index === firstIndex
              ? incoming.stops.map((refined) => ({ ...refined, title: selected.find((original) => original.id === refined.id)!.title }))
              : pending.stopIds!.includes(stop.id) ? [] : [stop]);
            normalized = { walkthrough: { ...current, stops } };
          }
          if (normalized.walkthrough) normalized = { ...normalized, walkthrough: preserveReviewExplanations(
            normalized.walkthrough, stored.result.output.outputs?.walkthrough?.value) };
          const next = updated(stored, replaceValues(stored, normalized, pending.outputs, input.outputEnvelope));
          next.inputs = next.inputs.filter((request) => request.inputId !== input.inputId);
          await save(next);
          return { success: true, result: next.result };
        } catch (error) { return failure('invalid_output', error instanceof Error ? error.message : 'Invalid structured output'); }
      });
    },
    async publishProgress(input) {
      return change(input, input.expectedRevision, (stored) => {
        if (input.output.runId && stored.result.output.runId && input.output.runId !== stored.result.output.runId) {
          return failure('invalid_output', 'This generator was replaced for the saved result.');
        }
        if (input.output.comparison?.id !== stored.result.output.comparison?.id) return failure('invalid_output', 'Publication belongs to a different comparison.');
        try { assertPublishedCommitGroupsPreserved(stored, input.output.outputs?.commitPlan?.value); }
        catch (error) { return failure('invalid_output', error instanceof Error ? error.message : 'Publication changed landed commit proposals'); }
        const walkthrough = input.output.outputs?.walkthrough?.value;
        const previous = stored.result.output.outputs?.walkthrough?.value;
        const pending = input.inputId ? stored.inputs.find(request => request.inputId === input.inputId) : undefined;
        if (input.inputId && (!pending || pending.baseRevision !== input.expectedRevision)) {
          return failure('invalid_output', 'Progressive output requires its exact admitted revision basis.');
        }
        const citations = pending?.reviewFindingCitations ?? stored.reviewFindingCitations ?? [];
        const sanitized = walkthrough ? publishReviewFindingCitations({ walkthrough }, citations).walkthrough! : undefined;
        const output = walkthrough && sanitized ? { ...input.output, outputs: { ...input.output.outputs,
          walkthrough: { ...input.output.outputs!.walkthrough!, value: { ...sanitized, stops: sanitized.stops.map((stop, index) => {
            const original = walkthrough.stops[index]!;
            if (!previous?.stops.some(saved => JSON.stringify(saved) === JSON.stringify(original))) return stop;
            const refs = (original.findingRefs ?? []).filter(ref => citations.some(item => `${item.runId}:${item.findingId}` === ref));
            return { ...original, ...(original.findingRefs ? { findingRefs: refs } : {}),
              explanationMarkdown: validatePublishedFindingCitationMarkdown(original.explanationMarkdown, refs, citations),
              ...(original.reviewExplanations ? { reviewExplanations: original.reviewExplanations.map(block => ({ ...block,
                markdown: validatePublishedFindingCitationMarkdown(block.markdown, block.findingRefs.map(ref => `${ref.runId}:${ref.findingId}`)
                  .filter(ref => refs.includes(ref)), citations) })) } : {}) };
          }) } } } } : input.output;
        const next = updated(stored, output, input.preserveUndo ? 'preserve'
          : Object.values(stored.result.output.outputs ?? {}).some((output) => output?.value !== undefined) ? 'capture' : 'clear');
        // This same admitted input changed only host progress, not its editable
        // output basis. Preserve that exact basis; unrelated pending inputs stay stale.
        if (pending && input.preserveUndo && JSON.stringify(stored.result.output.outputs) === JSON.stringify(output.outputs)) {
          next.inputs = next.inputs.map(request => request.inputId === pending.inputId
            ? { ...request, baseRevision: next.result.revision } : request);
        }
        return next;
      });
    },
    async beginApplication(input) {
      return locked(input, async (stored) => {
        if (!stored) return failure('result_not_found', 'Saved result is unavailable.');
        const stale = conflict(stored, input.expectedRevision); if (stale) return stale;
        if (isScmCommitPlanApplicationLocked(stored.result.application)) return failure('application_locked', 'The accepted application must be resolved first.', stored.result.revision);
        const comparison = stored.result.output.comparison;
        if (comparison?.source.kind !== 'workingTree') return failure('source_not_pending', 'Only pending changes can authorize commits.');
        const plan = stored.result.output.outputs?.commitPlan;
        if (plan?.state !== 'complete' || !plan.value) return failure('plan_unavailable', 'A complete editable proposal is required.');
        const acceptance = ScmCommitPlanAcceptanceSchema.parse(input.acceptance);
        const prior = stored.result.application;
        const prefix = prior?.steps.filter((step) => step.state === 'published') ?? [];
        // Fresh acceptance may consume only the verified remaining suffix. Landed commits are never rewritten.
        const expectedGroups = plan.value.groups.filter((group) => !prefix.some((step) => step.groupId === group.id));
        if (acceptance.comparisonId !== comparison.id || acceptance.repositoryRootPath !== comparison.repository.rootPath
          || JSON.stringify(acceptance.groups) !== JSON.stringify(expectedGroups)
          || JSON.stringify(acceptance.leftOutChangeRefs) !== JSON.stringify(plan.value.leftOutChangeRefs)
          || acceptance.groups.some((group) => !group.changeRefs.length)) {
          return failure('acceptance_mismatch', 'Acceptance must bind the current exact ordered groups, messages and exclusions.');
        }
        normalizeScmDiffSummaryModelOutput({ commitPlan: plan.value }, { comparison, requestedOutputs: ['commitPlan'], requireCompleteCoverage: true,
          referenceMode: 'canonical' });
        const application = ScmCommitPlanApplicationSchema.parse({ acceptedRevision: stored.result.revision, acceptance,
          status: 'applying', steps: [...prefix, ...acceptance.groups.map((group) => ({ groupId: group.id, state: 'pending' }))],
          nextGroupIndex: prefix.length, stopAfterCurrent: false });
        const next = updated(stored, stored.result.output, 'preserve');
        next.result.application = application;
        await save(next);
        return { success: true, result: next.result };
      });
    },
    async mutateApplication(scope, transition) {
      return locked(scope, async (stored) => {
        if (!stored) return failure('result_not_found', 'Saved result is unavailable.');
        if (!stored.result.application) return failure('application_unavailable', 'No accepted commit application exists.');
        const application = transition(stored.result);
        if ('success' in application) return application;
        const next = updated(stored, stored.result.output, 'preserve');
        next.result.application = ScmCommitPlanApplicationSchema.parse(application);
        await save(next);
        return { success: true, result: next.result };
      });
    },
  };
  return store;
}

let defaultStore: ScmDiffSummaryResultStore | undefined;
function currentStore() {
  return defaultStore ??= createScmDiffSummaryResultStore({ directory: join(configuration.activeServerDir, 'runtime', 'scm', 'results') });
}
export const scmDiffSummaryResultStore: ScmDiffSummaryResultStore = {
  admitGeneration: (input, generate) => currentStore().admitGeneration(input, generate),
  list: () => currentStore().list(),
  create: (input) => currentStore().create(input), read: (input) => currentStore().read(input),
  readStoredScope: (input) => currentStore().readStoredScope(input), edit: (input) => currentStore().edit(input),
  undo: (input) => currentStore().undo(input), delete: (input) => currentStore().delete(input),
  beginInput: (input) => currentStore().beginInput(input), beginRefinement: (input) => currentStore().beginRefinement(input),
  readInput: (input) => currentStore().readInput(input),
  abandonInput: (input) => currentStore().abandonInput(input), bindRun: (input) => currentStore().bindRun(input),
  publish: (input) => currentStore().publish(input), publishProgress: (input) => currentStore().publishProgress(input),
  beginApplication: (input) => currentStore().beginApplication(input),
  mutateApplication: (scope, transition) => currentStore().mutateApplication(scope, transition),
};
