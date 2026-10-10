import { Fragment, type ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiPalette, useOptionalHappierUiTheme } from '../../environment/context.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';

export type HappierBreadcrumbItem = Readonly<{
  key: string;
  label: string;
  testID?: string;
  /** Omitted on the current location. */
  onPress?: () => void;
}>;

export type HappierBreadcrumbProps = Readonly<{
  items: readonly HappierBreadcrumbItem[];
  testID?: string;
  accessibilityLabel?: string;
  accessibilityRole?: 'header' | 'toolbar';
  leading?: ReactNode;
  separator?: ReactNode;
  style?: HappierStyleProp;
  linkStyle?: HappierStyleProp;
  colors?: Readonly<{ focus: string; hover: string }>;
  /** The core host keeps its font and context-specific label treatment. */
  renderLabel?: (item: HappierBreadcrumbItem) => ReactNode;
}>;

/** Ordered location ancestors with one shared link, hover and keyboard-focus anatomy. */
export function HappierBreadcrumb(props: HappierBreadcrumbProps) {
  const palette = useOptionalHappierUiPalette();
  const theme = useOptionalHappierUiTheme();
  const colors = props.colors ?? (theme ? {
    focus: theme.colors.focus,
    hover: palette?.navigationHover ?? theme.colors.surface,
  } : undefined);
  if (props.items.length === 0) return null;
  const label = (item: HappierBreadcrumbItem) => props.renderLabel?.(item) ?? (
    <HappierText numberOfLines={1} testID={item.onPress ? undefined : item.testID}>{item.label}</HappierText>
  );
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole={props.accessibilityRole}
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0, maxWidth: '100%' }, props.style]}
    >
      {props.leading}
      {props.items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 ? props.separator ?? <HappierText>/</HappierText> : null}
          {item.onPress ? (
            <HappierPressable
              testID={item.testID}
              accessibilityRole="link"
              accessibilityLabel={item.label}
              onPress={item.onPress}
              hitSlop={6}
              style={({ hovered, pressed, focused }) => [
                { flexShrink: 1, minWidth: 0 },
                props.linkStyle,
                colors ? happierFocusRingStyle({ visible: focused, color: colors.focus }) : null,
                (hovered || pressed) && colors ? { backgroundColor: colors.hover } : null,
              ]}
            >
              {label(item)}
            </HappierPressable>
          ) : label(item)}
        </Fragment>
      ))}
    </View>
  );
}
