import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * Where the selection bar sits: floating just above the composer stack, taking no height (owner 06), so starting
 * a selection never pushes the transcript. Out of flow, it adds no gap to the stack either; on a narrow pane it
 * may cover the end of the transcript, which the bar's own floating material is made for. Only the bar takes
 * pointer input; the empty band around it passes presses through to the transcript.
 */
export function TranscriptSelectionToolbarSeat(
  props: Readonly<{ children: React.ReactNode }>,
) {
  return (
    <View
      testID="transcript-selection-toolbar-seat"
      pointerEvents="box-none"
      style={styles.seat}
    >
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  seat: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: '100%',
    marginBottom: theme.space.s8,
    alignItems: 'center',
    zIndex: 1,
  },
}));
