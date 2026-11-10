import * as React from 'react';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';

import type { HealthNoticeInvestigationOutcome, HealthNoticeInvestigationPlacement } from './healthNoticeInvestigation';
import { InvestigationPlacementChooser } from './InvestigationPlacementChooser';
import { useOpenTriageActionEditor } from './useOpenTriageActionEditor';

/**
 * What happened after Investigate, for every failure surface that offers it (Inbox notices, failed
 * receipts, managed setup failures): one banner per outcome; a started handoff already opened its page.
 */
// `catalogUnavailable` is a catalog read that did not answer (transport, reconnecting Account): the unavailable
// copy, never the set-up step.
const NOT_SET_UP: ReadonlySet<string> = new Set(['configuredActionUnavailable']);

/** One sentence for what happened after Investigate; a started handoff already opened its page. */
export function InvestigationOutcomeBanner(props: Readonly<{
  outcome: HealthNoticeInvestigationOutcome;
  serverId: string;
  testID?: string;
  /** Triage asked where to work: the same Investigate, retried with the person's choice. */
  onChoosePlacement: (placement: HealthNoticeInvestigationPlacement) => void;
  pending: boolean;
  /** A container that owns its gutter draws the banner inline; pages keep the section inset. */
  placement?: 'page-section' | 'inline';
}>) {
  const testID = props.testID ?? 'inbox.notice.investigate';
  const { outcome } = props;
  const openEditor = useOpenTriageActionEditor();
  if (outcome.kind === 'started') return null;
  if (outcome.kind === 'placement_choice_required') return <InvestigationPlacementChooser choice={outcome}
    pending={props.pending} onChoose={props.onChoosePlacement} testID={`${testID}.placement`} />;
  if (outcome.kind === 'approval') return <HealthNoticeApprovalNotice artifactId={outcome.artifactId} serverId={props.serverId} testID={`${testID}.approval`} />;
  const copy = outcome.kind === 'selectionRequired'
      ? { tone: 'warning' as const, title: t('inbox.work.healthNotice.selectionTitle'), description: t('inbox.work.healthNotice.selectionBody') }
      : outcome.kind === 'uncertain'
        ? { tone: 'warning' as const, title: t('inbox.work.healthNotice.uncertainTitle'), description: t('inbox.work.healthNotice.uncertainBody') }
        : NOT_SET_UP.has(outcome.code)
          // No configured investigation is a setup step, not a failure: it opens the actions editor on the record
          // pressed (or the list when none answered), the same open as Edit action….
          ? { tone: 'warning' as const, title: t('inbox.work.healthNotice.notSetUpTitle'), description: t('inbox.work.healthNotice.notSetUpBody'),
            action: openEditor === null ? null : { label: t('inbox.work.healthNotice.notSetUpAction'),
              onPress: () => { openEditor(outcome.configuredActionId); } } }
          : { tone: 'danger' as const, title: t('inbox.work.healthNotice.unavailableTitle'),
            description: t('inbox.work.healthNotice.unavailableBody'), details: [outcome.code] };
  return <AttentionBanner testID={`${testID}.${outcome.kind}`} tone={copy.tone} title={copy.title}
    description={copy.description} details={'details' in copy ? copy.details : undefined}
    action={'action' in copy ? copy.action : undefined} placement={props.placement} />;
}

const noop = () => {};

/** Triage's own approval asked first: the canonical waiting notice, with the way to its Inbox review. */
function HealthNoticeApprovalNotice(props: Readonly<{ artifactId: string; serverId: string; testID: string }>) {
  const approval = useActionApprovalContinuation({ scopeKey: `health-notice:${props.artifactId}`, serverId: props.serverId, onExecuted: noop });
  const { requestApproval } = approval;
  React.useEffect(() => requestApproval(props.artifactId), [props.artifactId, requestApproval]);
  if (!approval.approvalPending) return null;
  return <ActionApprovalPendingNotice testID={props.testID} presentation="banner"
    message={t('approvals.waitingForYou')} description={t('inbox.work.healthNotice.approvalBody')}
    onOpenApproval={approval.openApproval} />;
}
