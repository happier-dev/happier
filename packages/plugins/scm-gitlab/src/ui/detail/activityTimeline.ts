import type {
  GitlabProjectedActivityEventRowV1,
  GitlabProjectedNoteRowV1,
} from '../../triage/detail/projection.js';
import type { GitlabKindId } from '../../triage/types.js';

export type GitlabActivityTimelineRowV1 =
  | Readonly<{ kind: 'note'; id: string; atMs?: number; row: GitlabProjectedNoteRowV1 }>
  | Readonly<{ kind: 'event'; id: string; atMs?: number; row: GitlabProjectedActivityEventRowV1 }>;

export function chronologicalGitlabRowsV1<TRow extends Readonly<{ atMs?: number }>>(
  rows: readonly TRow[],
): readonly TRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftAt = left.row.atMs ?? Number.POSITIVE_INFINITY;
      const rightAt = right.row.atMs ?? Number.POSITIVE_INFINITY;
      return leftAt === rightAt ? left.index - right.index : leftAt - rightAt;
    })
    .map(({ row }) => row);
}

/** One display ordering over independently paged GitLab sources. */
export function projectGitlabActivityTimelineV1(input: Readonly<{
  kindId: GitlabKindId;
  notes: readonly GitlabProjectedNoteRowV1[];
  events: readonly GitlabProjectedActivityEventRowV1[];
}>): readonly GitlabActivityTimelineRowV1[] {
  const rows: GitlabActivityTimelineRowV1[] = [
    ...(input.kindId === 'merge-request'
      ? input.notes.map((row) => ({ kind: 'note' as const, id: row.id, ...(row.atMs === undefined ? {} : { atMs: row.atMs }), row }))
      : []),
    ...input.events.map((row) => ({ kind: 'event' as const, id: row.id, ...(row.atMs === undefined ? {} : { atMs: row.atMs }), row })),
  ];
  return chronologicalGitlabRowsV1(rows);
}
