/**
 * The one owner of working-copy change counting, read by the SCM producer (summary replies)
 * and by every UI count (rail badge, composer instrument, Git and Files headers).
 */

/** Paths whose numstat lines are not review statistics: media, archives, binaries, fonts. */
const NO_LINE_DELTA_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
  'pdf',
  'mp4', 'm4v', 'mov', 'webm', 'avi', 'wmv', 'flv',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a',
  'zip', 'tar', 'gz', 'rar', '7z',
  'db', 'sqlite', 'sqlite3',
  'exe', 'dll', 'elf', 'so', 'dylib', 'macho',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'woff', 'woff2', 'ttf', 'otf',
  'dmg', 'deb', 'rpm', 'lockb',
]);

function readPathExtension(path: string): string | null {
  const basename = path.split(/[\\/]/).pop() ?? path;
  const lastDotIndex = basename.lastIndexOf('.');
  if (lastDotIndex <= 0 || lastDotIndex >= basename.length - 1) return null;
  return basename.slice(lastDotIndex + 1).toLowerCase();
}

/** A backend-collapsed directory row (`scratch/`, `scratch\`): not a file a person can open, stage or commit. */
export function isDirectoryLikeScmPath(path: string): boolean {
  const trimmed = typeof path === 'string' ? path.trim() : '';
  return trimmed.length > 0 && (trimmed.endsWith('/') || trimmed.endsWith('\\'));
}

/** Git may count PDFs or recordings without NUL bytes as text; their lines are not review statistics. */
export function scmPathHasLineDelta(input: Readonly<{ path: string; isBinary?: boolean }>): boolean {
  if (input.isBinary === true) return false;
  const extension = readPathExtension(input.path);
  return extension === null || !NO_LINE_DELTA_EXTENSIONS.has(extension);
}

export type ScmChangeSummaryEntry = Readonly<{
  path: string;
  hasIncludedDelta?: boolean;
  hasPendingDelta?: boolean;
  stats?: Readonly<{
    includedAdded?: number;
    includedRemoved?: number;
    pendingAdded?: number;
    pendingRemoved?: number;
    isBinary?: boolean;
  }>;
}>;

export type ScmChangeSummaryTotals = Readonly<{
  includedAdded: number;
  includedRemoved: number;
  pendingAdded: number;
  pendingRemoved: number;
}>;

export type ScmChangeSummary = ScmChangeSummaryTotals & Readonly<{
  /** One per changed path (staged then edited again is one file), directories excluded. */
  changedFiles: number;
}>;

/**
 * Changed-file count and the snapshot's two-area line totals minus entries with no meaningful
 * line delta. `totals` are the producer's measured aggregates for the same entries.
 */
export function summarizeScmChanges(
  entries: ReadonlyArray<ScmChangeSummaryEntry>,
  totals: ScmChangeSummaryTotals,
): ScmChangeSummary {
  let { includedAdded, includedRemoved, pendingAdded, pendingRemoved } = totals;
  const changedPaths = new Set<string>();
  for (const entry of entries) {
    if ((entry.hasIncludedDelta === true || entry.hasPendingDelta === true) && !isDirectoryLikeScmPath(entry.path)) {
      changedPaths.add(entry.path);
    }
    if (scmPathHasLineDelta({ path: entry.path, isBinary: entry.stats?.isBinary })) continue;
    includedAdded -= entry.stats?.includedAdded ?? 0;
    includedRemoved -= entry.stats?.includedRemoved ?? 0;
    pendingAdded -= entry.stats?.pendingAdded ?? 0;
    pendingRemoved -= entry.stats?.pendingRemoved ?? 0;
  }
  return { changedFiles: changedPaths.size, includedAdded, includedRemoved, pendingAdded, pendingRemoved };
}
