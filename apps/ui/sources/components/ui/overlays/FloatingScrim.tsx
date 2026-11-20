import * as React from 'react';
import type { CSSProperties } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { getBlurViewComponent } from '@/components/ui/glass/blurMaterial';
import { useGlassBlurSetting } from '@/components/ui/glass/useGlassBlurSetting';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import { parseThemeColor } from '@/theme/parseThemeColor';

import { createBackdropWebStyle } from './createBackdropLayerStyle';

/** 0.2's popover recipe (ItemRowActions): a light frost of the page behind, under a very light dim. */
const FLOATING_SCRIM_BLUR_INTENSITY = 12;
const FLOATING_SCRIM_WEB_BLUR_PX = 3;
/** The dim is the theme's scrim ink at 0.2's popover dim (8%), not the scrim's own heavy alpha. */
const FLOATING_SCRIM_DIM_ALPHA = 0.08;

/** The very light dim over the page, in the theme's scrim ink. */
export function floatingScrimDimColor(scrim: string): string {
  return (
    parseThemeColor(scrim)?.alpha(FLOATING_SCRIM_DIM_ALPHA).rgb().string() ??
    scrim
  );
}

/**
 * The scrim as a web style, for a layer that is itself the scrim (a dialog's overlay, which also takes its
 * clicks). `visible: false` clears it, so the scrim fades on its owner's transition.
 */
export function createFloatingScrimWebStyle(
  input: Readonly<{ scrim: string; frost: boolean; visible?: boolean }>,
): CSSProperties {
  const visible = input.visible !== false;
  const dim = visible ? floatingScrimDimColor(input.scrim) : 'transparent';
  return createBackdropWebStyle({
    backgroundColor: dim,
    blurPx: visible ? FLOATING_SCRIM_WEB_BLUR_PX : 0,
    enableBlur: input.frost && visible,
    fallbackBackgroundColorWhenBlurDisabled: dim,
  });
}

/** Whether the scrim frosts: Blur Off and Reduce Transparency keep the light dim alone. */
export function useFloatingScrimFrost(): boolean {
  const reduceTransparency = useReduceTransparency();
  const { blurEnabled } = useGlassBlurSetting();
  return blurEnabled && !reduceTransparency;
}

/**
 * The one scrim behind popovers and sheets (owner, 2026-11-10: follow 0.2): a light frost of the page under a very
 * light dim, never a flat dark overlay. `dim` asks for the dim alone; Reduce Transparency, Blur Off and a device
 * without a native blur also get the dim alone. Callers own placement, motion and touches.
 */
const WEB_NO_POINTER_EVENTS = { pointerEvents: 'none' } as const;

export const FloatingScrim = React.memo(function FloatingScrim(
  props: Readonly<{
    style?: StyleProp<ViewStyle>;
    mode?: 'frost' | 'dim';
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const frost = useFloatingScrimFrost() && props.mode !== 'dim';
  if (Platform.OS === 'web') {
    const paint = createFloatingScrimWebStyle({
      scrim: theme.colors.overlay.scrim,
      frost,
    }) as unknown as ViewStyle;
    return (
      <View
        testID={props.testID}
        // React Native Web reads pointer events from the style (its prop is deprecated there).
        style={[props.style, paint, WEB_NO_POINTER_EVENTS]}
      />
    );
  }
  const BlurView = frost ? getBlurViewComponent() : null;
  return (
    <View testID={props.testID} pointerEvents="none" style={props.style}>
      {BlurView ? (
        <BlurView
          intensity={FLOATING_SCRIM_BLUR_INTENSITY}
          tint="default"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: floatingScrimDimColor(theme.colors.overlay.scrim),
          },
        ]}
      />
    </View>
  );
});
