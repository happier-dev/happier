import { describe, expect, it } from 'vitest';

import { projectGitlabActivityTimelineV1 } from './activityTimeline.js';

describe('projectGitlabActivityTimelineV1', () => {
  it('keeps every note, discussion and event source in one stream', () => {
    const rows = projectGitlabActivityTimelineV1({
      notes: [
        { id: 'new-note', body: 'new', system: false, atMs: 40 },
        { id: 'old-note', body: 'old', system: false, atMs: 10 },
      ],
      discussions: [],
      events: [
        { id: 'label', source: 'label', action: 'added', atMs: 30 },
        { id: 'state', source: 'state', action: 'closed', atMs: 20 },
      ],
    });

    expect(rows.map((row) => `${row.kind}:${row.id}`).sort()).toEqual([
      'event:label', 'event:state', 'note:new-note', 'note:old-note',
    ]);
  });

  it('reads a merge-request remark once even though the notes and discussions walks both return it', () => {
    // GitLab serves the same note on `/notes` and inside its `/discussions` thread; the
    // thread is the richer arm (replies, resolution), so it is the one that stays.
    const rows = projectGitlabActivityTimelineV1({
      notes: [
        { id: 'note-1', author: 'Mara', body: 'Keep the flag.', system: false, atMs: 10 },
        { id: 'note-2', author: 'Jonas', body: 'Agreed.', system: false, atMs: 12 },
        { id: 'note-3', author: 'Priya', body: 'Not in a discussion page read yet.', system: false, atMs: 14 },
      ],
      discussions: [{
        id: 'discussion-1',
        individualNote: false,
        resolved: false,
        notes: [
          { id: 'note-1', author: 'Mara', body: 'Keep the flag.', system: false, atMs: 10 },
          { id: 'note-2', author: 'Jonas', body: 'Agreed.', system: false, atMs: 12 },
        ],
        omittedNoteCount: 0,
      }],
      events: [{ id: 'state', source: 'state', action: 'closed', atMs: 20 }],
    });

    expect(rows.map((row) => `${row.kind}:${row.id}`).sort()).toEqual([
      'discussion:discussion-1', 'event:state', 'note:note-3',
    ]);
  });
});
