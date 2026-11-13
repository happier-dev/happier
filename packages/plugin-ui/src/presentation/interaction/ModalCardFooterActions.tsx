import * as React from 'react';
import { StyleSheet, View } from 'react-native';

export type HappierModalCardFooterActionsProps = Readonly<{
  cancel?: React.ReactNode;
  note?: React.ReactNode;
  phoneSheet?: boolean;
  gap: number;
  children?: React.ReactNode;
}>;

/** One short-form footer: quiet dismissal first, primary last; phone sheets keep only full-width actions. */
export function HappierModalCardFooterActions(props: HappierModalCardFooterActionsProps) {
  if (props.phoneSheet) {
    const actions = React.Children.toArray(props.children);
    // Two actions share the sheet's width; three or more stack, each at full width with the primary last
    // (nearest the thumb), so no label clips to "Initialize rep…" at a phone width.
    const stacked = actions.length > 2;
    return <View style={[stacked ? styles.phoneStack : styles.phoneRow, { gap: props.gap }]}>
      {actions.map((child, index) => <View key={index} style={stacked ? null : styles.phoneAction}>{child}</View>)}
    </View>;
  }
  return <View style={[styles.row, { gap: props.gap }]}>
    {props.cancel}
    <View style={styles.lead}>{props.note}</View>
    {props.children}
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  lead: { flex: 1, minWidth: 0 },
  phoneRow: { flexDirection: 'row' },
  phoneStack: { flexDirection: 'column', alignItems: 'stretch' },
  phoneAction: { flex: 1 },
});
