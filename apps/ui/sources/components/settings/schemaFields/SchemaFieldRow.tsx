import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The one row around a schema-declared setting's control, for Home registry settings and plugin
 * settings alike: the label, the hint under it, and the control in the row's one slot. The domain
 * adapter decides which control and owns drafts, validation and writes; it never draws its own
 * label, hint or status type.
 *
 * `inline` keeps a switch or a short value at the row's end; `adaptive` moves a segmented control or
 * a field beneath the label when the row is too narrow for both; `stacked` always places a wide
 * control (a long field with its actions) beneath.
 */
export type SchemaFieldRowLayout = 'inline' | 'adaptive' | 'stacked';

export type SchemaFieldRowProps = Readonly<{
  testID?: string;
  title: string;
  /** What the setting does, or its current state, under the label. */
  hint?: string;
  /** A status mark before the hint (a missing or refused value). */
  hintLeading?: React.ReactNode;
  /** Facts after the hint that are not plain text (a deployment lock with its key). */
  hintAccessory?: React.ReactNode;
  titleAccessory?: React.ReactNode;
  layout: SchemaFieldRowLayout;
  /** The control; absent for a setting that can only be read. */
  control?: React.ReactNode;
  /** The value in words, for a setting that can only be read. */
  value?: string;
  accessibilityHint?: string;
  /** A whole-row press that changes the value (a switch row); the control stays its own target. */
  onPress?: () => void;
  disabled?: boolean;
  showDivider?: boolean;
}>;

export function SchemaFieldRow(props: SchemaFieldRowProps) {
  return (
    <Item
      testID={props.testID}
      title={props.title}
      titleAccessory={props.titleAccessory}
      subtitle={props.hint}
      subtitleLines={0}
      subtitleLeading={props.hintLeading}
      subtitleAccessory={props.hintAccessory}
      accessibilityHint={props.accessibilityHint}
      detail={props.value}
      mode={props.onPress ? undefined : 'info'}
      onPress={props.onPress}
      disabled={props.disabled}
      accessoryLayout={props.layout === 'inline' ? undefined : props.layout}
      rightElement={props.control}
      rightElementOutsidePressable={props.onPress ? true : undefined}
      showChevron={false}
      showDivider={props.showDivider}
    />
  );
}

/**
 * The slot of a typed value: a number is a compact box with its unit beside it; free text and
 * addresses take the width the row leaves.
 */
export function SchemaFieldValueSlot(
  props: Readonly<{
    kind: 'number' | 'text';
    /** The unit a number is typed in ("ms", "MB"). */
    unit?: string;
    children: React.ReactNode;
  }>,
) {
  return (
    <View style={props.kind === 'number' ? styles.numberSlot : styles.textSlot}>
      {props.children}
      {props.kind === 'number' && props.unit ? (
        <Text style={styles.unit}>{props.unit}</Text>
      ) : null}
    </View>
  );
}

/** A line under a stacked control: what is stored, or why the last change was refused. */
export function SchemaFieldStatusLine(
  props: Readonly<{
    testID?: string;
    tone?: 'secondary' | 'danger';
    children: string;
  }>,
) {
  const refused = props.tone === 'danger';
  return (
    <Text
      testID={props.testID}
      style={[styles.status, refused ? styles.statusDanger : null]}
      // A refusal arrives after an asynchronous commit and moves nothing else on screen.
      accessibilityRole={refused ? 'alert' : undefined}
      accessibilityLiveRegion={refused ? 'assertive' : undefined}
    >
      {props.children}
    </Text>
  );
}

/** The input a field's control fills inside its slot. */
export const SCHEMA_FIELD_INPUT_STYLE = {
  flexGrow: 1,
  flexShrink: 1,
  minWidth: 0,
} as const;

const styles = StyleSheet.create((theme) => ({
  numberSlot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: 128,
    justifyContent: 'flex-end',
  },
  textSlot: {
    flexDirection: 'row',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 200,
    maxWidth: 360,
  },
  unit: {
    ...Typography.default('regular'),
    ...ITEM_SUBTITLE_TEXT_METRICS.comfortable,
    color: theme.colors.text.secondary,
  },
  status: {
    ...Typography.default('regular'),
    ...ITEM_SUBTITLE_TEXT_METRICS.comfortable,
    color: theme.colors.text.secondary,
  },
  statusDanger: {
    color: theme.colors.state.danger.foreground,
  },
}));
