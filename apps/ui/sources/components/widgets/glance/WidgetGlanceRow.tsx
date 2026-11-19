import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierWidgetGlanceRow,
  type HappierWidgetGlanceRowColors,
  type HappierWidgetGlanceRowTextProps,
} from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';

/** Core's text owner (the user's font scale) in the row title and row meta steps. */
function GlanceRowText(props: HappierWidgetGlanceRowTextProps) {
  return (
    <Text
      numberOfLines={props.lines ?? 1}
      style={[
        props.role === 'title' ? styles.title : styles.meta,
        props.mono ? styles.mono : null,
        { color: props.color },
        props.style as StyleProp<TextStyle>,
      ]}
    >
      {props.children}
    </Text>
  );
}

const hostColors = new WeakMap<Theme, HappierWidgetGlanceRowColors>();

function projectGlanceRowColors(theme: Theme): HappierWidgetGlanceRowColors {
  const existing = hostColors.get(theme);
  if (existing) return existing;
  const colors: HappierWidgetGlanceRowColors = Object.freeze({
    text: theme.colors.text.primary,
    secondaryText: theme.colors.text.secondary,
    mutedText: theme.colors.text.tertiary,
    attention: theme.colors.state.attention.textForeground,
    danger: theme.colors.status.error,

    pressed: theme.colors.surface.pressed,
    focus: theme.colors.border.focus,
  });
  hostColors.set(theme, colors);
  return colors;
}

/**
 * Happier core's binding of the shared widget glance row (`@happier-dev/plugin-ui/presentation`, the
 * same owner plugin widgets draw their rows with). Checkouts, About, Local changes and the Session
 * companion use it; this file supplies only core's text owner, glyphs, inks and spacing steps.
 */
export const WidgetGlanceRow = React.memo(function WidgetGlanceRow(
  props: Readonly<{
    testID?: string;
    /** The row's mark: a glyph, or an element (a brand mark, a spinner). It stands alone, never on a tile. */
    mark?: IconName | React.ReactElement | null;
    title: string;
    variant?: 'row' | 'fact' | 'state';
    tag?: string | null;
    tagSentence?: boolean;
    fact?: string | null;
    factTone?: 'quiet' | 'attention' | 'danger';
    mono?: boolean;
    trailing?: React.ReactNode;
    dimmed?: boolean;
    onPress?: (() => void) | null;
    accessibilityLabel?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { mark, ...rest } = props;
  return (
    <HappierWidgetGlanceRow
      {...rest}
      Text={GlanceRowText}
      colors={projectGlanceRowColors(theme)}
      space={theme.space}
      {...(mark === undefined
        ? {}
        : {
            mark:
              typeof mark === 'string' ? (
                <Icon
                  name={mark}
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
              ) : (
                mark
              ),
          })}
    />
  );
});

const styles = StyleSheet.create(() => ({
  title: {
    ...Typography.variant('label', 'semiBold'),
  },
  meta: {
    ...Typography.variant('meta'),
  },
  mono: {
    ...Typography.mono(),
  },
}));
