import { describe, expect, it } from 'vitest';

import { projectGitlabDiscussionRepliesV1 } from './discussionReplies.js';

const notes = Array.from({ length: 6 }, (_unused, index) => ({
  id: String(index + 1),
  body: `reply ${String(index + 1)}`,
  system: false,
}));

describe('projectGitlabDiscussionRepliesV1', () => {
  it('starts at the latest four and expands to every returned reply', () => {
    expect(projectGitlabDiscussionRepliesV1(notes, false).map((note) => note.id))
      .toEqual(['3', '4', '5', '6']);
    expect(projectGitlabDiscussionRepliesV1(notes, true).map((note) => note.id))
      .toEqual(['1', '2', '3', '4', '5', '6']);
  });
});
