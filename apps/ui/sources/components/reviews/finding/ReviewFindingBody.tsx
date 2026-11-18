import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { CodeBlockViewFrame } from '@/components/ui/code/blocks/CodeBlockViewFrame';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { formatReviewFindingLocation } from '@/components/sessions/reviews/findings/reviewFindingPresentation';

/** One reviewer that reported a finding, in the order they reported it. */
export type ReviewFindingReviewer = Readonly<{
  label: string;
  backendId: string;
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
    reviewers: readonly ReviewFindingReviewer[];
    /** A line between the cause and the code ("Updated after your question", why a decision can't be saved). */
    notice?: React.ReactNode;
    /** The questions and answers about this finding and the field for the next one. */
    conversation: React.ReactNode;
  }>,
) {
  const { finding } = props;
  const impact = finding.whyItMatters ?? null;
  return (
    <View testID={`review-finding-body:${props.rowId}`} style={styles.body}>
      <View style={styles.why}>
        {impact ? (
          <Text selectable style={styles.impact}>
            {impact}
          </Text>
        ) : null}
        <Text selectable style={impact ? styles.cause : styles.impact}>
          {finding.summary}
        </Text>
        {props.notice ?? null}
      </View>
      <ReviewFindingWhere finding={finding} rowId={props.rowId} />
      {finding.evidence ? (
        <View
          testID={`review-finding-verified:${props.rowId}`}
          style={styles.section}
        >
          <Text
            accessibilityRole="header"
            variant="label"
            emphasis="semiBold"
            style={styles.label}
          >
            {t('runPage.review.howItWasVerified')}
          </Text>
          <MarkdownView markdown={finding.evidence} textStyle={styles.prose} />
        </View>
      ) : null}
      <View
        testID={`review-finding-conversation:${props.rowId}`}
        style={styles.section}
      >
        <Text
          accessibilityRole="header"
          variant="label"
          emphasis="semiBold"
          style={styles.label}
        >
          {t('runPage.review.conversation')}
        </Text>
        <ReviewFindingReviewers reviewers={props.reviewers} />
        {props.conversation}
      </View>
    </View>
  );
}

/** Where: the flagged lines with the suggested fix applied, or the place alone when no fix came with it. */
function ReviewFindingWhere(
  props: Readonly<{ finding: ReviewFinding; rowId: string }>,
) {
  const { theme } = useUnistyles();
  const { finding } = props;
  const location = formatReviewFindingLocation(finding);
  if (!location && !finding.patch && !finding.suggestion) return null;
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
  body: {
    gap: theme.space.s24,
  },
  why: {
    gap: theme.space.s4,
  },
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
