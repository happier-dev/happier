import * as React from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * Holds the exact box of content whose shape is known before its state is: `shape` (the rows or line that will most
 * likely land, drawn through their own owners) stands unseen, hidden from assistive technology and the pointer, and
 * `children` (the section's quiet loading state) stand over its top edge. What lands in that shape replaces it
 * without moving anything below; nothing about the content is claimed while it is read.
 */
export function ReservedShape(
  props: Readonly<{
    shape: React.ReactNode;
    children: React.ReactNode;
    /** Names the unseen shape (for tests and probes); the reserve itself carries no id. */
    shapeTestID?: string;
  }>,
) {
  return (
    <View>
      <View
        testID={props.shapeTestID}
        style={styles.unseen}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
        pointerEvents="none"
      >
        {props.shape}
      </View>
      <View style={styles.over}>{props.children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  unseen: { opacity: 0 },
  over: { position: 'absolute', top: 0, left: 0, right: 0 },
});
