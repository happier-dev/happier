import type { GitlabProjectedNoteRowV1 } from '../../triage/detail/projection.js';

const LATEST_REPLY_WINDOW = 4;

export function projectGitlabDiscussionRepliesV1(
  notes: readonly GitlabProjectedNoteRowV1[],
  expanded: boolean,
): readonly GitlabProjectedNoteRowV1[] {
  return expanded ? notes : notes.slice(-LATEST_REPLY_WINDOW);
}
