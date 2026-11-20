import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { glassContentFill } from '@/components/ui/glass/glassSurfacePaint';

import { Text } from '@/components/ui/text/Text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { workStatusUnreadInk } from '@/components/work/status/workStatusTreatment';

export function TranscriptSeparatorRow(props: Readonly<{
  testID?: string;
  /** Optional: the "New" divider is a word between two hairlines, with no mark. */
  iconName?: IconName;
  title: string;
  /**
   * A caller-composed title run, rendered in the title's place.
   *
   * The default title is one string in one `Text`, which is right for every row
   * whose label is only words. A label that has to interleave non-text runs —
   * the Agent-transition divider sets each Agent's logo before its name — cannot
   * be expressed that way, and duplicating this row to host one is worse than
   * letting the caller own that slot. `title` stays the accessible name whatever
   * is drawn, so a screen reader reads the sentence either way.
   */
  titleContent?: React.ReactNode;
  titleTestID?: string;
  subtitle?: string | null;
  rightAccessory?: React.ReactNode;
  onPress?: () => void;
  chipTestID?: string;
  accessibilityLabel?: string;
  padding?: 'default' | 'none';
  chipChrome?: 'default' | 'minimal';
  /**
   * `unread`: the read cursor's divider. Colour means state, so the word and its hairlines take the unread
   * mark's ink (the Session list's unread dot) instead of the neutral separator ink.
   */
  tone?: 'default' | 'unread';
  containerStyle?: ViewStyle | null;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const padding = props.padding === 'none' ? 'none' : 'default';
  const chipChrome = props.chipChrome === 'minimal' ? 'minimal' : 'default';
  const unread = props.tone === 'unread';
  // The rule spans the reply column every message row uses, so its ends meet the text edges.
  const layoutMaxWidth = useLayoutMaxWidth();
  const rowWidthStyle = { maxWidth: padding === 'none' ? layoutMaxWidth : layoutMaxWidth - 2 * SEPARATOR_INSET };
  const lineStyle = [styles.line, unread ? styles.lineUnread : null, { backgroundColor: unread ? workStatusUnreadInk(theme.colors) : theme.colors.border.default }];
  const chipContent = (
    <>
      {props.iconName ? <Icon name={props.iconName} size={14} color={theme.colors.text.secondary} /> : null}
      <View style={styles.textStack}>
        {props.titleContent ?? (
          <Text testID={props.titleTestID} style={[styles.title, { color: theme.colors.text.primary }]} numberOfLines={1}>
            {props.title}
          </Text>
        )}
        {props.subtitle ? (
          <Text style={[styles.subtitle, { color: theme.colors.text.secondary }]} numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.rightAccessory ? <View style={styles.rightAccessory}>{props.rightAccessory}</View> : null}
    </>
  );

  return (
    <View
      testID={props.testID}
      style={[
        styles.container,
        padding === 'none' ? styles.containerNoPadding : null,
        props.containerStyle ?? null,
      ]}
    >
      <View style={[styles.row, rowWidthStyle]}>
        <View style={lineStyle} />
        {props.onPress ? (
          <HappierPressable
            testID={props.chipTestID}
            onPress={props.onPress}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.title}
            // The chip is ~30pt tall at its own padding, below a comfortable
            // touch target, and it is the whole control when it is pressable.
            // The minimal chrome has no padding of its own and needs more.
            style={({ pressed }) => [
              styles.chip,
              chipChrome === 'minimal' ? styles.chipMinimal : null,
              { backgroundColor: glassContentFill(theme.colors.surface.base, theme.colors, { nested: true }), borderColor: theme.colors.border.default, opacity: pressed ? motionTokens.press.opacitySubtle : 1 },
            ]}
          >
            {chipContent}
          </HappierPressable>
        ) : (
          <View
            testID={props.chipTestID}
            accessible
            accessibilityLabel={props.accessibilityLabel ?? props.title}
            accessibilityRole="text"
            style={[
              styles.chip,
              chipChrome === 'minimal' ? styles.chipMinimal : null,
              { backgroundColor: glassContentFill(theme.colors.surface.base, theme.colors, { nested: true }), borderColor: theme.colors.border.default },
            ]}
          >
            {chipContent}
          </View>
        )}
        <View style={lineStyle} />
      </View>
    </View>
  );
}

/**
 * The separator title's type ramp, exported so a caller that composes its own
 * title run sets it in the same face, size and weight as every other separator
 * rather than restating the numbers.
 */
export const TRANSCRIPT_SEPARATOR_TITLE_TEXT_STYLE = {
  ...Typography.variant('meta', 'semiBold'),
} as const;

/** The row's own side inset, the same as a message's column inset. */
const SEPARATOR_INSET = 16;

const styles = StyleSheet.create((_theme) => ({
  container: {
    paddingHorizontal: SEPARATOR_INSET,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  containerNoPadding: {
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  row: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  line: {
    flex: 1,
    height: 1,
    opacity: 0.8,
  },
  // The unread ink is full-strength primary ink; at hairline weight it reads as a rule beside its word.
  lineUnread: {
    opacity: 0.55,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipMinimal: {
    borderWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  textStack: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'column',
    gap: 2,
  },
  title: {
    ...TRANSCRIPT_SEPARATOR_TITLE_TEXT_STYLE,
  },
  subtitle: {
    ...Typography.variant('meta', 'medium'),
  },
  rightAccessory: {
    marginLeft: 6,
  },
}));
