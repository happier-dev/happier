import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { resolveSessionScmReviewComparisonLabel } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import {
  StructuredFindText,
  type StructuredFindTextBlock,
} from '@/components/sessions/transcript/structured/structuredFindText';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SURFACE_CARD_RADIUS_PX } from '@/components/ui/cards/surfaceCardMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useScmResultReceiptUndo } from './useScmResultReceiptUndo';
import { scmReviewComparisonOfCaptured } from '@/sync/domains/scm/diffSummary/selection';
import type { ScmDiffSummaryPublishedResult } from '@/sync/domains/scm/diffSummary/publicationReceipt';
import { t } from '@/text';

/** "2–3", "1, 3, 5–6": the stop numbers a reader sees in the walkthrough. */
function formatStopNumbers(numbers: readonly number[]): string {
  const runs: string[] = [];
  for (let index = 0; index < numbers.length; ) {
    let end = index;
    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end]! + 1) end += 1;
    runs.push(end > index ? `${numbers[index]}–${numbers[end]}` : String(numbers[index]));
    index = end + 1;
  }
  return runs.join(', ');
}

/**
 * What an update changed, in the reader's numbering, from the owner's notice only: a merge is named
 * only when the owner says stops were merged; ids missing from the current walkthrough were removed.
 */
function describeWalkthroughUpdate(
  publication: ScmDiffSummaryPublishedResult['publication'],
  stops: readonly Readonly<{ id: string }>[],
): string[] {
  const notice = publication.updateNotice;
  const numberOf = (id: string) => stops.findIndex((stop) => stop.id === id) + 1;
  const parts: string[] = [];
  if (notice?.kind === 'undo') {
    parts.push(t('walkthrough.receipt.lastChangeUndone'));
  } else if (notice?.mergedStopIds?.length) {
    const target = notice.mergedStopIds.map(numberOf).find((number) => number > 0);
    if (target) {
      parts.push(t('walkthrough.receipt.stopsMergedInto', { count: notice.mergedStopIds.length, number: target }));
    }
  } else if (notice) {
    const numbers = notice.affectedStopIds.map(numberOf).filter((number) => number > 0).sort((a, b) => a - b);
    const removed = notice.affectedStopIds.length - numbers.length;
    if (numbers.length === 1) parts.push(t('walkthrough.receipt.stopChanged', { number: numbers[0]! }));
    else if (numbers.length > 1) parts.push(t('walkthrough.receipt.stopsChanged', { numbers: formatStopNumbers(numbers) }));
    if (removed > 0) parts.push(t('walkthrough.receipt.stopsRemoved', { count: removed }));
  }
  if (publication.titleEditKept) parts.push(t('walkthrough.receipt.titleEditKept'));
  return parts;
}

function buildReceiptContent(receipt: ScmDiffSummaryPublishedResult) {
  const walkthroughChange = receipt.publication.outputs.find(
    (output) => output.kind === 'walkthrough',
  )?.change;
  const created = receipt.publication.outputs.every(
    (output) => output.change === 'created',
  );
  const walkthrough = walkthroughChange
    ? receipt.output.outputs?.walkthrough?.value
    : undefined;
  const comparison = scmReviewComparisonOfCaptured(receipt.output.comparison);
  const updateFacts = walkthroughChange === 'updated' && walkthrough
    ? describeWalkthroughUpdate(receipt.publication, walkthrough.stops)
    : [];
  const facts = updateFacts.length ? updateFacts : [
    comparison ? resolveSessionScmReviewComparisonLabel(comparison) : null,
    t('scmComparison.fileCount', {
      count: receipt.output.comparison.inventory.files.length,
    }),
    walkthrough
      ? t('walkthrough.receipt.stopCount', { count: walkthrough.stops.length })
      : null,
  ].filter((fact): fact is string => Boolean(fact));
  return {
    comparison,
    isWalkthrough: Boolean(walkthroughChange),
    created: walkthroughChange ? walkthroughChange === 'created' : created,
    verb: walkthroughChange
      ? walkthroughChange === 'created'
        ? t('walkthrough.receipt.wrote')
        : t('walkthrough.receipt.updated')
      : created
        ? t('walkthrough.receipt.savedAnalysis')
        : t('walkthrough.receipt.updatedAnalysis'),
    facts: facts.join(' · '),
    title: walkthrough?.title ?? null,
  };
}

/** Find reads exactly the words the receipt shows. */
export function projectScmResultReceiptFindText(
  receipt: ScmDiffSummaryPublishedResult,
): readonly StructuredFindTextBlock[] {
  const content = buildReceiptContent(receipt);
  return [
    { id: 'structured-scm-receipt:verb', text: content.verb },
    { id: 'structured-scm-receipt:facts', text: content.facts },
    ...(content.title
      ? [{ id: 'structured-scm-receipt:title', text: content.title }]
      : []),
  ];
}

/**
 * The one transcript receipt for a saved change summary (lab WT3-D3): what the generator wrote or
 * updated, of which comparison, and the way into that saved reading. It replaces the Run's own summary
 * line, so the transcript never says the same thing twice. What was written reads as a quiet filled
 * strip with its title; an update is one inline line led by a check, between the question and the reply.
 */
export function ScmResultReceiptCard(
  props: Readonly<{
    receipt: ScmDiffSummaryPublishedResult;
    sessionId: string;
    serverId?: string | null;
    canNavigate: boolean;
    /** The viewer may change this Session's work (Undo is a change, not a read). */
    canControl: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const undo = useScmResultReceiptUndo({
    receipt: props.receipt,
    sessionId: props.sessionId,
    serverId: props.serverId,
    canControl: props.canControl,
  });
  const source = useSessionTranscriptSource();
  const navigate = source.navigate;
  const content = buildReceiptContent(props.receipt);
  const { comparison, isWalkthrough } = content;
  const { sessionId, serverId } = props;
  const open = React.useCallback(() => {
    if (!navigate || !comparison) return;
    navigate(
      buildSessionDetailsHref({
        sessionId,
        serverId,
        details: {
          kind: 'scmReview',
          comparison: { ...comparison, savedResult: {
            cwd: props.receipt.output.comparison.repository.rootPath,
            resultId: props.receipt.output.resultId,
          } },
          view: isWalkthrough ? 'walkthrough' : 'files',
        },
      }),
    );
  }, [comparison, isWalkthrough, navigate, serverId, sessionId, props.receipt.output]);
  const canOpen = props.canNavigate && Boolean(navigate) && comparison !== null;
  const openLink = canOpen ? (
    <TextLinkButton
      testID="scm-result-receipt-open"
      size="meta"
      label={
        isWalkthrough
          ? t('walkthrough.receipt.open')
          : t('walkthrough.receipt.openChanges')
      }
      onPress={open}
    />
  ) : null;
  const headerLine = (
    <View style={styles.headerText}>
      <StructuredFindText
        blockId="structured-scm-receipt:verb"
        text={content.verb}
        style={content.created ? styles.verb : styles.updateVerb}
        numberOfLines={1}
      />
      <StructuredFindText
        blockId="structured-scm-receipt:facts"
        text={`· ${content.facts}`}
        style={styles.facts}
        numberOfLines={1}
      />
    </View>
  );
  if (!content.created) {
    // Undo is reversible, so it acts at once; while it runs and once it lands, the words say so in place.
    const undoControl = undo.undoing ? (
      <Text testID="scm-result-receipt-undoing" style={styles.facts} numberOfLines={1}>
        {t('walkthrough.receipt.undoing')}
      </Text>
    ) : undo.undone ? (
      <Text testID="scm-result-receipt-undone" style={styles.facts} numberOfLines={1}>
        {t('walkthrough.receipt.undone')}
      </Text>
    ) : undo.onUndo ? (
      <TextLinkButton
        testID="scm-result-receipt-undo"
        size="meta"
        label={t('walkthrough.receipt.undo')}
        onPress={undo.onUndo}
      />
    ) : null;
    return (
      <View testID="scm-result-receipt" style={styles.updateBlock}>
        <View style={styles.update}>
          <Icon
            name="check-circle"
            size={ICON_SIZE.sm}
            color={theme.colors.state.success.foreground}
          />
          {/* One sentence that wraps on a phone, so what changed is never truncated away. */}
          <Text style={styles.updateSentence}>
            <StructuredFindText
              blockId="structured-scm-receipt:verb"
              text={content.verb}
              style={styles.updateVerb}
            />
            <StructuredFindText
              blockId="structured-scm-receipt:facts"
              text={` · ${content.facts}`}
              style={styles.facts}
            />
          </Text>
          {undoControl}
          {openLink}
        </View>
        {undo.error ? (
          // A walkthrough that moved on after this update is a fact about it, not a failure to alarm about.
          <Text
            testID="scm-result-receipt-undo-error"
            accessibilityRole={undo.failure?.errorCode === 'revision_conflict' ? undefined : 'alert'}
            style={undo.failure?.errorCode === 'revision_conflict' ? styles.facts : styles.error}
          >
            {undo.error}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View testID="scm-result-receipt" style={styles.strip}>
      <View style={styles.header}>
        <Icon
          name="path"
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        />
        {headerLine}
        {openLink}
      </View>
      {content.title ? (
        <StructuredFindText
          blockId="structured-scm-receipt:title"
          text={content.title}
          selectable
          style={styles.title}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  strip: {
    gap: theme.space.s6,
    paddingVertical: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    borderRadius: SURFACE_CARD_RADIUS_PX,
    // The raised surface, flat: a quiet strip in flow (lab WT3-D3), never a bordered card.
    backgroundColor: theme.colors.surface.elevated,
  },
  updateBlock: {
    gap: theme.space.s2,
  },
  update: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    paddingVertical: theme.space.s4,
  },
  updateSentence: {
    flex: 1,
    minWidth: 0,
    ...Typography.variant('meta'),
  },
  updateVerb: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.secondary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s4,
  },
  verb: {
    flexShrink: 0,
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  facts: {
    flexShrink: 1,
    minWidth: 0,
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  error: {
    // Aligned under the words, past the check.
    paddingLeft: ICON_SIZE.sm + theme.space.s8,
    ...Typography.variant('meta'),
    color: theme.colors.state.danger.foreground,
  },
  title: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
  },
}));
