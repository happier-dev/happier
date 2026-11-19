import type { BulkSessionChangeRow } from '@/components/sessions/authoring/bulk/executeBulkSessionChanges';
import { SessionAgentTransitionRejectedCodeV1Schema } from '@happier-dev/protocol/sessions/agentTransition';
import type { SessionAskTargetRowState } from '@/components/sessions/transcript/askRecord/SessionAskRecord';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { isBundledAgentId } from '@/agents/registry/registryCore';
import { getSessionInputFailureLabelKey } from '@/components/sessions/pending/pendingMessageVisualState';
import { resolveSessionAgentTransitionRejectedMessage } from '@/sync/domains/session/input/continueSessionWithArmedAgent';
import { t } from '@/text';

/** Why a target can't receive this compose, from the authoring-facts owner's typed reason. */
export function describeBulkSkipReason(
  reason: string | null | undefined,
): string {
  switch (reason) {
    case 'no_change':
      return t('session.participants.bulk.keepsOwnOne');
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
  /** The Machine-scoped catalog's Agent titles (`useBulkSessionAgentTitles`), keyed by `bulkSwitchCatalogAgentId`. */
  agentTitles?: ReadonlyMap<string, string>,
): string | null {
  if (row.state === 'skipped') return describeBulkSkipReason(row.code);
  if (row.state === 'waking')
    return t('session.participants.bulk.reasonWaking');
  if (row.state === 'approval_pending')
    return t('session.participants.bulk.reasonApproval');
  if (row.state === 'failed') {
    if (row.reason) return row.reason;
    if (row.actionId === 'session.agent.transition') {
      const rejected = SessionAgentTransitionRejectedCodeV1Schema.safeParse(row.code);
      if (rejected.success) {
        const agent = t('agentInput.agent.sectionTitle');
        return resolveSessionAgentTransitionRejectedMessage(rejected.data, {
          sourceAgentLabel: agent,
          targetAgentLabel: agent,
        });
      }
    }
    // A typed admission refusal says why in the session composer's own words (one code → copy owner).
    const key = getSessionInputFailureLabelKey({ code: row.code });
    return key ? t(key) : t('common.requestFailed');
  }
  // A message that followed an agent switch keeps the switch in its reason line (lab: "Sent · Switched from …").
  if (row.switchedFrom && row.switchedTo) {
    return t('session.participants.bulk.reasonSwitched', {
      from: describeAgentId(row.switchedFrom, agentTitles),
      to: describeAgentId(row.switchedTo, agentTitles),
    });
  }
  return null;
}

/** The id the Machine-scoped Agent catalog knows a switch's qualified Agent id ("happier.agent.claude/claude") by. */
export function bulkSwitchCatalogAgentId(agentId: string): string {
  const localId = agentId.slice(agentId.lastIndexOf('/') + 1);
  return isBundledAgentId(localId) ? localId : agentId;
}

/** A switch's Agent in the catalog's own words (installed and contributed Agents keep their names), as the To rows. */
function describeAgentId(agentId: string, agentTitles: ReadonlyMap<string, string> | undefined): string {
  const catalogId = bulkSwitchCatalogAgentId(agentId);
  const title = agentTitles?.get(catalogId);
  if (title) return title;
  return isBundledAgentId(catalogId)
    ? resolveAgentCatalogTitle(catalogId)
    : formatAgentLikeIdForDisplay(agentId.slice(agentId.lastIndexOf('/') + 1));
}

type BulkSessionResultSummary = Readonly<Record<BulkSessionChangeRow['state'], number>>;

export function summarizeBulkRows(
  rows: readonly BulkSessionChangeRow[],
): BulkSessionResultSummary {
  const counts: Record<BulkSessionChangeRow['state'], number> = {
    failed: 0, approval_pending: 0, waking: 0, applying: 0, sent: 0, applied: 0, switched: 0, skipped: 0,
  };
  for (const row of rows) counts[row.state]++;
  return counts;
}

/** The headline uses the same outcome words as the rows, with failures first. */
export function formatBulkSummary(summary: BulkSessionResultSummary): string {
  return [
    summary.failed > 0
      ? t('session.participants.bulk.summaryNotSent', { count: summary.failed })
      : null,
    summary.approval_pending > 0
      ? t('session.participants.bulk.summaryWaits', { count: summary.approval_pending })
      : null,
    summary.waking > 0
      ? t('session.participants.bulk.summaryWaking', { count: summary.waking })
      : null,
    summary.applying > 0
      ? t('session.participants.bulk.summaryInProgress', { count: summary.applying })
      : null,
    summary.sent > 0
      ? t('session.participants.bulk.summarySent', { count: summary.sent })
      : null,
    summary.applied > 0
      ? t('session.participants.bulk.summaryChanged', { count: summary.applied })
      : null,
    summary.switched > 0
      ? t('session.participants.bulk.summarySwitched', { count: summary.switched })
      : null,
    summary.skipped > 0
      ? t('session.participants.bulk.skippedCount', { count: summary.skipped })
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}
