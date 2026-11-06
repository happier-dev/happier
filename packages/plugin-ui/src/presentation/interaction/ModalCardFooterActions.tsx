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
    return <View style={[styles.phoneRow, { gap: props.gap }]}>
      {React.Children.map(props.children, (child) => child == null || child === false
        ? null : <View style={styles.phoneAction}>{child}</View>)}
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
  phoneAction: { flex: 1 },
});
