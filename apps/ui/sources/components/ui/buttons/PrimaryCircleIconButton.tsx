import * as React from 'react';
import { Platform, StyleProp, View, ViewStyle } from 'react-native';
import { HappierPressable, type HappierPressableProps, HappierSurfaceGradientLayer, happierMaterialGradient, useHappierMaterialColorResolver, resolveThemeSurfaceAddress, resolveHappierThemeSurfaceStyle, useHappierThemeSurfaceOverridesEnabled } from '@happier-dev/plugin-ui/presentation';
import { themeSurfaceDataSet, type SurfaceAddress } from '@happier-dev/plugin-sdk/ui';

import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { combinedWebGradientStyle, GradientSurface } from '@/components/ui/surfaces/GradientSurface';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
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
  glyph: {
    position: 'relative',
    zIndex: 1,
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
      themeSurface?: SurfaceAddress;
      accessibilityLabel: string;
      accessibilityHint?: string;
      accessibilityState?: { disabled?: boolean } & Record<string, unknown>;
      /** How far the hit area may reach past the circle on each side (half the gap to a neighbour). */
      hitReach?: HappierPressableProps['hitReach'];
      onPress?: () => void;
      preserveFocusOnPress?: HappierPressableProps['preserveFocusOnPress'];
      overlay?: HappierPressableProps['overlay'];
      onLongPress?: () => void;
      accessibilityActions?: HappierPressableProps['accessibilityActions'];
      onAccessibilityAction?: HappierPressableProps['onAccessibilityAction'];
      style?: StyleProp<ViewStyle>;
      /**
       * The glyph. As a function it receives the ink of the fill it sits on (the primary's ink when filled, the
       * page ink on the quiet slab, the muted ink while disabled), so a caller never paints the fill's ink on the slab.
       */
      children?: React.ReactNode | ((foreground: string) => React.ReactNode);
    }>,
  ) => {
    const { theme: currentTheme } = useUnistyles();
    const theme = props.appearance ?? currentTheme;
    const paintColor = useHappierMaterialColorResolver();
    const surfaceOverridesEnabled = useHappierThemeSurfaceOverridesEnabled();
    const styles = stylesheet;

    const computedDisabled = Boolean(props.disabled || props.loading || !props.onPress);
    const surfaceAddress = resolveThemeSurfaceAddress(props.themeSurface ?? { surface: 'button', part: 'root' }, {
      disabled: computedDisabled,
      selected: props.accessibilityState?.selected === true,
    });
    const surfaceStyle = surfaceOverridesEnabled ? themeSurfaceStyles.surface(surfaceAddress) : undefined;
    const overrideBackgroundColor = surfaceOverridesEnabled
      ? resolveHappierThemeSurfaceStyle(theme, surfaceAddress, Platform.OS)?.backgroundColor
      : undefined;
    const primary = theme.colors.button?.primary;
    // A primary that is working (after Send) keeps its own fill even though its press is locked: its spinner is
    // drawn in that fill's ink. On the disabled slab the fill's ink is dark on dark (owner 11-08).
    const filled = props.active || props.loading === true;
    // Its finish stays the pressable one while it works; otherwise a locked or unfilled circle sits flat.
    const finishDisabled = !filled || (computedDisabled && props.loading !== true);
    const backgroundColor = filled
      ? (primary?.background ?? theme.colors.surface.inset ?? theme.colors.surface.base)
      : (primary?.disabled ?? theme.colors.border.default);
    // One ink per fill: the primary's own ink on its fill; on the slab, the page ink, muted while it cannot act
    // (owner 11-08: the empty composer's arrow and the busy spinner read dark on dark with the fill's ink).
    const foreground = filled
      ? paintColor(primary?.tint ?? theme.colors.text.primary, theme.colors.text.primary, 'solidControl')
      : computedDisabled ? theme.colors.text.tertiary : theme.colors.text.primary;

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
          preserveFocusOnPress={props.preserveFocusOnPress}
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
              dataSet={{ surface: surfaceAddress.surface, part: surfaceAddress.part, state: surfaceAddress.state ?? 'default' }}
              style={[
                styles.paint,
                {
                  backgroundColor: paintColor(backgroundColor, undefined, 'solidControl'),
                  opacity: pressed ? motionTokens.press.opacity : 1,
                },
                Platform.OS === 'web' ? combinedWebGradientStyle(
                  filled ? happierMaterialGradient(primary?.gradient, color => paintColor(color, undefined, 'solidControl')) : undefined,
                  resolveThemeSurfaceFinish(theme, 'primaryButton', { pressed, focused, disabled: finishDisabled }),
                  !theme.dark,
                ) : null,
                surfaceStyle,
              ]}
            >
              {Platform.OS !== 'web' && overrideBackgroundColor === undefined ? filled && primary?.gradient ? (
                <GradientSurface
                  fallbackColor={paintColor(backgroundColor, undefined, 'solidControl')}
                  gradient={happierMaterialGradient(primary?.gradient, color => paintColor(color, undefined, 'solidControl'))}
                  overlay={resolveThemeSurfaceFinish(theme, 'primaryButton', { pressed, focused, disabled: finishDisabled })}
                  clipToPaddingBox={!theme.dark}
                  borderRadius={16}
                  style={StyleSheet.absoluteFillObject}
                />
              ) : <HappierSurfaceGradientLayer gradient={resolveThemeSurfaceFinish(theme, 'primaryButton', { pressed, focused, disabled: finishDisabled })} borderRadius={16} /> : null}
              {/* The glyph stacks above the fill's positioned gradient layer: a bare (unpositioned) glyph is painted under
                  it on web, so Send and Stop read as blank discs (QA-SHELL-1114 F9). */}
              <View
                dataSet={surfaceAddress.surface === 'button' ? themeSurfaceDataSet('button', 'icon', surfaceAddress.state ?? 'default') : undefined}
                style={[styles.glyph, surfaceOverridesEnabled && surfaceAddress.surface === 'button' ? themeSurfaceStyles.surface({ ...surfaceAddress, part: 'icon' }) : null]}
              >
                {props.loading ? (
                  <ActivitySpinner size="small" color={foreground} />
                ) : (
                  normalizeNodeForView(typeof props.children === 'function' ? props.children(foreground) : props.children)
                )}
              </View>
            </View>
          )}
        </HappierPressable>
      </View>
    );
  },
);
