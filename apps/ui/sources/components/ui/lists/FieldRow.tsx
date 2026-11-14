import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { InlineCode } from '@/components/ui/text/InlineCode';
import { Typography } from '@/constants/Typography';

/** The label column: wide enough for a short phrase ("Before it starts"), so every value shares one edge. */
const FIELD_LABEL_WIDTH_PX = 128;

/**
 * A read-only fact's anatomy inside a page row (an approval's arguments, a service's configuration): the label stays
 * quiet and the value reads first, at every width. Wide, the labels share one column and the values one edge down the
 * section; a phone sets each label above its value. Render it as an info `Item`'s title so the row keeps the section's
 * sheet, dividers and insets.
 */
export function FieldLayout(
  props: Readonly<{
    label: string;
    columns: boolean;
    children: React.ReactNode;
  }>,
) {
  return (
    <View style={props.columns ? styles.columns : styles.stacked}>
      <Text style={props.columns ? styles.columnLabel : styles.stackedLabel}>
        {props.label}
      </Text>
      <View style={styles.columnValue}>{props.children}</View>
    </View>
  );
}

/**
 * A value, the names it lists as chips, then the quieter line that finishes it. `code` sets a literal people compare
 * character by character (a fingerprint, an image, a command) in the code face at the row's size.
 */
export function FieldValue(
  props: Readonly<{
    value: string;
    names?: readonly string[];
    note?: string | null;
    code?: boolean;
  }>,
) {
  return (
    <View style={styles.value}>
      {props.names?.length ? (
        <View style={styles.names}>
          {props.names.map((name) => (
            <InlineCode key={name}>{name}</InlineCode>
          ))}
        </View>
      ) : (
        <Text style={props.code ? styles.codeValueText : styles.valueText}>
          {props.value}
        </Text>
      )}
      {props.note ? <Text style={styles.noteText}>{props.note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  columns: {
    flexDirection: 'row',
    gap: theme.space.s16,
  },
  // The label sits on the value's first line: the steps differ, so it drops by half their difference.
  columnLabel: {
    ...happierPageTextMetrics('rowDescription'),
    width: FIELD_LABEL_WIDTH_PX,
    flexShrink: 0,
    paddingTop:
      (happierPageTextMetrics('rowTitle').lineHeight -
        happierPageTextMetrics('rowDescription').lineHeight) /
      2,
    color: theme.colors.text.tertiary,
  },
  stacked: {
    gap: theme.space.s4,
  },
  stackedLabel: {
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.tertiary,
  },
  columnValue: {
    flex: 1,
    minWidth: 0,
  },
  value: {
    gap: theme.space.s4,
  },
  valueText: {
    ...happierPageTextMetrics('rowTitle'),
    ...Typography.default(),
    color: theme.colors.text.primary,
  },
  codeValueText: {
    ...happierPageTextMetrics('rowTitle'),
    ...Typography.mono(),
    color: theme.colors.text.primary,
  },
  noteText: {
    ...happierPageTextMetrics('rowDescription'),
    ...Typography.default(),
    color: theme.colors.text.secondary,
  },
  names: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s4,
  },
}));
