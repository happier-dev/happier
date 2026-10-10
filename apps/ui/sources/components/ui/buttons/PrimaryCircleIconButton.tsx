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

const stylesheet = StyleSheet.create((theme) => ({
  root: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  inner: {
    width: '100%',
    height: '100%',
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
      hitSlop?: HappierPressableProps['hitSlop'];
      onPress?: () => void;
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
    const tintColor = paintColor(primary?.tint ?? theme.colors.text.primary, theme.colors.text.primary);

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
          hitSlop={props.hitSlop}
          disabled={computedDisabled}
          onPress={() => { props.onPress?.(); }}
          style={({ pressed, focused }) => [
            styles.inner,
            {
              borderRadius: 16,
              backgroundColor: paintColor(backgroundColor),
              opacity: pressed ? motionTokens.press.opacity : 1,
              overflow: 'hidden',
              ...(Platform.OS === 'web' && !primary?.gradient ? happierSurfaceGradientWebStyle(resolveThemeSurfaceFinish(theme, 'primaryButton', { pressed, focused, disabled: computedDisabled || !props.active }), !theme.dark) : null),
            },
          ]}
        >
          {({ pressed, focused }) => <>
          {props.active && primary?.gradient ? (
            <GradientSurface
              fallbackColor={paintColor(backgroundColor)}
              gradient={props.active ? happierMaterialGradient(primary?.gradient, paintColor) : undefined}
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
          </>}
        </HappierPressable>
      </View>
    );
  },
);
