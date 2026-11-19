import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ReviewFindingLine } from '@/components/sessions/reviews/findings/ReviewSeverity';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
  ReviewGlanceLine,
  type ReviewDetailGlance,
} from '../detail/ReviewDetailView';

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
  const statusColor =
    props.status?.tone === 'attention'
      ? theme.colors.state.warning.textForeground
      : props.status?.tone === 'failed'
        ? theme.colors.state.danger.textForeground
        : theme.colors.text.secondary;
  const reviewerNames = props.reviewers
    .map((reviewer) => reviewer.label)
    .join(t('reviewWalkthrough.and'));
  return (
    <View testID={props.testID ?? 'review-summary'} style={styles.root}>
      <View style={styles.head}>
        <Icon
          name="list-checks"
          size={ICON_SIZE.sm}
          color={theme.colors.text.secondary}
        />
        <Text variant="label" emphasis="semiBold" style={styles.headTitle}>
          {t('detailsSurface.review.title')}
        </Text>
        {props.subject ? (
          <Text variant="label" style={styles.headSubject} numberOfLines={1}>
            {props.subject}
          </Text>
        ) : null}
        {props.status ? (
          <Text
            variant="meta"
            style={[styles.headStatus, { color: statusColor }]}
            numberOfLines={1}
          >
            {props.status.label}
          </Text>
        ) : null}
      </View>
      <ReviewGlanceLine glance={props.glance} />
      {props.rows.length > 0 ? (
        <View style={styles.rows}>
          {props.rows.map((row) => (
            <ReviewFindingLine
              key={row.rowId}
              testID={`review-summary:row:${row.rowId}`}
              severity={row.severity}
              title={row.title}
              reviewer={row.reviewer}
              findBlockPrefix={row.findBlockPrefix}
              {...(props.onOpenRow
                ? { onPress: () => props.onOpenRow?.(row.rowId) }
                : {})}
            />
          ))}
          {props.more ? (
            <TextLinkButton
              testID="review-summary:more"
              size="meta"
              label={props.more.label}
              onPress={props.more.onPress}
            />
          ) : null}
        </View>
      ) : null}
      <View style={styles.foot}>
        <View style={styles.marks}>
          {props.reviewers.map((reviewer) =>
            hasAgentIconMark(reviewer.backendId, theme) ? (
              <AgentIcon
                key={reviewer.backendId}
                agentId={reviewer.backendId}
                size={ICON_SIZE.sm}
              />
            ) : null,
          )}
          <Text variant="meta" style={styles.reviewers} numberOfLines={1}>
            {reviewerNames}
          </Text>
        </View>
        {props.implement ? (
          <RoundButton
            testID="review-summary:implement"
            size="small"
            title={props.implement.label}
            loading={props.implement.busy}
            disabled={props.implement.busy}
            onPress={props.implement.onPress}
          />
        ) : null}
        <TextLinkButton
          testID="review-summary:open"
          size="row"
          label={t('reviewWalkthrough.detail.openReview')}
          onPress={props.onOpenReview}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.space.s8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  headTitle: { color: theme.colors.text.primary },
  headSubject: { color: theme.colors.text.secondary, flexShrink: 1 },
  headStatus: { marginLeft: 'auto' },
  rows: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
    paddingTop: theme.space.s8,
    gap: theme.space.s4,
  },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
    paddingTop: theme.space.s8,
  },
  marks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    flex: 1,
    minWidth: 0,
  },
  reviewers: { color: theme.colors.text.secondary, flexShrink: 1 },
}));
