/**
 * Step ② of a change request, as one answer every source's story rail draws: the
 * whole-change totals, the largest files and how many more there are. Pure, so the
 * shared step and its tests read one answer.
 */

/** One changed file as its source read it. */
export type TriageChangedFileV1 = Readonly<{
  path: string;
  /** Lines added and removed, only where the provider reports them for this file. */
  lines?: Readonly<{ additions: number; deletions: number }>;
  /** The provider's own word for the change ("edit", "renamed"), for a file without line counts. */
  note?: string;
}>;

/** The provider's own whole-change counts, when it states them. */
export type TriageChangeTotalsV1 = Readonly<{ files: number; additions?: number; deletions?: number }>;

export type TriageChangeSummaryV1 = Readonly<{
  /** Lines added and removed in the whole change; `null` when the provider reports no line counts. */
  lines: Readonly<{ additions: number; deletions: number }> | null;
  /** Changed files the totals speak for. */
  fileCount: number;
  /** False while the counts cover only the pages read so far ("in 12+ files"). */
  complete: boolean;
  /** The files drawn: the largest by lines changed, or the provider's order without line counts. */
  files: readonly TriageChangedFileV1[];
  /** Whether `files` are the largest ("N smaller files") or simply the first ("N more files"). */
  sortedBySize: boolean;
  /** Changed files not drawn. */
  restCount: number;
  /** Lines changed in the largest drawn file: the full width of every file's bar. */
  scale: number;
}>;

/** The story draws the four largest files, then says how many smaller ones there are. */
export const TRIAGE_STORY_SHOWN_FILES_V1 = 4;

function changed(row: TriageChangedFileV1): number {
  return row.lines === undefined ? 0 : row.lines.additions + row.lines.deletions;
}

export function summarizeTriageChangesV1(input: Readonly<{
  rows: readonly TriageChangedFileV1[];
  /** The provider has more changed files than the pages read so far. */
  more: boolean;
  shown?: number;
  totals?: TriageChangeTotalsV1 | undefined;
}>): TriageChangeSummaryV1 {
  const shown = input.shown ?? TRIAGE_STORY_SHOWN_FILES_V1;
  const counted = input.rows.length > 0 && input.rows.every((row) => row.lines !== undefined);
  const totalLines = input.totals?.additions !== undefined && input.totals.deletions !== undefined
    ? { additions: input.totals.additions, deletions: input.totals.deletions }
    : null;
  let lines = totalLines;
  if (lines === null && counted) {
    let additions = 0;
    let deletions = 0;
    for (const row of input.rows) {
      additions += row.lines!.additions;
      deletions += row.lines!.deletions;
    }
    lines = { additions, deletions };
  }
  const files = (counted ? [...input.rows].sort((left, right) => changed(right) - changed(left)) : [...input.rows])
    .slice(0, shown);
  const fileCount = input.totals?.files ?? input.rows.length;
  return Object.freeze({
    lines: lines === null ? null : Object.freeze(lines),
    fileCount,
    complete: !input.more || (input.totals !== undefined && (totalLines !== null || !counted)),
    files: Object.freeze(files),
    sortedBySize: counted,
    restCount: Math.max(0, fileCount - files.length),
    scale: files.reduce((largest, row) => Math.max(largest, changed(row)), 0),
  });
}
