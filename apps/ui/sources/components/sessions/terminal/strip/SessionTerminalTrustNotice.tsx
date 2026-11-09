import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';

export type SessionTerminalTrustNoticeContent = Readonly<{ lead: string; detail: string }>;

/**
 * The operating-system trust fact of a shared Machine's terminal, said once and quietly: the lead
 * sentence is one tertiary line in the terminal's own strip, and what it means is the hover/focus
 * help (never a banner above the terminal).
 */
export function SessionTerminalTrustNotice(props: Readonly<{
  notice: SessionTerminalTrustNoticeContent;
  /** A narrow pane keeps the mark alone; the sentence stays in the hover/focus help and the label. */
  compact?: boolean;
  testID?: string;
}>) {
  const { theme } = useUnistyles();
  return (
    <Tooltip
      testID={props.testID}
      label={`${props.notice.lead} ${props.notice.detail}`}
      accessibilityLabel={`${props.notice.lead} ${props.notice.detail}`}
      style={props.compact ? styles.compactRoot : styles.root}
    >
      <View style={props.compact ? styles.compactRow : styles.row}>
        <Icon name="key" size={13} color={theme.colors.text.tertiary} />
        {props.compact ? null : <Text style={styles.text} numberOfLines={1}>{props.notice.lead}</Text>}
      </View>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flexShrink: 1, minWidth: 0, marginRight: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 },
  compactRoot: { flexShrink: 0, marginRight: 4 },
  compactRow: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  text: { ...M.tabSubtitle, ...Typography.default(), color: theme.colors.text.tertiary, flexShrink: 1 },
}));
