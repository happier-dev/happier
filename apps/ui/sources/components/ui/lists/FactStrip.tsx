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
    testID?: string;
  }>,
) {
  if (props.facts.length === 0) return null;
  return (
    <View style={styles.strip} testID={props.testID}>
      {props.facts.map((fact) => (
        <View key={fact.key} style={styles.fact} testID={fact.testID}>
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
  label: { color: theme.colors.text.tertiary },
  value: { color: theme.colors.text.primary, fontVariant: ['tabular-nums'] },
  danger: { color: theme.colors.state.danger.textForeground },
  attention: { color: theme.colors.state.attention.textForeground },
}));
