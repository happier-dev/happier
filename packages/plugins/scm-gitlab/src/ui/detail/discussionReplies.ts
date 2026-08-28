import type { GitlabProjectedNoteRowV1 } from '../../triage/detail/projection.js';

const LATEST_REPLY_WINDOW = 4;

export function hasEarlierGitlabDiscussionRepliesV1(
  notes: readonly GitlabProjectedNoteRowV1[],
): boolean {
  return notes.length > LATEST_REPLY_WINDOW;
}

export function projectGitlabDiscussionRepliesV1(
  notes: readonly GitlabProjectedNoteRowV1[],
  expanded: boolean,
): readonly GitlabProjectedNoteRowV1[] {
  return expanded ? notes : notes.slice(-LATEST_REPLY_WINDOW);
}
