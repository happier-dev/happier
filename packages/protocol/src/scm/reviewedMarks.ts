import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ScmComparisonSchema, type ScmComparison } from './comparison.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

/** Workspace's existing Account JSON namespace owns mode admission and transition inventory. */
export const SCM_REVIEWED_MARKS_KV_PREFIX = 'workspace:scm-reviewed:v1:';
const changeRefs = z.array(z.string().min(1)).refine(refs => new Set(refs).size === refs.length, 'Change references must be unique');
export const ScmReviewedMarksRecordSchema = lazyZodSchema(() => z.object({
  v: z.literal(1), comparisonId: z.string().min(1), reviewedChangeRefs: changeRefs,
}).strict());
const storedReviewedMarksRecordSchema = createStoredReadSchema(ScmReviewedMarksRecordSchema);
export type ScmReviewedMarksRecord = z.infer<typeof ScmReviewedMarksRecordSchema>;
export const ScmReviewedMarkInputSchema = lazyZodSchema(() => z.object({
  cwd: z.string().min(1), resultId: z.string().min(1), changeRefs: changeRefs.refine(refs => refs.length > 0, 'An explicit selection is required'),
}).strict());
export type ScmReviewedMarkInput = z.infer<typeof ScmReviewedMarkInputSchema>;
export const ScmReviewedMarkResponseSchema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), record: ScmReviewedMarksRecordSchema, version: z.number().int().min(-1) }).strict(),
  z.object({ success: z.literal(false), errorCode: z.string().min(1), error: z.string().min(1),
    record: ScmReviewedMarksRecordSchema.optional(), version: z.number().int().min(-1).optional() }).strict(),
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
export function buildScmReviewedMarksKey(comparisonId: string): string {
  return SCM_REVIEWED_MARKS_KV_PREFIX + encodeURIComponent(z.string().min(1).parse(comparisonId));
}
export function parseScmReviewedMarksRecord(comparison: ScmComparison, value: unknown): ScmReviewedMarksRecord {
  const record = parseScmReviewedMarksRecordForId(comparison.id, value);
  const ids = new Set(comparison.inventory.files.flatMap(file => file.occurrences.map(occurrence => occurrence.id)));
  if (record.reviewedChangeRefs.some(ref => !ids.has(ref))) {
    throw new ScmReviewedMarksError('reviewed_marks_invalid_record', 'Reviewed marks do not identify this exact comparison');
  }
  return record;
}
function parseScmReviewedMarksRecordForId(comparisonId: string, value: unknown): ScmReviewedMarksRecord {
  if (value === null) return { v: 1, comparisonId, reviewedChangeRefs: [] };
  const parsed = storedReviewedMarksRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.comparisonId !== comparisonId) {
    throw new ScmReviewedMarksError('reviewed_marks_invalid_record', 'Reviewed marks do not identify this exact comparison');
  }
  return parsed.data;
}

function parseScmReviewedMarksSnapshot(comparisonId: string, snapshot: ScmReviewedMarksJsonSnapshot) {
  if (snapshot.value === null && snapshot.version !== -1 && !snapshot.tombstone) {
    throw new ScmReviewedMarksError('reviewed_marks_invalid_record', 'A stored JSON null is not a reviewed-mark record');
  }
  return { record: parseScmReviewedMarksRecordForId(comparisonId, snapshot.value), version: snapshot.version };
}
async function writeScmReviewedMarksIntent(params: Readonly<{
  transport: ScmReviewedMarksJsonTransport;
  parseSnapshot: (snapshot: ScmReviewedMarksJsonSnapshot) => Readonly<{ record: ScmReviewedMarksRecord; version: number }>;
  apply: (record: ScmReviewedMarksRecord) => ScmReviewedMarksRecord;
}>): Promise<ScmReviewedMarkResponse> {
  let current = params.parseSnapshot(await params.transport.read());
  const writeIntent = async () => {
    const record = params.apply(current.record);
    if (record.reviewedChangeRefs.length === current.record.reviewedChangeRefs.length
      && record.reviewedChangeRefs.every((ref, index) => ref === current.record.reviewedChangeRefs[index])) {
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
/** Explicit result deletion needs the exact comparison identity, not its deleted code. */
export function clearScmReviewedMarksRecord(params: Readonly<{
  comparisonId: string; transport: ScmReviewedMarksJsonTransport;
}>): Promise<ScmReviewedMarkResponse> {
  const comparisonId = z.string().min(1).parse(params.comparisonId);
  return writeScmReviewedMarksIntent({ transport: params.transport,
    parseSnapshot: snapshot => parseScmReviewedMarksSnapshot(comparisonId, snapshot),
    apply: record => ({ ...record, reviewedChangeRefs: [] }),
  });
}
export function applyScmReviewedMarkIntent(comparison: ScmComparison, value: unknown, refs: readonly string[], reviewed: boolean): ScmReviewedMarksRecord {
  const record = parseScmReviewedMarksRecord(comparison, value);
  const ids = new Set(comparison.inventory.files.flatMap(file => file.occurrences.map(occurrence => occurrence.id)));
  if (new Set(refs).size !== refs.length || refs.some(ref => !ids.has(ref))) {
    throw new ScmReviewedMarksError('reviewed_marks_invalid_selection', 'Marking requires exact captured change references');
  }
  const selected = new Set(refs);
  const next = reviewed ? [...record.reviewedChangeRefs, ...refs.filter(ref => !record.reviewedChangeRefs.includes(ref))]
    : record.reviewedChangeRefs.filter(ref => !selected.has(ref));
  return { ...record, reviewedChangeRefs: next };
}
export function isScmSelectionReviewed(record: ScmReviewedMarksRecord | null, comparisonId: string, refs: readonly string[]): boolean {
  if (!record || record.comparisonId !== comparisonId || refs.length === 0) return false;
  const marked = new Set(record.reviewedChangeRefs);
  return refs.every(ref => marked.has(ref));
}

/** Both UI and agent Actions apply the same intent to the latest per-key CAS winner. */
export function createScmReviewedMarksRecordPort(params: Readonly<{ comparison: ScmComparison; transport: ScmReviewedMarksJsonTransport }>) {
  const comparison = ScmComparisonSchema.parse(params.comparison);
  const parseSnapshot = (snapshot: ScmReviewedMarksJsonSnapshot) => {
    const parsed = parseScmReviewedMarksSnapshot(comparison.id, snapshot);
    return { ...parsed, record: parseScmReviewedMarksRecord(comparison, parsed.record) };
  };
  const read = async () => parseSnapshot(await params.transport.read());
  const setReviewed = async (refs: readonly string[], reviewed: boolean): Promise<ScmReviewedMarkResponse> => {
    // Validate the explicit intent before reading or writing Account data.
    applyScmReviewedMarkIntent(comparison, null, refs, reviewed);
    return writeScmReviewedMarksIntent({ transport: params.transport, parseSnapshot,
      apply: record => applyScmReviewedMarkIntent(comparison, record, refs, reviewed) });
  };
  return { read, setReviewed, clear: () => clearScmReviewedMarksRecord({ comparisonId: comparison.id, transport: params.transport }) };
}
