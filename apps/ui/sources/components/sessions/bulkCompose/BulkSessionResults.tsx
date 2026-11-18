import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';

import { buildBulkSessionResultRowData } from '@/components/sessions/authoring/bulk/bulkSessionResultRows';
import {
  bulkChangeTargetKey,
  type BulkSessionChangeRow,
} from '@/components/sessions/authoring/bulk/executeBulkSessionChanges';
import { SessionAskTargetRow } from '@/components/sessions/transcript/askRecord/SessionAskRecord';
import {
  UserMessageBubble,
  userMessageBubbleAlignerStyle,
} from '@/components/sessions/transcript/UserMessageBubble';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { resolveTranscriptPaint } from '@/components/sessions/transcript/transcriptPaint';
import { t } from '@/text';

import {
  describeBulkRowReason,
  describeBulkRowState,
  formatBulkSummary,
  summarizeBulkRows,
} from './bulkSessionComposePresentation';

const RESULTS_COLUMN_MAX_WIDTH = 760;

/**
 * The same page after Send (lab bc results): what was sent, then one row per session, failures first, with the
 * skipped ones in their own group. Rows update as each target's result arrives (BC-A's per-target event).
 */
export function BulkSessionResults(
  props: Readonly<{
    rows: readonly BulkSessionChangeRow[];
    text: string | null;
    submitting: boolean;
    compact: boolean;
    onRetry: (target: ActionSessionAddressV1) => void;
    onRetryFailed: () => void;
    onDone: () => void;
    onOpenSession: (href: string) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const summary = summarizeBulkRows(props.rows);
  const delivered = props.rows.filter((row) => row.state !== 'skipped');
  const skipped = props.rows.filter((row) => row.state === 'skipped');
  const message = Boolean(props.text);
  const recipients = delivered.length;
  return (
    <ScrollView
      testID="bulk-compose-results"
      contentContainerStyle={styles.scroll}
    >
      <View style={styles.column}>
        <View style={styles.header}>
          <Icon
            name="chat-circle"
            size={18}
            color={theme.colors.text.secondary}
          />
          <Text
            variant="label"
            style={[styles.headline, { color: theme.colors.text.secondary }]}
            numberOfLines={2}
          >
            {message
              ? t('session.participants.bulk.sentTo')
              : t('session.participants.bulk.changed')}{' '}
            <Text
              variant="label"
              emphasis="semiBold"
              style={{ color: theme.colors.text.primary }}
            >
              {t('session.participants.bulk.sessions', { count: recipients })}
            </Text>
          </Text>
          <StatusPill
            testID="bulk-compose-results-summary"
            variant="neutral"
            labelVariant="phrase"
            label={formatBulkSummary(summary)}
            foregroundColor={theme.colors.text.secondary}
          />
        </View>
        {props.text ? (
          <View style={styles.bubbleRow}>
            <View style={userMessageBubbleAlignerStyle}>
              <UserMessageBubble>
                <Text
                  variant="reading"
                  selectable
                  style={{ color: resolveTranscriptPaint(theme, 'user-bubble', 'text').foreground.color }}
                >
                  {props.text}
                </Text>
              </UserMessageBubble>
            </View>
          </View>
        ) : null}
        {delivered.length > 0 ? (
          <ItemGroup testID="bulk-compose-results-rows">
            {delivered.map((row) => (
              <ResultRow
                key={bulkChangeTargetKey(row.target)}
                row={row}
                compact={props.compact}
                onRetry={props.onRetry}
                onOpenSession={props.onOpenSession}
                busy={props.submitting}
              />
            ))}
          </ItemGroup>
        ) : null}
        {skipped.length > 0 ? (
          <ItemGroup
            testID="bulk-compose-results-skipped"
            title={t('session.participants.skippedGroupTitle')}
          >
            {skipped.map((row) => (
              <ResultRow
                key={bulkChangeTargetKey(row.target)}
                row={row}
                compact={props.compact}
                onRetry={props.onRetry}
                onOpenSession={props.onOpenSession}
                busy={props.submitting}
              />
            ))}
          </ItemGroup>
        ) : null}
        <View
          style={[styles.footer, props.compact ? styles.footerCompact : null]}
        >
          {summary.notSent > 1 ? (
            <RoundButton
              testID="bulk-compose-retry-failed"
              size="normal"
              title={t('session.participants.bulk.retryFailed')}
              leading={
                <Icon
                  name="arrows-clockwise"
                  size={16}
                  color={theme.colors.button.primary.tint}
                />
              }
              disabled={props.submitting}
              onPress={props.onRetryFailed}
            />
          ) : (
            <View />
          )}
          <TextLinkButton
            testID="bulk-compose-done"
            label={t('common.done')}
            tone="strong"
            onPress={props.onDone}
          />
        </View>
      </View>
    </ScrollView>
  );
}

const ResultRow = React.memo(function ResultRow(
  props: Readonly<{
    row: BulkSessionChangeRow;
    compact: boolean;
    busy: boolean;
    onRetry: (target: ActionSessionAddressV1) => void;
    onOpenSession: (href: string) => void;
    /** Injected by the group: another row follows this one. */
    showDivider?: boolean;
  }>,
) {
  const { row } = props;
  const data = React.useMemo(
    () =>
      buildBulkSessionResultRowData(
        row,
        `bulk:${bulkChangeTargetKey(row.target)}`,
      ),
    [row],
  );
  const action =
    row.state === 'failed' ? (
      <RoundButton
        testID={`bulk-compose-retry:${row.target.sessionId}`}
        size="small"
        display="secondary"
        title={t('common.retry')}
        disabled={props.busy}
        onPress={() => props.onRetry(row.target)}
      />
    ) : row.state === 'approval_pending' ? (
      <RoundButton
        testID={`bulk-compose-review:${row.target.sessionId}`}
        size="small"
        display="secondary"
        title={t('session.participants.bulk.review')}
        onPress={() => props.onOpenSession('/inbox')}
      />
    ) : null;
  return (
    <View style={styles.rowInset}>
      <SessionAskTargetRow
        testID={`bulk-compose-result:${row.target.sessionId}`}
        target={data.target}
        serverId={row.target.serverId}
        reply="none"
        state={describeBulkRowState(row)}
        reason={describeBulkRowReason(row)}
        action={action}
        reserveActionColumn
        compact={props.compact}
        navigate={props.onOpenSession}
        followed={props.showDivider === true}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  scroll: {
    alignItems: 'center',
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s32,
    paddingBottom: theme.space.s32,
  },
  column: {
    width: '100%',
    maxWidth: RESULTS_COLUMN_MAX_WIDTH,
    gap: theme.space.s12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: theme.space.s10,
    rowGap: theme.space.s4,
  },
  headline: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 190,
  },
  bubbleRow: {
    alignSelf: 'stretch',
  },
  rowInset: {
    paddingHorizontal: theme.space.s16,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: theme.space.s4,
  },
  footerCompact: {
    flexDirection: 'column-reverse',
    alignItems: 'stretch',
    rowGap: theme.space.s12,
  },
}));
