/**
 * What a Code row or commit strip shows for one entry's latest commit: the plan-13 §5 per-entry
 * history outcome (`commit` / `none` / `unavailable`), plus `pending` while the demanded batch for the
 * visible rows has not answered. Presentation only — the history adapter beside the browser owns the
 * request, its HEAD witness and retirement; a canceled or stale batch never becomes `none`.
 */
export type CodeEntryCommit = Readonly<{
  oid: string;
  subject: string;
  authorName: string;
  /** Commit time, ms since epoch. */
  committedAt: number;
}>;

export type CodeEntryHistoryState =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'commit'; commit: CodeEntryCommit }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'unavailable'; reason?: string | null }>;

export const CODE_ENTRY_HISTORY_PENDING: CodeEntryHistoryState = {
  kind: 'pending',
};

/** The short object id a person reads beside a commit (Git's default abbreviation). */
export function formatCodeCommitShortOid(oid: string): string {
  return oid.trim().slice(0, 7);
}
