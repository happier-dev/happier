import type {
  GitlabProjectedActivityEventRowV1,
  GitlabProjectedDiscussionRowV1,
  GitlabProjectedNoteRowV1,
} from '../../triage/detail/projection.js';

export type GitlabActivityTimelineRowV1 =
  | Readonly<{ kind: 'note'; id: string; row: GitlabProjectedNoteRowV1 }>
  | Readonly<{ kind: 'discussion'; id: string; row: GitlabProjectedDiscussionRowV1 }>
  | Readonly<{ kind: 'event'; id: string; row: GitlabProjectedActivityEventRowV1 }>;

/**
 * One GitLab Activity stream over independently paged walks, each GitLab record once.
 *
 * A merge request's `/notes` walk and its `/discussions` walk return the SAME notes: a
 * discussion is GitLab's grouping of notes, and an individual remark is a one-note
 * discussion. The discussion is the richer arm (its replies and its resolution), so a note
 * already read inside a discussion is not drawn again. A note whose discussion page has not
 * been read yet stays, so nothing read is hidden. Reading order belongs to the shared
 * Activity owner, not to this merge.
 */
export function projectGitlabActivityTimelineV1(input: Readonly<{
  notes: readonly GitlabProjectedNoteRowV1[];
  discussions: readonly GitlabProjectedDiscussionRowV1[];
  events: readonly GitlabProjectedActivityEventRowV1[];
}>): readonly GitlabActivityTimelineRowV1[] {
  const inDiscussion = new Set(input.discussions.flatMap((discussion) => discussion.notes.map((note) => note.id)));
  return [
    ...input.discussions.map((row) => ({ kind: 'discussion' as const, id: row.id, row })),
    ...input.notes
      .filter((row) => !inDiscussion.has(row.id))
      .map((row) => ({ kind: 'note' as const, id: row.id, row })),
    ...input.events.map((row) => ({ kind: 'event' as const, id: row.id, row })),
  ];
}
