import * as React from 'react';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { t } from '@/text';

import {
  EMPTY_WORKFLOW_ANNOUNCEMENT_STATE,
  selectWorkflowAnnouncement,
  type WorkflowAnnouncement,
  type WorkflowAnnouncementState,
} from './workflowAnnouncementSelection';

/**
 * The workflow-local announcement owner.
 *
 * It selects and coalesces one semantic summary per committed UI state update,
 * then delegates delivery to the canonical accessibility transport. It adds no
 * timer, no elapsed-time window and no second live region.
 */

export function formatWorkflowAnnouncement(
  announcement: WorkflowAnnouncement,
  resolveBlockLabel: (blockId: string) => string,
): string {
  switch (announcement.kind) {
    case 'terminal':
      // A partial attention window cannot promise how many steps still need
      // the person, so the exact count is withheld and only the state is said.
      return announcement.attentionCount > 0 && announcement.attentionHasMore !== true
        ? t('workflows.a11y.terminalWithAttention', {
          state: t(`workflows.runState.${announcement.terminal}`),
          count: announcement.attentionCount,
        })
        : t('workflows.a11y.terminal', { state: t(`workflows.runState.${announcement.terminal}`) });
    case 'attention':
      // Same construction the visible needs-you header uses: loaded rows are
      // stated as loaded so a reader never mistakes them for the total.
      return announcement.attentionHasMore === true
        ? `${announcement.attentionCount} ${t('workflows.a11y.needsYouLoaded')}`
        : t('workflows.a11y.needsYou', { count: announcement.attentionCount });
    case 'validation':
      // The same words the step shows (DESIGN-5 P3): the editor's issue owner, else the code's sentence.
      return announcement.blockId === undefined
        ? t('workflows.a11y.validation', { reason: announcement.reason ?? t(`workflows.issue.${announcement.issueCode}`) })
        : t('workflows.a11y.validationInBlock', {
          block: resolveBlockLabel(announcement.blockId),
          reason: announcement.reason ?? t(`workflows.issue.${announcement.issueCode}`),
        });
    case 'ready':
      // The header's own readout word (07 "One validity readout").
      return t('workflows.page.readyToRun');
    case 'inserted':
      return t('workflows.a11y.inserted', {
        block: resolveBlockLabel(announcement.blockId),
        position: announcement.position,
        total: announcement.total,
      });
    case 'removed':
      return t('workflows.a11y.removed', {
        block: resolveBlockLabel(announcement.blockId),
        total: announcement.total,
      });
    case 'reordered':
      return t('workflows.a11y.reordered', {
        block: resolveBlockLabel(announcement.blockId),
        position: announcement.position,
        total: announcement.total,
      });
    case 'selectedRowUpdated':
      return t('workflows.a11y.selectedRowUpdated', { block: resolveBlockLabel(announcement.blockId) });
    case 'progress': {
      if (announcement.historyIncomplete !== true && announcement.attentionHasMore !== true) {
        return announcement.attentionCount > 0
          ? t('workflows.a11y.progressWithAttention', {
            count: announcement.changedRowCount,
            attention: announcement.attentionCount,
          })
          : t('workflows.a11y.progress', { count: announcement.changedRowCount });
      }
      const countText = announcement.historyIncomplete === true
        ? t('workflows.a11y.progressLoaded', { count: announcement.changedRowCount })
        : t('workflows.a11y.progress', { count: announcement.changedRowCount });
      if (announcement.attentionCount === 0) return countText;
      const attentionText = announcement.attentionHasMore === true
        ? `${announcement.attentionCount} ${t('workflows.a11y.needsYouLoaded')}`
        : t('workflows.a11y.needsYou', { count: announcement.attentionCount });
      return `${countText}; ${attentionText}`;
    }
  }
}

/**
 * A page command the person invoked (press, shortcut or host intent) that the
 * page refused. Unlike the state summaries above this is a discrete user
 * action, so it is delivered as it happens through the same transport and
 * carries the exact repairable reason the page shows beside the control.
 */
export function announceWorkflowCommandRefused(reason: string): void {
  announceAccessibilityMessage(t('workflows.a11y.commandRefused', { reason }));
}

export function useWorkflowAnnouncements(params: Readonly<{
  state: WorkflowAnnouncementState;
  resolveBlockLabel: (blockId: string) => string;
  enabled?: boolean;
}>): void {
  const previousRef = React.useRef<WorkflowAnnouncementState>(EMPTY_WORKFLOW_ANNOUNCEMENT_STATE);
  /**
   * Whether a state has been observed yet.
   *
   * The empty state is a starting value, not something the reader was ever
   * shown. Comparing the first committed state against it turned arriving at a
   * screen into "these blocks were inserted" or "this run just finished" —
   * announcements for transitions nobody made. Only what changes after the
   * first observation is a transition.
   */
  const baselineObservedRef = React.useRef(false);
  const resolveLabelRef = React.useRef(params.resolveBlockLabel);
  const resolveBlockLabel = params.resolveBlockLabel;
  const enabled = params.enabled ?? true;
  const state = params.state;

  React.useEffect(() => {
    const previous = previousRef.current;
    const previousLabel = resolveLabelRef.current;
    const hadBaseline = baselineObservedRef.current;
    previousRef.current = state;
    resolveLabelRef.current = resolveBlockLabel;
    baselineObservedRef.current = true;
    if (!hadBaseline || !enabled) return;
    const announcement = selectWorkflowAnnouncement(previous, state);
    if (announcement === null) return;
    // Removal resolves against the last committed document, where the block
    // still exists. All other transitions read the current canonical labels.
    announceAccessibilityMessage(formatWorkflowAnnouncement(announcement,
      announcement.kind === 'removed' ? previousLabel : resolveBlockLabel));
  }, [enabled, state, resolveBlockLabel]);
}
