import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { InboxPluginSessionControlInvoker } from '@/hooks/inbox/useInboxPluginSessionControls';

import type { InboxPluginSessionRow } from './inboxItemProjection';

/**
 * What a plugin says about a Session in its Inbox row (lab forge-ci c4: "Watching 2 PRs · #2512 Auto-fix, paused at
 * the fix limit"), under the Session's own line, and the row's declared controls ("Continue 3 more"). Row data only
 * describes intent: each control reaches the viewer's ordinary Action front door through `invoke`, which owns
 * availability, policy and confirmation. Nothing here interprets a plugin's ids or Action input.
 */
export const InboxPluginSessionLines = React.memo(
  function InboxPluginSessionLines(
    props: Readonly<{
      rows: readonly InboxPluginSessionRow[];
      invoke: InboxPluginSessionControlInvoker;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const [failed, setFailed] = React.useState<string | null>(null);
    const [pending, setPending] = React.useState<string | null>(null);
    const controls = props.rows.flatMap((row) =>
      (row.controls ?? []).map((control) => ({ row, control })),
    );
    if (props.rows.length === 0) return null;
    return (
      <View style={styles.stack} testID={props.testID}>
        {props.rows.map((row) => (
          <View
            key={row.key}
            style={styles.line}
            testID={`${props.testID}.${row.key}`}
          >
            <Icon name="eye" size={14} color={theme.colors.text.tertiary} />
            <Text style={styles.lineText} numberOfLines={2}>
              {row.row.detail
                ? `${row.row.title} · ${row.row.detail}`
                : row.row.title}
            </Text>
          </View>
        ))}
        {controls.length > 0 ? (
          <View style={styles.controls}>
            {controls.map(({ row, control }, index) => {
                const controlKey = `${row.key}:${control.id}`;
                const press = async () => {
                  if (pending !== null) return;
                  setFailed(null);
                  setPending(controlKey);
                  try {
                    const outcome = await props.invoke(row, control.id);
                    if (didNotGoThrough(outcome)) setFailed(control.id);
                  } finally {
                    setPending(null);
                  }
                };
                const waiting = pending !== null && pending !== controlKey;
                // The first declared control is the row's one bordered action; the rest read as quiet links.
                return index === 0 ? (
                  <RoundButton key={controlKey} testID={`${props.testID}.control.${control.id}`}
                    size="small" display="secondary" title={control.label} onPress={press}
                    loading={pending === controlKey} disabled={waiting} />
                ) : (
                  // The link keeps its own sentence-baseline alignment; this row centers it on the bordered button's height.
                  <View key={controlKey} style={styles.quietControl}>
                    <TextLinkButton testID={`${props.testID}.control.${control.id}`}
                      label={control.label} onPress={press} disabled={pending !== null} />
                  </View>
                );
              })}
          </View>
        ) : null}
        {failed !== null ? (
          <Text style={styles.failed} testID={`${props.testID}.failed`}>
            {t('inbox.work.rows.pluginControlUnavailable')}
          </Text>
        ) : null}
      </View>
    );
  },
);

/** A refusal is the Action's own answer ("stale", "not allowed"); the person's cancelled confirmation is not one. */
function didNotGoThrough(outcome: Awaited<ReturnType<InboxPluginSessionControlInvoker>>): boolean {
  if (outcome.kind === 'unavailable') return true;
  return outcome.kind === 'action' && !outcome.result.ok && outcome.result.errorCode !== 'cancelled';
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.space.s6, marginTop: theme.space.s4 },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s6,
    minWidth: 0,
  },
  lineText: {
    flex: 1,
    minWidth: 0,
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    marginTop: theme.space.s4,
  },
  quietControl: { justifyContent: 'center' },
  failed: {
    ...Typography.variant('meta'),
    color: theme.colors.state.danger.textForeground,
  },
}));
