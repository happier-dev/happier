import type { WorkflowValidationIssueCode } from '@happier-dev/protocol/workflows/workflowV1';

/**
 * Semantic selection and coalescing for workflow screen-reader announcements.
 *
 * This module decides *what is worth saying* about one committed UI state
 * update. It deliberately holds no timer, no live region and no transport: the
 * canonical `announceAccessibilityMessage` helper remains the only live-region
 * owner, and the hook that consumes this selector delegates delivery to it.
 *
 * At most one summary is produced per committed update. A burst of lifecycle
 * changes becomes one meaningful sentence rather than a stream of row
 * mutations, and newly actionable or terminal facts outrank background
 * progress.
 */

export type WorkflowAnnouncementTerminalKind =
  | 'completed'
  | 'completed_with_failures'
  | 'failed'
  | 'outcome_uncertain'
  | 'paused'
  | 'interrupted';

export type WorkflowAnnouncementState = Readonly<{
  /** Authored block ids in order; structural changes are derived from this. */
  blockIds: readonly string[];
  selectedBlockId: string | null;
  /** The first blocking validation issue, if any. */
  blockingIssue: Readonly<{ code: WorkflowValidationIssueCode; blockId?: string; /** The issue in the editor's own words. */ reason?: string }> | null;
  /** Rows that currently need the user, from the canonical run projection. */
  attentionCount: number;
  /** Set only once the authoritative owner reports a terminal parent state. */
  terminal: WorkflowAnnouncementTerminalKind | null;
  /** Rows whose lifecycle changed in this committed update. */
  changedRowCount: number;
  /** True when the currently selected row is one of the changed rows. */
  selectedRowChanged: boolean;
  /** True when the paged attention window has more pages beyond the loaded rows. */
  attentionHasMore: boolean;
  /** True when the loaded invocation history is a partial window of the run. */
  historyIncomplete: boolean;
}>;

export const EMPTY_WORKFLOW_ANNOUNCEMENT_STATE: WorkflowAnnouncementState = {
  blockIds: [],
  selectedBlockId: null,
  blockingIssue: null,
  attentionCount: 0,
  terminal: null,
  changedRowCount: 0,
  selectedRowChanged: false,
  attentionHasMore: false,
  historyIncomplete: false,
};

export type WorkflowAnnouncement =
  | Readonly<{ kind: 'terminal'; terminal: WorkflowAnnouncementTerminalKind; attentionCount: number; attentionHasMore: boolean }>
  | Readonly<{ kind: 'attention'; attentionCount: number; attentionHasMore: boolean }>
  | Readonly<{ kind: 'validation'; issueCode: WorkflowValidationIssueCode; blockId?: string; reason?: string }>
  /** The last blocking issue was repaired: the live region says so rather than keep the fixed issue. */
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'inserted'; blockId: string; position: number; total: number }>
  | Readonly<{ kind: 'removed'; blockId: string; total: number }>
  | Readonly<{ kind: 'reordered'; blockId: string; position: number; total: number }>
  | Readonly<{ kind: 'selectedRowUpdated'; blockId: string }>
  | Readonly<{ kind: 'progress'; changedRowCount: number; attentionCount: number; attentionHasMore: boolean; historyIncomplete: boolean }>;

function firstStructuralDifference(
  previous: readonly string[],
  next: readonly string[],
): Readonly<{ kind: 'inserted' | 'removed' | 'reordered'; blockId: string; position: number }> | null {
  if (previous.length === next.length) {
    for (let index = 0; index < next.length; index += 1) {
      if (previous[index] !== next[index]) {
        return { kind: 'reordered', blockId: next[index]!, position: index };
      }
    }
    return null;
  }
  if (next.length > previous.length) {
    const previousSet = new Set(previous);
    const index = next.findIndex((id) => !previousSet.has(id));
    if (index < 0) return null;
    return { kind: 'inserted', blockId: next[index]!, position: index };
  }
  const nextSet = new Set(next);
  const index = previous.findIndex((id) => !nextSet.has(id));
  if (index < 0) return null;
  return { kind: 'removed', blockId: previous[index]!, position: index };
}

/**
 * Returns the one announcement for this committed transition, or `null` when
 * nothing worth saying changed. A visible focus change is not repeated here:
 * selection alone never produces an announcement, only a relevant change to the
 * selected row does.
 */
export function selectWorkflowAnnouncement(
  previous: WorkflowAnnouncementState,
  next: WorkflowAnnouncementState,
): WorkflowAnnouncement | null {
  if (next.terminal !== null && next.terminal !== previous.terminal) {
    return {
      kind: 'terminal',
      terminal: next.terminal,
      attentionCount: next.attentionCount,
      attentionHasMore: next.attentionHasMore,
    };
  }

  if (next.attentionCount > previous.attentionCount) {
    return { kind: 'attention', attentionCount: next.attentionCount, attentionHasMore: next.attentionHasMore };
  }

  const previousIssue = previous.blockingIssue;
  const nextIssue = next.blockingIssue;
  if (nextIssue !== null
    && (previousIssue === null
      || previousIssue.code !== nextIssue.code
      || previousIssue.blockId !== nextIssue.blockId)) {
    const reason = nextIssue.reason === undefined ? {} : { reason: nextIssue.reason };
    return nextIssue.blockId === undefined
      ? { kind: 'validation', issueCode: nextIssue.code, ...reason }
      : { kind: 'validation', issueCode: nextIssue.code, blockId: nextIssue.blockId, ...reason };
  }

  const structural = firstStructuralDifference(previous.blockIds, next.blockIds);
  if (structural !== null) {
    return structural.kind === 'removed'
      ? { kind: 'removed', blockId: structural.blockId, total: next.blockIds.length }
      : {
        kind: structural.kind,
        blockId: structural.blockId,
        position: structural.position + 1,
        total: next.blockIds.length,
      };
  }

  // After a structural change (removing the offending block says "removed"), a repaired last issue
  // says the draft is ready.
  if (previousIssue !== null && nextIssue === null) return { kind: 'ready' };

  if (next.selectedRowChanged && next.selectedBlockId !== null) {
    return { kind: 'selectedRowUpdated', blockId: next.selectedBlockId };
  }

  if (next.changedRowCount > 0) {
    return {
      kind: 'progress',
      changedRowCount: next.changedRowCount,
      attentionCount: next.attentionCount,
      attentionHasMore: next.attentionHasMore,
      historyIncomplete: next.historyIncomplete,
    };
  }

  return null;
}
