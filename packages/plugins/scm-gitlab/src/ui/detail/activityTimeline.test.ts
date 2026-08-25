import { describe, expect, it } from 'vitest';

import { chronologicalGitlabRowsV1, projectGitlabActivityTimelineV1 } from './activityTimeline.js';

describe('projectGitlabActivityTimelineV1', () => {
  it('places an older fetched page before newer notes', () => {
    expect(chronologicalGitlabRowsV1([
      { id: 'new', atMs: 20 },
      { id: 'older-page', atMs: 10 },
    ]).map((row) => row.id)).toEqual(['older-page', 'new']);
  });
  it('builds one chronological merge-request stream across notes and all event sources', () => {
    const rows = projectGitlabActivityTimelineV1({
      kindId: 'merge-request',
      notes: [
        { id: 'new-note', body: 'new', system: false, atMs: 40 },
        { id: 'old-note', body: 'old', system: false, atMs: 10 },
      ],
      events: [
        { id: 'label', source: 'label', action: 'added', atMs: 30 },
        { id: 'state', source: 'state', action: 'closed', atMs: 20 },
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(['old-note', 'state', 'label', 'new-note']);
    expect(rows.map((row) => row.kind)).toEqual(['note', 'event', 'event', 'note']);
  });

  it('keeps issue notes exclusively in Comments', () => {
    const rows = projectGitlabActivityTimelineV1({
      kindId: 'issue',
      notes: [{ id: 'comment', body: 'only in Comments', system: false, atMs: 10 }],
      events: [{ id: 'state', source: 'state', action: 'closed', atMs: 20 }],
    });

    expect(rows.map((row) => row.id)).toEqual(['state']);
  });
});
