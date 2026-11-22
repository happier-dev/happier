import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ScmComparisonSchema, ScmComparisonSourceSchema, type ScmComparison } from './comparison.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { buildScmChangeKeys, buildScmReviewScopeId } from './comparisonOccurrences.js';

/** Workspace's existing Account JSON namespace owns mode admission and transition inventory. */
export const SCM_REVIEWED_MARKS_KV_PREFIX = 'workspace:scm-reviewed:scope:';
const changeRefs = z.array(z.string().check(z.minLength(1))).check(z.refine(refs => new Set(refs).size === refs.length, 'Change references must be unique'));
export const ScmReviewedMarksRecordSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), scopeId: z.string().check(z.minLength(1)), reviewedChangeKeys: changeRefs,
  viewedFiles: z.optional(z.array(z.strictObject({ path: z.string().check(z.minLength(1)), changeKeys: changeRefs }))),
}));
const storedReviewedMarksRecordSchema = createStoredReadSchema(ScmReviewedMarksRecordSchema);
export type ScmReviewedMarksRecord = z.infer<typeof ScmReviewedMarksRecordSchema>;
const selectedChangeRefs = changeRefs.check(z.refine(refs => refs.length > 0, 'An explicit selection is required'));
export const ScmReviewedMarkInputSchema = lazyZodSchema(() => z.union([
  // Preserve the existing saved-result selector. The new authority-bearing arm
  // has an explicit epoch so an older terminal rejects it before Account writes.
  z.strictObject({ cwd: z.string().check(z.minLength(1)), resultId: z.string().check(z.minLength(1)), changeRefs: selectedChangeRefs }),
  z.strictObject({ v: z.literal(2), cwd: z.string().check(z.minLength(1)), comparisonId: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
    source: ScmComparisonSourceSchema, sessionId: z.optional(z.string().check(z.minLength(1))), changeRefs: selectedChangeRefs }),
  z.strictObject({ v: z.literal(2), cwd: z.string().check(z.minLength(1)), source: ScmComparisonSourceSchema,
    comparisonId: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
    sessionId: z.optional(z.string().check(z.minLength(1))), changeKeys: selectedChangeRefs }),
]));
export type ScmReviewedMarkInput = z.infer<typeof ScmReviewedMarkInputSchema>;
// Reset accepts the same opaque identity as the saved-result/capture owner.
// The host validates it against retained evidence before any Account mutation.
export const ScmReviewedMarksResetInputSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), cwd: z.string().check(z.minLength(1)), source: ScmComparisonSourceSchema,
  comparisonId: z.optional(z.string().check(z.minLength(1))),
  sessionId: z.optional(z.string().check(z.minLength(1))), reset: z.literal(true),
}).check(z.refine(input => input.comparisonId !== undefined || input.source.kind === 'workingTree', 'A captured source requires its comparison identity')));
export type ScmReviewedMarksResetInput = z.infer<typeof ScmReviewedMarksResetInputSchema>;
export const ScmReviewedUnmarkInputSchema = lazyZodSchema(() => z.union([
  ScmReviewedMarkInputSchema,
  // Reset clears the stable scope, including retained keys absent from this capture.
  // Only unmark accepts it; an older strict reader refuses before Account writes.
  ScmReviewedMarksResetInputSchema,
]));
export type ScmReviewedUnmarkInput = z.infer<typeof ScmReviewedUnmarkInputSchema>;
export const ScmReviewedMarkResponseSchema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), record: ScmReviewedMarksRecordSchema, version: z.number().check(z.int(), z.minimum(-1)) }),
  z.strictObject({ success: z.literal(false), errorCode: z.string().check(z.minLength(1)), error: z.string().check(z.minLength(1)),
    record: z.optional(ScmReviewedMarksRecordSchema), version: z.optional(z.number().check(z.int(), z.minimum(-1))) }),
]));
export type ScmReviewedMarkResponse = z.infer<typeof ScmReviewedMarkResponseSchema>;
export type ScmReviewedMarksJsonSnapshot = Readonly<{ value: unknown | null; version: number; tombstone?: true }>;
export type ScmReviewedMarksJsonTransport = Readonly<{
  read: () => Promise<ScmReviewedMarksJsonSnapshot>;
  compareAndSet: (value: unknown, version: number) => Promise<Readonly<{ success: true; version: number }>
    | (ScmReviewedMarksJsonSnapshot & Readonly<{ success: false }>)>;
}>;

export class ScmReviewedMarksError extends Error {
  constructor(readonly code: 'reviewed_marks_invalid_record' | 'reviewed_marks_invalid_selection', message: string) { super(message); }
}
export function buildScmReviewedMarksKey(scopeId: string): string {
  return SCM_REVIEWED_MARKS_KV_PREFIX + encodeURIComponent(z.string().check(z.minLength(1)).parse(scopeId));
}
export function parseScmReviewedMarksRecord(comparison: ScmComparison, value: unknown): ScmReviewedMarksRecord {
  return parseScmReviewedMarksRecordForId(buildScmReviewScopeId({ repositoryRootPath: comparison.repository.rootPath, source: comparison.source }), value);
}
function parseScmReviewedMarksRecordForId(scopeId: string, value: unknown): ScmReviewedMarksRecord {
  if (value === null) return { v: 1, scopeId, reviewedChangeKeys: [] };
  const parsed = storedReviewedMarksRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.scopeId !== scopeId) {
    throw new ScmReviewedMarksError('reviewed_marks_invalid_record', 'Reviewed marks do not identify this review scope');
  }
  return parsed.data;
}

function parseScmReviewedMarksSnapshot(scopeId: string, snapshot: ScmReviewedMarksJsonSnapshot) {
  if (snapshot.value === null && snapshot.version !== -1 && !snapshot.tombstone) {
    throw new ScmReviewedMarksError('reviewed_marks_invalid_record', 'A stored JSON null is not a reviewed-mark record');
  }
  return { record: parseScmReviewedMarksRecordForId(scopeId, snapshot.value), version: snapshot.version };
}
async function writeScmReviewedMarksIntent(params: Readonly<{
  transport: ScmReviewedMarksJsonTransport;
  parseSnapshot: (snapshot: ScmReviewedMarksJsonSnapshot) => Readonly<{ record: ScmReviewedMarksRecord; version: number }>;
  apply: (record: ScmReviewedMarksRecord) => ScmReviewedMarksRecord;
}>): Promise<ScmReviewedMarkResponse> {
  let current = params.parseSnapshot(await params.transport.read());
  const writeIntent = async () => {
    const record = params.apply(current.record);
    if (record.reviewedChangeKeys.length === current.record.reviewedChangeKeys.length
      && record.reviewedChangeKeys.every((key, index) => key === current.record.reviewedChangeKeys[index])
      && JSON.stringify(record.viewedFiles) === JSON.stringify(current.record.viewedFiles)) {
      return { success: true as const, record: current.record, version: current.version };
    }
    const result = await params.transport.compareAndSet(record, current.version);
    return result.success ? { success: true as const, record, version: result.version }
      : { success: false as const, ...params.parseSnapshot(result) };
  };
  const initial = await writeIntent();
  if (initial.success) return initial;
  current = initial;
  // One existing intent rebase. Further races remain visible for explicit recovery.
  const reconciled = await writeIntent();
  return reconciled.success ? reconciled : { ...reconciled, errorCode: 'reviewed_marks_conflict', error: 'Reviewed marks changed concurrently' };
}
/** Reset review is explicit and applies to the stable content scope. */
export function clearScmReviewedMarksRecord(params: Readonly<{
  scopeId: string; transport: ScmReviewedMarksJsonTransport;
}>): Promise<ScmReviewedMarkResponse> {
  const scopeId = z.string().check(z.minLength(1)).parse(params.scopeId);
  return writeScmReviewedMarksIntent({ transport: params.transport,
    parseSnapshot: snapshot => parseScmReviewedMarksSnapshot(scopeId, snapshot),
    apply: () => ({ v: 1, scopeId, reviewedChangeKeys: [] }),
  });
}
export function applyScmReviewedMarkIntent(comparison: ScmComparison, value: unknown, refs: readonly string[], reviewed: boolean): ScmReviewedMarksRecord {
  const record = parseScmReviewedMarksRecord(comparison, value);
  const ids = new Set(comparison.inventory.files.flatMap(file => file.occurrences.map(occurrence => occurrence.id)));
  if (new Set(refs).size !== refs.length || refs.some(ref => !ids.has(ref))) {
    throw new ScmReviewedMarksError('reviewed_marks_invalid_selection', 'Marking requires exact captured change references');
  }
  const keysByRef = buildScmChangeKeys(comparison);
  if (refs.some(ref => (keysByRef.get(ref)?.length ?? 0) === 0)) {
    throw new ScmReviewedMarksError('reviewed_marks_invalid_selection', 'Captured content evidence is unavailable for this selection');
  }
  return applyScmReviewedKeysIntent(record.scopeId, record, [...new Set(refs.flatMap(ref => keysByRef.get(ref) ?? []))], reviewed, comparison);
}
const fileKeysByComparison = new WeakMap<ScmComparison, ReadonlyMap<string, readonly string[]>>();

function buildScmViewedFileKeys(comparison: ScmComparison): ReadonlyMap<string, readonly string[]> {
  const retained = fileKeysByComparison.get(comparison);
  if (retained) return retained;
  const byRef = buildScmChangeKeys(comparison);
  const files = new Map<string, readonly string[]>();
  for (const file of comparison.inventory.files) {
    const refs = file.occurrences.map(occurrence => byRef.get(occurrence.id) ?? []);
    if (refs.length > 0 && refs.every(keys => keys.length > 0)) files.set(file.path, [...new Set(refs.flat())]);
  }
  fileKeysByComparison.set(comparison, files);
  return files;
}

/** The same content keys decide current membership and whether earlier viewed files changed. */
export function projectScmViewedFiles(comparison: ScmComparison, record: ScmReviewedMarksRecord | null) {
  const viewedPaths = new Set<string>();
  let changedSinceViewedCount = 0;
  const scopeId = buildScmReviewScopeId({ repositoryRootPath: comparison.repository.rootPath, source: comparison.source });
  if (record?.scopeId === scopeId) {
    const reviewed = new Set(record.reviewedChangeKeys);
    const previouslyViewed = new Set(record.viewedFiles?.map(file => file.path));
    for (const [path, keys] of buildScmViewedFileKeys(comparison)) {
      if (keys.every(key => reviewed.has(key))) viewedPaths.add(path);
      else if (previouslyViewed.has(path)) changedSinceViewedCount += 1;
    }
  }
  return { viewedPaths, changedSinceViewedCount };
}

export function applyScmReviewedKeysIntent(scopeId: string, value: unknown, keys: readonly string[], reviewed: boolean,
  comparison?: ScmComparison): ScmReviewedMarksRecord {
  const record = parseScmReviewedMarksRecordForId(scopeId, value);
  if (new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || key.length === 0)) {
    throw new ScmReviewedMarksError('reviewed_marks_invalid_selection', 'Marking requires unique content keys');
  }
  const selected = new Set(keys);
  const reviewedKeys = new Set(record.reviewedChangeKeys);
  if (reviewed) for (const key of selected) reviewedKeys.add(key);
  else for (const key of selected) reviewedKeys.delete(key);
  const viewed = new Map(record.viewedFiles?.map(file => [file.path, file]));
  if (!reviewed) {
    for (const [path, file] of viewed) if (file.changeKeys.some(key => selected.has(key))) viewed.delete(path);
  } else if (comparison && comparison.source.kind !== 'pullRequest') {
    for (const [path, changeKeys] of buildScmViewedFileKeys(comparison)) {
      if (changeKeys.some(key => selected.has(key)) && changeKeys.every(key => reviewedKeys.has(key))) {
        viewed.set(path, { path, changeKeys: [...changeKeys] });
      }
    }
  }
  const { viewedFiles: _previous, ...base } = record;
  return { ...base, reviewedChangeKeys: [...reviewedKeys], ...(viewed.size ? { viewedFiles: [...viewed.values()] } : {}) };
}

export type ScmReviewedMarksSource = Readonly<{ repositoryRootPath: string; source: ScmComparison['source']; changeKeys: readonly string[] }>;
export type ScmReviewedMarksSelection = Readonly<{ comparison: ScmComparison; source?: never } | { comparison?: never; source: ScmReviewedMarksSource }>;

/** Both UI and agent Actions apply the same intent to the latest per-key CAS winner. */
export function createScmReviewedMarksRecordPort(params: ScmReviewedMarksSelection & Readonly<{
  transport: ScmReviewedMarksJsonTransport;
  /** A mounted scope may receive new displayed evidence while its Account observer stays mounted. */
  getSelection?: () => ScmReviewedMarksSelection;
}>) {
  const comparison = params.comparison ? ScmComparisonSchema.parse(params.comparison) : null;
  const scopeId = buildScmReviewScopeId(comparison ? { repositoryRootPath: comparison.repository.rootPath, source: comparison.source } : params.source!);
  const currentSelection = () => {
    const selected = params.getSelection?.() ?? (comparison ? { comparison } : { source: params.source! });
    const scope = selected.comparison ? { repositoryRootPath: selected.comparison.repository.rootPath, source: selected.comparison.source } : selected.source;
    if (buildScmReviewScopeId(scope) !== scopeId) throw new ScmReviewedMarksError('reviewed_marks_invalid_selection', 'The displayed review scope changed');
    return selected;
  };
  const parseSnapshot = (snapshot: ScmReviewedMarksJsonSnapshot) => {
    return parseScmReviewedMarksSnapshot(scopeId, snapshot);
  };
  const read = async () => parseSnapshot(await params.transport.read());
  const setReviewed = async (refs: readonly string[], reviewed: boolean): Promise<ScmReviewedMarkResponse> => {
    // Validate the explicit intent before reading or writing Account data.
    const comparison = currentSelection().comparison;
    if (!comparison) throw new ScmReviewedMarksError('reviewed_marks_invalid_selection', 'Captured evidence is required for occurrence references');
    applyScmReviewedMarkIntent(comparison, null, refs, reviewed);
    return writeScmReviewedMarksIntent({ transport: params.transport, parseSnapshot,
      apply: record => applyScmReviewedMarkIntent(comparison, record, refs, reviewed) });
  };
  const setReviewedKeys = (keys: readonly string[], reviewed: boolean): Promise<ScmReviewedMarkResponse> => {
    const selected = currentSelection();
    const allowedKeys = new Set(selected.comparison ? [...buildScmChangeKeys(selected.comparison).values()].flat() : selected.source.changeKeys);
    if (keys.some(key => !allowedKeys.has(key))) throw new ScmReviewedMarksError('reviewed_marks_invalid_selection', 'Content keys do not belong to the displayed evidence');
    applyScmReviewedKeysIntent(scopeId, null, keys, reviewed);
    return writeScmReviewedMarksIntent({ transport: params.transport, parseSnapshot,
      apply: record => applyScmReviewedKeysIntent(scopeId, record, keys, reviewed, selected.comparison) });
  };
  return { read, setReviewed, setReviewedKeys, clear: () => { currentSelection(); return clearScmReviewedMarksRecord({ scopeId, transport: params.transport }); } };
}
