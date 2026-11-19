import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HappierReviewSummary, type HappierReviewSummaryRow } from '@happier-dev/plugin-ui/presentation';
import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { reviewSeverityLabel } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { StructuredFindText } from '@/components/sessions/transcript/structured/structuredFindText';
import { useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import type { ReviewDetailGlance } from '../detail/ReviewDetailView';

export type ReviewSummaryRow = Readonly<{
  rowId: string;
  severity: ReviewFinding['severity'];
  title: string;
  /** Who reported it, as the row's reviewer words ("Claude and Codex"). */
  reviewer: string;
  /** The transcript Find owner supplies stable block identities when this row is embedded there. */
  findBlockPrefix?: string;
}>;

export type ReviewSummaryProps = Readonly<{
  /** What was reviewed, after the word Review ("this session", "#2481"); `null` when the host already names it. */
  subject: string | null;
  /** The Review's one state word on the header's right ("Needs decision", "Reviewing"); quiet when healthy. */
  status?: Readonly<{
    label: string;
    tone: 'quiet' | 'attention' | 'failed';
  }> | null;
  glance: ReviewDetailGlance;
  /** The rows the host chose to show (the findings owner's order); the rest are counted in `more`. */
  rows: readonly ReviewSummaryRow[];
  more?: Readonly<{ label: string; onPress: () => void }> | null;
  reviewers: readonly Readonly<{ label: string; backendId: string }>[];
  onOpenReview: () => void;
  /** "Implement N fixes" when the person accepted any; otherwise the decision happens on the Review. */
  implement?: Readonly<{
    label: string;
    onPress: () => void;
    busy: boolean;
  }> | null;
  onOpenRow?: (rowId: string) => void;
  testID?: string;
}>;

/**
 * The one Review summary (plan 04 U6, lab `session-card`, `triage-inbox`, `pr-verdict`): Review and its
 * subject, the verdict sentence, the first findings as hairline rows, how many more, who reviewed, and the
 * way into the Review. Session transcript, Inbox, PR and Team hosts draw this same content inside their
 * own frame; the Review page itself uses the full findings list instead.
 */
export function ReviewSummary(props: ReviewSummaryProps): React.ReactElement {
  const { theme } = useUnistyles();
  const workTheme = useWorkTheme();
  const rows = React.useMemo((): readonly HappierReviewSummaryRow[] => props.rows.map((row) => {
    const severityLabel = reviewSeverityLabel(row.severity);
    const find = row.findBlockPrefix;
    // In a transcript the Find owner names each run of text, so a search can land on it.
    return find ? {
      rowId: row.rowId, severity: row.severity, accessibilityLabel: `${severityLabel}: ${row.title}`,
      severityLabel: <StructuredFindText blockId={`${find}:severity`} text={severityLabel} />,
      title: <StructuredFindText blockId={`${find}:title`} text={row.title} numberOfLines={1} style={styles.rowTitle} />,
      reviewer: <StructuredFindText blockId={`${find}:reviewer`} text={row.reviewer} numberOfLines={1} style={styles.rowReviewer} />,
    } : { rowId: row.rowId, severity: row.severity, severityLabel, title: row.title, reviewer: row.reviewer,
      accessibilityLabel: `${severityLabel}: ${row.title}` };
  }), [props.rows]);
  return (
    <HappierReviewSummary
      testID={props.testID ?? 'review-summary'}
      theme={workTheme}
      host={WORK_HOST}
      heading={t('detailsSurface.review.title')}
      headMark={<Icon name="list-checks" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
      subject={props.subject}
      status={props.status ?? null}
      glance={props.glance}
      rows={rows}
      {...(props.onOpenRow ? { onOpenRow: props.onOpenRow } : {})}
      more={props.more ? (
        <TextLinkButton testID="review-summary:more" size="meta" label={props.more.label} onPress={props.more.onPress} />
      ) : null}
      reviewerMarks={props.reviewers.map((reviewer) => hasAgentIconMark(reviewer.backendId, theme)
        ? <AgentIcon key={reviewer.backendId} agentId={reviewer.backendId} size={ICON_SIZE.sm} /> : null)}
      reviewers={props.reviewers.map((reviewer) => reviewer.label).join(t('reviewWalkthrough.and'))}
      actions={(
        <>
          {props.implement ? (
            <RoundButton testID="review-summary:implement" size="small" title={props.implement.label}
              loading={props.implement.busy} disabled={props.implement.busy} onPress={props.implement.onPress} />
          ) : null}
          <TextLinkButton testID="review-summary:open" size="row" label={t('reviewWalkthrough.detail.openReview')}
            onPress={props.onOpenReview} />
        </>
      )}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  rowTitle: { ...Typography.variant('body'), color: theme.colors.text.primary },
  rowReviewer: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
}));
