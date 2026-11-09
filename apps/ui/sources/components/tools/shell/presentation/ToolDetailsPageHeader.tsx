import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolCall } from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';

import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatApprovalStatusLabel, formatToolPermissionDecisionLabel } from '@/components/approvals/approvalStatusLabel';
import { buildToolHeaderModel } from './buildToolHeaderModel';
import { toolActionOutcomeLabel } from './resolveToolActionFailure';
import type { DeclinedApprovalDisposition, ToolStatusIndicatorKind } from './resolveToolStatusIndicatorKind';
import { resolveToolCallOutcome } from './resolveToolCallOutcome';
import { ToolOutcomeStatus } from './ToolOutcomeStatus';
import { ToolStatusIndicator } from './ToolStatusIndicator';

function outcomeWord(kind: ToolStatusIndicatorKind): string | null {
  switch (kind) {
    case 'completed':
      return t('toolView.outcome.completed');
    case 'running':
      return t('toolView.outcome.running');
    case 'permission_pending':
      return t('toolView.outcome.waiting');
    case 'permission_blocked':
      return t('toolView.outcome.blocked');
    case 'error':
      return t('toolView.actionOutcome.failed');
    default:
      return null;
  }
}

/**
 * The tool-details page's identity: the call's title (the Action it ran, the command, the file), its one
 * line, and its outcome in the transcript row's vocabulary — the same glyph, and a refusal or failure as
 * the row's own outcome mark. One owner for every tool kind that opens this page.
 */
export const ToolDetailsPageHeader = React.memo(function ToolDetailsPageHeader(
  props: Readonly<{
    tool: ToolCall;
    metadata: Metadata | null;
    /** The Session whose Agent asked, named when a manager Session handles its question (an Agent-raised question). */
    askedBy?: string | null;
    /** How the person answered this call's Action approval. */
    declinedApproval?: DeclinedApprovalDisposition | null;
  }>,
) {
  const model = React.useMemo(
    () =>
      buildToolHeaderModel({
        tool: props.tool,
        metadata: props.metadata,
        iconSize: 18,
        iconColorPrimary: '',
        iconColorSecondary: '',
      }),
    [props.metadata, props.tool],
  );
  const tool = model.toolForRendering;
  // One outcome owner for this header and the page's Result section.
  const declinedApproval = props.declinedApproval ?? null;
  const decisionLabel = formatToolPermissionDecisionLabel(tool.permission)
    ?? (declinedApproval ? formatApprovalStatusLabel(declinedApproval) : null);
  const result = React.useMemo(() => resolveToolCallOutcome(tool, declinedApproval), [declinedApproval, tool]);
  let outcome: React.ReactNode;
  if (result.kind === 'status' && result.indicator === 'permission_blocked' && decisionLabel) {
    // A person's decision uses the request's vocabulary and quiet mark.
    outcome = (
      <View style={styles.outcome}>
        <ToolOutcomeStatus testID="tool-details-outcome" label={decisionLabel} glyph="minus-circle" tone="quiet" />
      </View>
    );
  } else if (result.kind === 'status') {
    const word = outcomeWord(result.indicator);
    outcome =
      word === null ? undefined : result.indicator === 'error' ? (
        <View style={styles.outcome}>
          <ToolOutcomeStatus testID="tool-details-outcome" label={word} glyph="warning-circle" tone="danger" />
        </View>
      ) : (
        <View
          testID="tool-details-outcome"
          accessible
          accessibilityLabel={word}
          style={styles.outcome}
        >
          <ToolStatusIndicator tool={tool} />
          <Text style={styles.outcomeText} numberOfLines={1}>
            {word}
          </Text>
        </View>
      );
  } else {
    const mark =
      result.kind === 'failure'
        ? result.failure.outcome === 'refused'
          ? { label: toolActionOutcomeLabel('refused', result.failure.code), glyph: 'minus-circle' as const, tone: 'quiet' as const }
          : { label: toolActionOutcomeLabel('failed'), glyph: 'warning-circle' as const, tone: 'danger' as const }
        : result.kind === 'approval_requested'
          ? { label: t('toolView.approvalRequested.title'), glyph: 'paper-plane-tilt' as const, tone: 'quiet' as const }
          : { label: t('toolView.outcome.pending'), glyph: 'clock' as const, tone: 'quiet' as const };
    // The row's outcome mark sits at the line's start here, not at a row's trailing edge.
    outcome = (
      <View style={styles.outcome}>
        <ToolOutcomeStatus testID="tool-details-outcome" {...mark} />
      </View>
    );
  }
  const meta = React.useMemo(
    () => (props.askedBy ? [{ key: 'asked-by', text: t('session.collaboration.discussion.attribution.askedBy', { requester: props.askedBy }), testID: 'tool-details-asked-by' }] : undefined),
    [props.askedBy],
  );
  return (
    <PageHeader
      testID="tool-details-header"
      alwaysShowBack
      title={model.title}
      description={model.subtitle ?? undefined}
      details={outcome}
      meta={meta}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  outcome: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minWidth: 0,
  },
  outcomeText: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
}));
