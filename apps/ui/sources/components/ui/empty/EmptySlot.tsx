import {
  HappierEmptySlot,
  HappierPressable,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Happier core's binding of the ONE empty slot (`HappierEmptySlot`, plugin-ui): the dashed outline
 * that means "something can go here". A hole in a widget group, the cell beside a previewed card, an
 * area's "Add widget" line and Home's "new row" drop target are all this component. It supplies only
 * the app's text owner, icon pack and theme inks.
 */
export const EmptySlot = React.memo(function EmptySlot(
  props: Readonly<{
    /** What belongs here. Leave it out for a slot that only holds a place (the Add preview's empty cell). */
    label?: string;
    /** `row`: the label at row-title size, for a slot that is the area's one "Add widget" line. */
    labelRole?: 'meta' | 'row';
    icon?: IconName;
    /** One inline action finishing the sentence ("add one"). */
    action?: Readonly<{ label: string; onPress: () => void; testID?: string }>;
    /** The whole slot is the control. */
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
    expanded?: boolean;
    minHeight?: number;
    testID?: string;
    style?: React.ComponentProps<typeof HappierEmptySlot>['style'];
  }>,
) {
  const { theme } = useUnistyles();
  const colors = React.useMemo(
    () => ({
      border: theme.colors.border.default,
      activeFill: theme.colors.surface.selected,
      focusRing: theme.colors.border.focus,
    }),
    [theme],
  );
  const row = props.labelRole === 'row';
  return (
    <HappierEmptySlot
      testID={props.testID}
      colors={colors}
      glyph={
        props.icon ? (
          <Icon
            name={props.icon}
            size={row ? ICON_SIZE.sm : ICON_SIZE.xs}
            color={
              row ? theme.colors.text.secondary : theme.colors.text.tertiary
            }
          />
        ) : undefined
      }
      label={
        props.label ? (
          <Text style={row ? styles.rowLabel : styles.label} numberOfLines={2}>
            {props.label}
          </Text>
        ) : null
      }
      action={
        props.action ? (
          <HappierPressable
            testID={props.action.testID}
            accessibilityRole="button"
            hasPopup="dialog"
            onPress={props.action.onPress}
          >
            <Text style={styles.action}>{props.action.label}</Text>
          </HappierPressable>
        ) : undefined
      }
      {...(props.onPress
        ? {
            onPress: props.onPress,
            hasPopup: 'dialog' as const,
            ...(props.disabled === undefined
              ? {}
              : { disabled: props.disabled }),
            ...(props.expanded === undefined
              ? {}
              : { expanded: props.expanded }),
          }
        : {})}
      {...(props.accessibilityLabel
        ? { accessibilityLabel: props.accessibilityLabel }
        : {})}
      {...(props.minHeight === undefined ? {} : { minHeight: props.minHeight })}
      style={props.style}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  label: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
  rowLabel: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.secondary,
  },
  action: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.link,
  },
}));
