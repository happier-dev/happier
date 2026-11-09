import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * The box of the File page region a floating card is mounted in, for `Popover.horizontalBoundaryRef`:
 * cards at a name slide back inside the File page instead of running over the columns beside it, and
 * keep a gutter from the page's edges so a wide card never sits flush against the column beside it.
 * Render `box` beside the Popover, inside that region.
 *
 * A card opened by a command (Format, Organize imports) has no name on the page to hang from: it takes
 * `seat`, a band across the top of the same region, so every stage of it lands in the page the same way.
 */
export function useFilePageBox(): Readonly<{
  ref: React.RefObject<View | null>;
  seat: React.RefObject<View | null>;
  box: React.ReactElement;
}> {
  const ref = React.useRef<View>(null);
  const seat = React.useRef<View>(null);
  const box = (
    <View ref={ref} style={styles.box}>
      <View ref={seat} style={styles.seat} />
    </View>
  );
  return { ref, seat, box };
}

const styles = StyleSheet.create((theme) => ({
  box: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: theme.space.s8,
    right: theme.space.s8,
    pointerEvents: 'none',
  },
  seat: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    // Taller than a hairline: the Popover rejects an anchor it cannot measure as a box.
    height: theme.space.s8,
  },
}));
