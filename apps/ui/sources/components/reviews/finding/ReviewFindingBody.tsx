import * as React from 'react';
import { View, useWindowDimensions, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HappierReviewFindingBody } from '@happier-dev/plugin-ui';
import type { HappierWorkHost } from '@happier-dev/plugin-ui/presentation';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';
import type { ReviewSeenBeforeResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Link } from '@/components/appShell/workspace/destinationRoute';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ReviewFindingPluginContent } from '@/components/reviews/plugins/ReviewPluginContent';
import { CodeBlockViewFrame } from '@/components/ui/code/blocks/CodeBlockViewFrame';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import { PAGE_ROW_TOUCH_MIN_HEIGHT_PX } from '@/components/ui/lists/pageRowMetrics';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useWorkTheme } from '@/components/work/map/WorkMapView';
import { Typography } from '@/constants/Typography';
import type { ReviewHistorySnapshot } from '@/sync/store/domains/reviews/history';
import { useArtifact } from '@/sync/store/hooks';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

import { formatReviewFindingLocation } from '@/components/sessions/reviews/findings/reviewFindingPresentation';

/** One reviewer that reported a finding, in the order they reported it. */
export type ReviewFindingReviewer = Readonly<{
  label: string;
  backendId: string;
}>;

export type ReviewFindingSeenBefore = Readonly<{
  history: Pick<ReviewHistorySnapshot, 'status' | 'error'> & Readonly<{ data: ReviewSeenBeforeResponseV1 | null }>;
  href: (match: ReviewSeenBeforeResponseV1['matches'][number]) => string;
  onRetry: () => void;
}>;

/**
 * The opened finding (Reviews lab round 11, merged B): why it matters, then the code with the
 * suggested fix applied as a diff, then how it was verified, then the conversation. The decision and
 * the title belong to the row that hosts this body; every host (Review, PR, Inbox, transcript page)
 * draws the same body.
 */
export function ReviewFindingBody(
  props: Readonly<{
    rowId: string;
    finding: ReviewFinding;
    /** The canonical comment's current explanation; finding evidence remains its original snapshot. */
    currentBodyMarkdown?: string;
    reviewContext?: Readonly<{ reviewId: string; commentId: string; serverId: string }>;
    seenBefore?: ReviewFindingSeenBefore;
    reviewers: readonly ReviewFindingReviewer[];
    /** A line between the cause and the code ("Updated after your question", why a decision can't be saved). */
    notice?: React.ReactNode;
    /** The questions and answers about this finding and the field for the next one. */
    conversation: React.ReactNode;
  }>,
) {
  const { finding } = props;
  const theme = useWorkTheme();
  return (
    <HappierReviewFindingBody
      rowId={props.rowId}
      finding={finding}
      currentBodyMarkdown={props.currentBodyMarkdown}
      theme={theme}
      host={FINDING_BODY_HOST}
      labels={{ where: t('runPage.review.where'), verification: t('runPage.review.howItWasVerified'), conversation: t('runPage.review.conversation') }}
      renderMarkdown={(markdown, role) => <MarkdownView markdown={markdown}
        textStyle={role === 'cause' ? finding.whyItMatters ? styles.cause : styles.impact : styles.prose} />}
      renderWhere={() => <ReviewFindingWhere finding={finding} rowId={props.rowId} />}
      notice={props.notice}
      reviewers={props.reviewers.length > 0 ? <ReviewFindingReviewers reviewers={props.reviewers} /> : null}
      extensions={props.reviewContext && finding.extensions
        ? <ReviewFindingPluginContent {...props.reviewContext} extensions={finding.extensions} /> : null}
      seenBefore={props.seenBefore ? <ReviewFindingSeenBeforeHistory rowId={props.rowId} {...props.seenBefore} /> : null}
      conversation={props.conversation}
    />
  );
}

/** Core text keeps the incumbent body and label typography and selectable prose. */
const FINDING_BODY_HOST: HappierWorkHost = { Text: (props) => (
  <Text selectable variant={props.role === 'pageRowTitle' ? 'label' : 'body'}
    emphasis={props.strong ? 'semiBold' : undefined} accessibilityRole={props.accessibilityRole}
    testID={props.testID} style={props.style as StyleProp<TextStyle>}>{props.children}</Text>
) };

function ReviewFindingSeenBeforeHistory(props: ReviewFindingSeenBefore & Readonly<{ rowId: string }>) {
  const { history, rowId } = props;
  const { height } = useWindowDimensions();
  const retry = { testID: `review-finding-seen-retry:${rowId}`, label: t('common.retry'), onPress: props.onRetry };
  const failure = history.error ? resolveActionExecutionErrorMessage(history.error, t('common.error')) : null;
  return <View testID={`review-finding-seen:${rowId}`} style={styles.section}>
    <Text accessibilityRole="header" variant="label" emphasis="semiBold" style={styles.label}>
      {t('reviewWalkthrough.detail.seenBefore')}
    </Text>
    {!history.data && history.status !== 'error' ? <SurfaceStateCard testID={`review-finding-seen-loading:${rowId}`}
      kind="loading" size="line" title={t('common.loading')} /> : null}
    {failure ? history.data ? <SurfaceFreshnessLine reason={failure} action={retry} />
      : <SurfaceStateCard kind="error" size="line" title={failure} action={retry} /> : null}
    {history.data?.matches.length === 0 ? <SurfaceStateCard testID={`review-finding-seen-empty:${rowId}`}
      kind="empty" size="line" title={t('reviewWalkthrough.detail.historyEmpty')} /> : null}
    {history.data && history.data.matches.length > 0 ? <VirtualizedList
      testID={`review-finding-seen-matches:${rowId}`} data={history.data.matches}
      style={{ height: Math.min(height, history.data.matches.length * PAGE_ROW_TOUCH_MIN_HEIGHT_PX) }}
      estimatedItemSize={PAGE_ROW_TOUCH_MIN_HEIGHT_PX}
      keyExtractor={match => `${match.reviewId}:${match.commentId}`}
      renderItem={({ item: match }) => <ReviewFindingSeenBeforeLink rowId={rowId} match={match} href={props.href(match)} />} /> : null}
  </View>;
}

/** One earlier appearance, named by its Review ("Also in Fix settings modal remount · 1d ago") when this device holds it. */
function ReviewFindingSeenBeforeLink(props: Readonly<{ rowId: string; match: Readonly<{ reviewId: string; commentId: string; createdAt: number }>; href: string }>) {
  const title = useArtifact(props.match.reviewId)?.title?.trim() || null;
  return <Link testID={`review-finding-seen-link:${props.rowId}:${props.match.commentId}`} href={props.href as never} style={styles.cause}>
    {t('reviewWalkthrough.alsoInReview', { title, time: formatShortRelativeTime(props.match.createdAt) })}
  </Link>;
}

/** Where: the flagged lines with the suggested fix applied, or the place alone when no fix came with it. */
function ReviewFindingWhere(
  props: Readonly<{ finding: ReviewFinding; rowId: string }>,
) {
  const { theme } = useUnistyles();
  const { finding } = props;
  const location = formatReviewFindingLocation(finding);
  const path = finding.filePath ?? null;
  return (
    <View testID={`review-finding-where:${props.rowId}`} style={styles.section}>
      <Text
        accessibilityRole="header"
        variant="label"
        emphasis="semiBold"
        style={styles.label}
      >
        {t('runPage.review.where')}
      </Text>
      {finding.patch ? (
        <CodeBlockViewFrame
          code={finding.patch}
          wrap
          showCopyButton
          headerLeft={
            path ? (
              <View style={styles.fileHead}>
                <Icon
                  name="file"
                  size={ICON_SIZE.xs}
                  color={theme.colors.text.secondary}
                />
                <Text numberOfLines={1} style={styles.filePath}>
                  {path}
                </Text>
              </View>
            ) : undefined
          }
          containerStyle={styles.code}
        >
          <DiffViewer
            mode="unified"
            unifiedDiff={finding.patch}
            filePath={path}
            presentationStyleOverride="unified"
            virtualized={false}
            showLineNumbers
            showPrefix
            wrapLines
          />
        </CodeBlockViewFrame>
      ) : location ? (
        <View style={styles.place}>
          <Icon
            name="file"
            size={ICON_SIZE.xs}
            color={theme.colors.text.secondary}
          />
          <Text selectable numberOfLines={1} style={styles.filePath}>
            {location}
          </Text>
        </View>
      ) : null}
      {finding.suggestion && !finding.patch ? (
        <MarkdownView markdown={finding.suggestion} textStyle={styles.prose} />
      ) : null}
    </View>
  );
}

/** "Claude found it · Codex agrees": who reported the finding, first reporter first. */
function ReviewFindingReviewers(
  props: Readonly<{ reviewers: readonly ReviewFindingReviewer[] }>,
) {
  const { theme } = useUnistyles();
  if (props.reviewers.length === 0) return null;
  return (
    <View style={styles.reviewers}>
      {props.reviewers.map((reviewer, index) => (
        <View key={`${reviewer.backendId}:${index}`} style={styles.reviewer}>
          {hasAgentIconMark(reviewer.backendId, theme) ? (
            <AgentIcon agentId={reviewer.backendId} size={ICON_SIZE.xs} />
          ) : null}
          <Text style={styles.reviewerText}>
            {index === 0
              ? t('runPage.review.foundIt', { reviewer: reviewer.label })
              : t('runPage.review.agrees', { reviewer: reviewer.label })}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  impact: {
    color: theme.colors.text.primary,
    ...Typography.variant('body', 'semiBold'),
  },
  cause: {
    color: theme.colors.text.secondary,
    ...Typography.variant('body'),
  },
  section: {
    gap: theme.space.s10,
  },
  label: {
    color: theme.colors.text.primary,
  },
  prose: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
  },
  code: {
    alignSelf: 'stretch',
  },
  fileHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minWidth: 0,
    flexShrink: 1,
  },
  place: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  filePath: {
    ...Typography.variant('meta'),
    ...Typography.mono(),
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
  reviewers: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: theme.space.s16,
    rowGap: theme.space.s4,
  },
  reviewer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  reviewerText: {
    color: theme.colors.text.secondary,
    ...Typography.variant('body'),
  },
}));
