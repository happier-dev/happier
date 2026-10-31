import * as React from 'react';
import { Platform, StyleProp, View, ViewStyle } from 'react-native';
import { HappierPressable, type HappierPressableProps, HappierSurfaceGradientLayer, happierSurfaceGradientWebStyle, happierMaterialGradient, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { GradientSurface } from '@/components/ui/surfaces/GradientSurface';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import type { Theme } from '@/theme';
import { resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';

/** The disc's diameter. The pressable takes it directly: with an `overlay` it sits in an unsized anchor, where a percentage collapses to the icon. */
const DISC_SIZE = 32;

const stylesheet = StyleSheet.create((theme) => ({
  root: {
    width: DISC_SIZE,
    height: DISC_SIZE,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  inner: {
    width: DISC_SIZE,
    height: DISC_SIZE,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paint: {
    width: '100%',
    height: '100%',
    borderRadius: 16,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
}));

export const PrimaryCircleIconButton = React.memo(
  (
    props: Readonly<{
      active: boolean;
      /** Static previews supply the same resolved theme as their surrounding panel. */
      appearance?: Theme;
      disabled?: boolean;
      loading?: boolean;
      testID?: string;
      accessibilityLabel: string;
      accessibilityHint?: string;
      accessibilityState?: { disabled?: boolean } & Record<string, unknown>;
      /** How far the hit area may reach past the circle on each side (half the gap to a neighbour). */
      hitReach?: HappierPressableProps['hitReach'];
      onPress?: () => void;
      overlay?: HappierPressableProps['overlay'];
      onLongPress?: () => void;
      accessibilityActions?: HappierPressableProps['accessibilityActions'];
      onAccessibilityAction?: HappierPressableProps['onAccessibilityAction'];
      style?: StyleProp<ViewStyle>;
      children?: React.ReactNode;
    }>,
  ) => {
    const { theme: currentTheme } = useUnistyles();
    const theme = props.appearance ?? currentTheme;
    const paintColor = useHappierMaterialColorResolver();
    const styles = stylesheet;

    const computedDisabled = Boolean(props.disabled || props.loading || !props.onPress);
    const primary = theme.colors.button?.primary;
    const backgroundColor = props.active
      ? (primary?.background ?? theme.colors.surface.inset ?? theme.colors.surface.base)
      : (primary?.disabled ?? theme.colors.border.default);
    const tintColor = paintColor(primary?.tint ?? theme.colors.text.primary, theme.colors.text.primary, 'solidControl');

    return (
      <View style={[styles.root, props.style]}>
        <HappierPressable
          testID={props.testID}
          accessibilityRole="button"
          accessibilityLabel={props.accessibilityLabel}
          accessibilityHint={props.accessibilityHint}
          busy={props.loading || props.accessibilityState?.busy === true}
          selected={props.accessibilityState?.selected === true}
          expanded={typeof props.accessibilityState?.expanded === 'boolean' ? props.accessibilityState.expanded : undefined}
          checked={typeof props.accessibilityState?.checked === 'boolean' ? props.accessibilityState.checked : undefined}
          hitReach={props.hitReach}
          disabled={computedDisabled}
          onPress={() => { props.onPress?.(); }}
          overlay={props.overlay}
          onLongPress={props.onLongPress}
          accessibilityActions={props.accessibilityActions}
          onAccessibilityAction={props.onAccessibilityAction}
          // The pressable keeps the circle's box unclipped, so its invisible hit area (a frame that
          // reaches past the circle) is not cut off; the paint, clip and finish live on the inner View.
          style={styles.inner}
        >
          {({ pressed, focused }) => (
            <View
              style={[
                styles.paint,
                {
                  backgroundColor: paintColor(backgroundColor, undefined, 'solidControl'),
                  opacity: pressed ? motionTokens.press.opacity : 1,
                  ...(Platform.OS === 'web' && !primary?.gradient ? happierSurfaceGradientWebStyle(resolveThemeSurfaceFinish(theme, 'primaryButton', { pressed, focused, disabled: computedDisabled || !props.active }), !theme.dark) : null),
                },
              ]}
            >
              {props.active && primary?.gradient ? (
                <GradientSurface
                  fallbackColor={paintColor(backgroundColor, undefined, 'solidControl')}
                  gradient={props.active ? happierMaterialGradient(primary?.gradient, color => paintColor(color, undefined, 'solidControl')) : undefined}
                  overlay={resolveThemeSurfaceFinish(theme, 'primaryButton', { pressed, focused, disabled: computedDisabled || !props.active })}
                  clipToPaddingBox={!theme.dark}
                  borderRadius={16}
                  style={StyleSheet.absoluteFillObject}
                />
              ) : <HappierSurfaceGradientLayer gradient={resolveThemeSurfaceFinish(theme, 'primaryButton', { pressed, focused, disabled: computedDisabled || !props.active })} borderRadius={16} />}
              {props.loading ? (
                <ActivitySpinner size="small" color={tintColor} />
              ) : (
                normalizeNodeForView(props.children)
              )}
            </View>
          )}
        </HappierPressable>
      </View>
    );
  },
);
