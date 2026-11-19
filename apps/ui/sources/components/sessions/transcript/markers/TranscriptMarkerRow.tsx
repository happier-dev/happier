import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { TranscriptMarker } from '@/components/sessions/chatListItems';
import { formatTranscriptNavigationDuration } from '@/components/sessions/transcript/navigation/transcriptNavigationTimeFormat';
import { TranscriptSeparatorRow } from '@/components/sessions/transcript/separators/TranscriptSeparatorRow';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * Quiet transcript furniture between rows (ideas-1118-shell scene 2): the centred "New" divider at the read
 * cursor, or a settled turn's "Worked for 1m 12s" / "Stopped after 40s" in the reply column. The duration line
 * is meta, not a heading: tertiary ink, tabular figures, the same length format as the Navigate pane.
 */
export const TranscriptMarkerRow = React.memo(function TranscriptMarkerRow(
  props: Readonly<{ marker: TranscriptMarker }>,
) {
  const columnStyle = useLayoutMaxWidthStyle();
  const { marker } = props;
  if (marker.type === 'new') {
    return (
      <View style={[styles.column, columnStyle]}>
        <TranscriptSeparatorRow
          testID="transcript-new-divider"
          title={t('session.transcriptTurnEnd.newDivider')}
          accessibilityLabel={t('session.transcriptTurnEnd.newDividerA11y')}
          chipChrome="minimal"
          tone="unread"
          padding="none"
          containerStyle={styles.newDivider}
        />
      </View>
    );
  }
  const duration = formatTranscriptNavigationDuration(marker.durationMs);
  if (duration === null) return null;
  const text =
    marker.outcome === 'worked'
      ? t('session.transcriptTurnEnd.workedFor', { duration })
      : t('session.transcriptTurnEnd.stoppedAfter', { duration });
  return (
    <View style={[styles.column, columnStyle]}>
      <Text
        testID="transcript-turn-duration"
        style={[styles.duration, marker.joinsChanges ? styles.durationAboveChanges : styles.durationClosingTurn]}
        accessibilityRole="text"
        numberOfLines={1}
      >
        {text}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The reply column every message row uses: the full row up to the layout's max width, centred.
  column: {
    width: '100%',
    alignSelf: 'center',
    minWidth: 0,
  },
  newDivider: {
    marginHorizontal: theme.space.s16,
    paddingTop: theme.space.s8,
    paddingBottom: theme.space.s16,
  },
  // Sits in the turn's reply column; the space after it closes the turn (or meets its changes card).
  duration: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.tertiary,
    marginHorizontal: theme.space.s16,
  },
  // The line closes its turn: the space below it is larger than the message band above it, so it reads as
  // the end of this turn rather than the start of the next.
  durationClosingTurn: {
    paddingBottom: theme.space.s24,
  },
  // Directly above its turn's changes card, as one turn-end block.
  durationAboveChanges: {
    paddingBottom: theme.space.s8,
  },
}));
