import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export type FactStripFact = Readonly<{
  key: string;
  /** What the fact is ("Health", "Kept for rollback"), read first and quietly. */
  label: string;
  /** Its current value, one short phrase ("Passing", "1 previous"). */
  value: string;
  /** Only a value that needs someone speaks in colour: amber needs you, rose failed. */
  tone?: 'attention' | 'danger';
  /** One quiet line under the value that qualifies it ("migrate ran once", "deployed 2 hours ago"). */
  detail?: React.ReactNode;
  /** In columns, a fact whose value is a sentence (a commit's subject) takes two shares, or a whole phone row. */
  wide?: boolean;
  testID?: string;
}>;

/**
 * A thing's few headline facts side by side, a quiet label over each value (lab `fc-facts`): an
 * Environment's health, services, rollout and what is kept for rollback. Facts never wrap inside a
 * word; when the column is too narrow for one line they wrap to the next line whole.
 */
export const FactStrip = React.memo(function FactStrip(
  props: Readonly<{
    facts: readonly FactStripFact[];
    /**
     * `wrap` (default) sets facts side by side at their own widths. `columns` shares the width, so a receipt's or a
     * page's headline facts line up as cells; `narrow` (a phone) puts two to a row. `divided` rules the cells apart.
     */
    layout?: 'wrap' | 'columns';
    narrow?: boolean;
    divided?: boolean;
    testID?: string;
  }>,
) {
  if (props.facts.length === 0) return null;
  const columns = props.layout === 'columns';
  return (
    <View style={[styles.strip, columns ? styles.columns : null, columns && props.divided ? styles.columnsDivided : null]}
      testID={props.testID}>
      {props.facts.map((fact, index) => (
        <View key={fact.key} testID={fact.testID} style={[styles.fact, columns ? [
          props.narrow ? (fact.wide ? styles.narrowWide : styles.narrowCell) : fact.wide ? styles.cellWide : styles.cell,
          props.divided ? styles.cellDivided : null,
          props.divided && (props.narrow ? index % 2 === 0 || fact.wide : index === 0) ? styles.cellLeading : null,
        ] : null]}>
          <Text variant="meta" style={styles.label} numberOfLines={1}>
            {fact.label}
          </Text>
          <Text
            variant="label"
            style={[
              styles.value,
              fact.tone === 'danger'
                ? styles.danger
                : fact.tone === 'attention'
                  ? styles.attention
                  : null,
            ]}
          >
            {fact.value}
          </Text>
          {fact.detail === undefined || fact.detail === null ? null : (
            <Text variant="meta" style={styles.detail} numberOfLines={columns ? 1 : undefined}>{fact.detail}</Text>
          )}
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: theme.space.s32,
    rowGap: theme.space.s12,
  },
  fact: { minWidth: 0, maxWidth: '100%', gap: theme.space.s2 },
  // Columns: cells share the row; a phone keeps two to a row and a wide fact takes its own.
  columns: { flexWrap: 'wrap', columnGap: theme.space.s16, rowGap: theme.space.s12 },
  columnsDivided: { columnGap: 0, rowGap: 0 },
  cell: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  cellWide: { flexGrow: 2, flexShrink: 1, flexBasis: 0 },
  narrowCell: { flexGrow: 1, flexShrink: 1, flexBasis: '40%' },
  narrowWide: { flexBasis: '100%' },
  // Divided cells carry their own inset and a hairline on their leading edge, except a row's first.
  cellDivided: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border.subtle,
  },
  cellLeading: { borderLeftWidth: 0 },
  detail: { color: theme.colors.text.secondary },
  label: { color: theme.colors.text.tertiary },
  value: { color: theme.colors.text.primary, fontVariant: ['tabular-nums'] },
  danger: { color: theme.colors.state.danger.textForeground },
  attention: { color: theme.colors.state.attention.textForeground },
}));
