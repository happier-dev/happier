import { useRef, type ReactNode } from 'react';
import {
  ScrollView,
  View,
  type ViewStyle,
} from 'react-native';

import type {
  HappierAlignment,
  HappierFocusable,
  HappierJustification,
  HappierKeyboardShouldPersistTaps,
  HappierLayoutChangeEvent,
  HappierScrollEvent,
  HappierStyleProp,
} from '../portableTypes.js';
import { PluginUiPopoverScrollSourceProvider } from '../../presentationHost/context.js';

export type HappierLayoutGap = 'none' | 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';

export type HappierLayoutSpacing = Readonly<Record<Exclude<HappierLayoutGap, 'none'>, number>>;

/** One semantic gap vocabulary for public and host declarative adapters. */
export function resolveHappierLayoutGap(
  gap: HappierLayoutGap | undefined,
  spacing: HappierLayoutSpacing,
): number {
  const resolvedGap = gap ?? 'medium';
  return resolvedGap === 'none' ? 0 : spacing[resolvedGap];
}

export type HappierStackProps = Readonly<{
  children?: ReactNode;
  /** Private semantic focus binding supplied by the public layout adapter. */
  controlRef?: (instance: HappierFocusable | null) => void;
  direction?: 'vertical' | 'horizontal';
  gap?: number;
  wrap?: boolean;
  align?: HappierAlignment;
  justify?: HappierJustification;
  /** Reports this box's resolved size and position after the platform lays it out. */
  onLayout?: (event: HappierLayoutChangeEvent) => void;
  testID?: string;
  style?: HappierStyleProp;
}>;

export type HappierScreenProps = Readonly<{
  children?: ReactNode;
  /** Private semantic focus binding supplied by the public layout adapter. */
  controlRef?: (instance: HappierFocusable | null) => void;
  /** Reports this box's resolved size and position after the platform lays it out. */
  onLayout?: (event: HappierLayoutChangeEvent) => void;
  testID?: string;
  style?: HappierStyleProp;
  safeAreaInsets?: Readonly<{ top: number; right: number; bottom: number; left: number }>;
}>;

export type HappierScrollAreaProps = Readonly<{
  children?: ReactNode;
  horizontal?: boolean;
  keyboardShouldPersistTaps?: HappierKeyboardShouldPersistTaps;
  onScroll?: (event: HappierScrollEvent) => void;
  scrollEventThrottle?: number;
  /** Reports this box's resolved size and position after the platform lays it out. */
  onLayout?: (event: HappierLayoutChangeEvent) => void;
  accessibilityLabel?: string;
  testID?: string;
  style?: HappierStyleProp;
  contentContainerStyle?: HappierStyleProp;
  safeAreaInsets?: Readonly<{ top: number; right: number; bottom: number; left: number }>;
}>;

const screenBaseStyle: ViewStyle = { flex: 1, minWidth: 0 };
const stackBaseStyle: ViewStyle = { minWidth: 0 };

export function HappierScreen({ children, controlRef, onLayout, testID, style, safeAreaInsets }: HappierScreenProps) {
  const insetStyle: ViewStyle | undefined = safeAreaInsets
    ? {
        paddingTop: safeAreaInsets.top,
        paddingRight: safeAreaInsets.right,
        paddingBottom: safeAreaInsets.bottom,
        paddingLeft: safeAreaInsets.left,
      }
    : undefined;
  return (
    <View
      ref={controlRef}
      tabIndex={controlRef ? -1 : undefined}
      onLayout={onLayout}
      testID={testID}
      style={[screenBaseStyle, insetStyle, style]}
    >
      {children}
    </View>
  );
}

export function HappierStack({
  children,
  direction = 'vertical',
  gap = 0,
  wrap = false,
  align,
  justify,
  controlRef,
  onLayout,
  testID,
  style,
}: HappierStackProps) {
  return (
    <View
      ref={controlRef}
      tabIndex={controlRef ? -1 : undefined}
      onLayout={onLayout}
      testID={testID}
      style={[
        stackBaseStyle,
        {
          flexDirection: direction === 'horizontal' ? 'row' : 'column',
          gap,
          flexWrap: wrap ? 'wrap' : 'nowrap',
          alignItems: align,
          justifyContent: justify,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function HappierScrollArea({
  children,
  accessibilityLabel,
  testID,
  style,
  contentContainerStyle,
  safeAreaInsets,
  keyboardShouldPersistTaps = 'handled',
  ...scrollProps
}: HappierScrollAreaProps) {
  const scrollSourceRef = useRef<ScrollView | null>(null);
  const insetStyle: ViewStyle | undefined = safeAreaInsets
    ? {
        paddingTop: safeAreaInsets.top,
        paddingRight: safeAreaInsets.right,
        paddingBottom: safeAreaInsets.bottom,
        paddingLeft: safeAreaInsets.left,
      }
    : undefined;
  return (
    <PluginUiPopoverScrollSourceProvider scrollSourceRef={scrollSourceRef}>
      <ScrollView
        ref={scrollSourceRef}
        {...scrollProps}
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        style={style}
        contentContainerStyle={[insetStyle, contentContainerStyle]}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      >
        {children}
      </ScrollView>
    </PluginUiPopoverScrollSourceProvider>
  );
}
