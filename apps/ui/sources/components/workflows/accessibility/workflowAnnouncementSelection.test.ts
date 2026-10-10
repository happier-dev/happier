import { describe, expect, it } from 'vitest';

import {
  EMPTY_WORKFLOW_ANNOUNCEMENT_STATE,
  selectWorkflowAnnouncement,
  type WorkflowAnnouncementState,
} from './workflowAnnouncementSelection';

function state(overrides: Partial<WorkflowAnnouncementState> = {}): WorkflowAnnouncementState {
  return { ...EMPTY_WORKFLOW_ANNOUNCEMENT_STATE, ...overrides };
}

describe('workflow announcement selection', () => {
  it('says nothing when nothing worth announcing changed', () => {
    const unchanged = state({ blockIds: ['a', 'b'], selectedBlockId: 'a' });
    expect(selectWorkflowAnnouncement(unchanged, unchanged)).toBeNull();
  });

  it('never repeats a visible focus change: selection alone produces no announcement', () => {
    const before = state({ blockIds: ['a', 'b'], selectedBlockId: 'a' });
    const after = state({ blockIds: ['a', 'b'], selectedBlockId: 'b' });
    expect(selectWorkflowAnnouncement(before, after)).toBeNull();
  });

  it('produces at most one summary per committed update, preferring the terminal fact', () => {
    const before = state({ blockIds: ['a'], attentionCount: 0, changedRowCount: 0 });
    const after = state({
      blockIds: ['a', 'b'],
      attentionCount: 2,
      changedRowCount: 5,
      terminal: 'completed_with_failures',
    });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({
      kind: 'terminal',
      terminal: 'completed_with_failures',
      attentionCount: 2,
      attentionHasMore: false,
    });
  });

  it('does not re-announce a terminal state that was already reported', () => {
    const terminal = state({ terminal: 'completed' });
    expect(selectWorkflowAnnouncement(terminal, terminal)).toBeNull();
  });

  it('ranks a newly actionable row above background progress', () => {
    const before = state({ attentionCount: 0 });
    const after = state({ attentionCount: 1, changedRowCount: 4 });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({
      kind: 'attention',
      attentionCount: 1,
      attentionHasMore: false,
    });
  });

  it('does not announce attention when the count only fell', () => {
    const before = state({ attentionCount: 2 });
    const after = state({ attentionCount: 1, changedRowCount: 1 });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({
      kind: 'progress',
      changedRowCount: 1,
      attentionCount: 1,
      attentionHasMore: false,
      historyIncomplete: false,
    });
  });

  it('carries the attention paging fact onto the summaries that word it', () => {
    const before = state({ attentionCount: 2 });
    const after = state({ attentionCount: 4, attentionHasMore: true });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({
      kind: 'attention',
      attentionCount: 4,
      attentionHasMore: true,
    });
  });

  it('carries both paging facts onto a terminal summary', () => {
    const before = state({ attentionCount: 2, attentionHasMore: true });
    const after = state({
      attentionCount: 2,
      attentionHasMore: true,
      historyIncomplete: true,
      terminal: 'completed',
    });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({
      kind: 'terminal',
      terminal: 'completed',
      attentionCount: 2,
      attentionHasMore: true,
    });
  });

  it('carries both paging facts onto a progress summary', () => {
    const before = state({ attentionCount: 2, attentionHasMore: true });
    const after = state({
      attentionCount: 2,
      attentionHasMore: true,
      historyIncomplete: true,
      changedRowCount: 3,
    });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({
      kind: 'progress',
      changedRowCount: 3,
      attentionCount: 2,
      attentionHasMore: true,
      historyIncomplete: true,
    });
  });

  it('announces a new blocking validation issue once, then stays quiet while it persists', () => {
    const before = state({ blockIds: ['a'] });
    const after = state({ blockIds: ['a'], blockingIssue: { code: 'missing_reference', blockId: 'a' } });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({
      kind: 'validation',
      issueCode: 'missing_reference',
      blockId: 'a',
    });
    expect(selectWorkflowAnnouncement(after, after)).toBeNull();
  });

  it('carries the editor\'s own wording of the issue, so the announcer says what the step says (DESIGN-5 P3)', async () => {
    const before = state({ blockIds: ['wait'] });
    const after = state({ blockIds: ['wait'], blockingIssue: { code: 'invalid_input', blockId: 'wait', reason: 'Write what you should check or decide here.' } });
    const announcement = selectWorkflowAnnouncement(before, after);
    expect(announcement).toMatchObject({ kind: 'validation', reason: 'Write what you should check or decide here.' });
    const { formatWorkflowAnnouncement } = await import('./useWorkflowAnnouncements');
    const spoken = formatWorkflowAnnouncement(announcement!, () => 'Wait for you');
    expect(spoken).toContain('Write what you should check or decide here.');
    expect(spoken).not.toContain('This value is not valid.');
  });

  it('says the draft is ready once its last blocking issue is repaired, so the live region never keeps a fixed issue (DESIGN-7 P3)', async () => {
    const broken = state({ blockIds: ['a'], blockingIssue: { code: 'invalid_input', blockId: 'a', reason: 'Engines needs a valid value.' } });
    const repaired = state({ blockIds: ['a'] });
    const announcement = selectWorkflowAnnouncement(broken, repaired);
    expect(announcement).toEqual({ kind: 'ready' });
    const { formatWorkflowAnnouncement } = await import('./useWorkflowAnnouncements');
    expect(formatWorkflowAnnouncement(announcement!, () => 'a')).not.toContain('Engines');
    // Nothing was wrong before: still nothing to say.
    expect(selectWorkflowAnnouncement(repaired, repaired)).toBeNull();
  });

  it('announces insertion with its position and the new total', () => {
    const before = state({ blockIds: ['a'] });
    const after = state({ blockIds: ['a', 'b'] });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({
      kind: 'inserted',
      blockId: 'b',
      position: 2,
      total: 2,
    });
  });

  it('announces removal with the surviving total', () => {
    const before = state({ blockIds: ['a', 'b', 'c'] });
    const after = state({ blockIds: ['a', 'c'] });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({ kind: 'removed', blockId: 'b', total: 2 });
  });

  it('announces reordering as a new position rather than an insert plus a remove', () => {
    const before = state({ blockIds: ['a', 'b', 'c'] });
    const after = state({ blockIds: ['b', 'a', 'c'] });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({
      kind: 'reordered',
      blockId: 'b',
      position: 1,
      total: 3,
    });
  });

  it('never suppresses a relevant change to the currently selected row', () => {
    const before = state({ blockIds: ['a', 'b'], selectedBlockId: 'b' });
    const after = state({ blockIds: ['a', 'b'], selectedBlockId: 'b', changedRowCount: 3, selectedRowChanged: true });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({ kind: 'selectedRowUpdated', blockId: 'b' });
  });

  it('coalesces a burst of background lifecycle changes into one progress summary', () => {
    const before = state({ blockIds: ['a', 'b', 'c'] });
    const after = state({ blockIds: ['a', 'b', 'c'], changedRowCount: 3, attentionCount: 0 });
    expect(selectWorkflowAnnouncement(before, after)).toEqual({
      kind: 'progress',
      changedRowCount: 3,
      attentionCount: 0,
      attentionHasMore: false,
      historyIncomplete: false,
    });
  });
});
