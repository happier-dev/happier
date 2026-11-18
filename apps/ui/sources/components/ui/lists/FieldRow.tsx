import * as React from 'react';
import { Platform, View, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { InlineCode } from '@/components/ui/text/InlineCode';
import { Typography } from '@/constants/Typography';

/** A path or command has no spaces to break at; on web it wraps anywhere instead of running past the row. Native text already breaks long words. */
const WRAP_LONG_TOKENS: TextStyle = Platform.OS === 'web' ? ({ overflowWrap: 'anywhere' } as TextStyle) : {};

/**
 * On web a path breaks after its separators, never inside a name: `<wbr>` adds the break chance without changing the
 * copied text, and `overflowWrap` stays the last resort for a token with no separator. Native text breaks on its own.
 */
function withSeparatorBreaks(value: string): React.ReactNode {
  if (Platform.OS !== 'web') return value;
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== '/' && value[index] !== '\\') continue;
    // A run of separators (the `//` after a scheme) stays together; the break comes after the last one.
    if (value[index + 1] === '/' || value[index + 1] === '\\') continue;
    segments.push(value.slice(start, index + 1));
    start = index + 1;
  }
  if (segments.length === 0) return value;
  segments.push(value.slice(start));
  return segments.map((segment, index) => (
    <React.Fragment key={index}>
      {index > 0 ? React.createElement('wbr') : null}
      {segment}
    </React.Fragment>
  ));
}

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
          {withSeparatorBreaks(props.value)}
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
    ...WRAP_LONG_TOKENS,
    color: theme.colors.text.primary,
  },
  codeValueText: {
    ...happierPageTextMetrics('rowTitle'),
    ...Typography.mono(),
    ...WRAP_LONG_TOKENS,
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
