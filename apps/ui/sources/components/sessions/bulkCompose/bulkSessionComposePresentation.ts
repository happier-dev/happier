import type { BulkSessionChangeRow } from '@/components/sessions/authoring/bulk/executeBulkSessionChanges';
import type { SessionAskTargetRowState } from '@/components/sessions/transcript/askRecord/SessionAskRecord';
import { t } from '@/text';

/** Why a target can't receive this compose, from the authoring-facts owner's typed reason. */
export function describeBulkSkipReason(
  reason: string | null | undefined,
): string {
  switch (reason) {
    case 'archived':
      return t('session.participants.bulk.reasonArchived');
    case 'cannot_resume':
      return t('session.participants.bulk.reasonCannotResume');
    case 'read_only':
      return t('session.participants.bulk.reasonReadOnly');
    default:
      return t('session.participants.bulk.reasonUnavailable');
  }
}

/**
 * One word per state across the rows and the summary (lab review #1). A message admission keeps the ask record's
 * own chip; only the control-plane states the invocation read can't say are supplied here.
 */
export function describeBulkRowState(
  row: BulkSessionChangeRow,
): SessionAskTargetRowState {
  switch (row.state) {
    case 'failed':
      return {
        variant: 'danger',
        icon: 'warning',
        label: t('session.participants.bulk.stateNotSent'),
      };
    case 'approval_pending':
      return {
        variant: 'attention',
        icon: 'pause-circle',
        label: t('session.participants.bulk.stateWaits'),
      };
    case 'waking':
      return {
        variant: 'neutral',
        icon: 'clock',
        spinning: true,
        label: t('session.participants.bulk.stateWaking'),
      };
    case 'applying':
      return {
        variant: 'neutral',
        icon: 'clock',
        spinning: true,
        label: t('session.participants.bulk.stateInProgress'),
      };
    case 'sent':
      return {
        variant: 'neutral',
        icon: 'check',
        label: t('session.participants.bulk.stateSent'),
      };
    case 'applied':
      return {
        variant: 'neutral',
        icon: 'check',
        label: t('session.participants.bulk.stateApplied'),
      };
    case 'switched':
      return {
        variant: 'neutral',
        icon: 'check',
        label: t('session.participants.bulk.stateSwitched'),
      };
    case 'skipped':
      return {
        variant: 'neutral',
        icon: 'minus-circle',
        label: t('session.participants.bulk.stateSkipped'),
      };
  }
}

/** The reason line under a row: the owner's own sentence when it gave one, else what the state means for the person. */
export function describeBulkRowReason(
  row: BulkSessionChangeRow,
): string | null {
  if (row.state === 'skipped') return describeBulkSkipReason(row.code);
  if (row.state === 'waking')
    return t('session.participants.bulk.reasonWaking');
  if (row.state === 'approval_pending')
    return t('session.participants.bulk.reasonApproval');
  if (row.state === 'failed') return row.reason ?? null;
  return null;
}

export type BulkSessionResultSummary = Readonly<{
  notSent: number;
  waits: number;
  inProgress: number;
  done: number;
  total: number;
}>;

export function summarizeBulkRows(
  rows: readonly BulkSessionChangeRow[],
): BulkSessionResultSummary {
  const count = (states: readonly BulkSessionChangeRow['state'][]) =>
    rows.filter((row) => states.includes(row.state)).length;
  return {
    notSent: count(['failed']),
    waits: count(['approval_pending']),
    inProgress: count(['applying', 'waking']),
    done: count(['sent', 'applied', 'switched']),
    total: rows.filter((row) => row.state !== 'skipped').length,
  };
}

export function formatBulkSummary(summary: BulkSessionResultSummary): string {
  // While work still moves, one progress figure; once settled, the counts that matter, failures first.
  if (summary.inProgress > 0 && summary.notSent === 0 && summary.waits === 0) {
    return t('session.participants.bulk.progress', {
      done: summary.done,
      total: summary.total,
    });
  }
  return [
    summary.notSent > 0
      ? t('session.participants.bulk.summaryNotSent', {
          count: summary.notSent,
        })
      : null,
    summary.waits > 0
      ? t('session.participants.bulk.summaryWaits', { count: summary.waits })
      : null,
    summary.inProgress > 0
      ? t('session.participants.bulk.summaryInProgress', {
          count: summary.inProgress,
        })
      : null,
    summary.done > 0
      ? t('session.participants.bulk.summaryDone', { count: summary.done })
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}
