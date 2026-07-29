import * as React from 'react';
import { Platform, StyleSheet as RNStyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { LinearGradient } from 'expo-linear-gradient';

import { shadowLevelStyle } from '@/shadowElevation';
import { resolveThemeSurfaceChromeStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';

import { useMotionPreferences } from './motion/useMotionPreferences';

/**
 * The instrument-kit CARD surface: gauges, chips, dashboard bands, and the scrub
 * lens sit on it. Two roles (D-R4-1):
 *
 *  - `tile` (default): a grouped-content surface — the usage banner, the usage
 *    dashboard, status cards. It adopts the app's ONE canonical grouped-surface
 *    language (`ItemGroup` via `resolveThemeSurfaceChromeStyle`): flat +
 *    hairline, the canonical radius, and NO bespoke drop shadow. In light theme
 *    that is a plain surface on the canvas (the theme's `border.surface` /
 *    `effect.surfaceHighlight` are transparent → no border, no shadow); in dark
 *    theme it is a hairline + level-1 lift. There is no competing tile language.
 *  - `popover`: an elevated FLOATING surface (the scrub lens). Popovers
 *    legitimately cast a soft shadow, so this keeps a level-2 cast shadow, a
 *    40%-hairline, and (at full effects) a whisper of specular top highlight.
 *
 * Dumb + memoized; owns no state and reads only the motion-preference hook.
 */

export type InstrumentCardVariant = 'tile' | 'popover';

export type InstrumentCardProps = Readonly<{
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    /** Surface role — see the component doc. Defaults to `tile`. */
    variant?: InstrumentCardVariant;
    /** Corner radius override; inner content should use `borderRadius - padding` (concentric). */
    borderRadius?: number;
    testID?: string;
}>;

/** Canonical grouped-surface radius — matches `ItemGroup` exactly. */
const TILE_RADIUS = Platform.select({ ios: 10, default: 16 }) ?? 16;
const POPOVER_RADIUS = 12;

export const InstrumentCard = React.memo(function InstrumentCard(props: InstrumentCardProps) {
    const { theme } = useUnistyles();
    const motion = useMotionPreferences();
    const variant = props.variant ?? 'tile';
    const isPopover = variant === 'popover';
    const borderRadius = props.borderRadius ?? (isPopover ? POPOVER_RADIUS : TILE_RADIUS);

    const surfaceStyle = React.useMemo<ViewStyle>(() => {
        if (isPopover) {
            return {
                backgroundColor: theme.colors.surface.base,
                borderRadius,
                borderWidth: RNStyleSheet.hairlineWidth,
                // Hairline at 40% opacity — depth comes from the shadow, not the line.
                borderColor: applyOpacity(theme.colors.border.default, 0.4),
                ...shadowLevelStyle(theme.colors.shadowLevels[2]),
            };
        }
        // TILE: the EXACT canonical grouped-surface chrome shared with `ItemGroup`.
        return {
            backgroundColor: theme.colors.surface.base,
            borderRadius,
            ...resolveThemeSurfaceChromeStyle({
                borderColor: theme.colors.border.surface,
                highlightColor: theme.colors.effect.surfaceHighlight,
                shadowStyle: shadowLevelStyle(theme.colors.shadowLevels[1]),
            }),
        };
    }, [
        borderRadius,
        isPopover,
        theme.colors.border.default,
        theme.colors.border.surface,
        theme.colors.effect.surfaceHighlight,
        theme.colors.shadowLevels,
        theme.colors.surface.base,
    ]);

    // Only the floating popover lens keeps the specular top highlight — a tile
    // must read identically to `ItemGroup` (which has none).
    const showSpecular = isPopover && motion.effectsEnabled;

    return (
        <View testID={props.testID} style={[surfaceStyle, styles.root, props.style]}>
            {showSpecular ? (
                <LinearGradient
                    pointerEvents="none"
                    colors={
                        theme.dark
                            ? ['rgba(255,255,255,0.05)', 'rgba(255,255,255,0)']
                            : ['rgba(255,255,255,0.65)', 'rgba(255,255,255,0)']
                    }
                    start={{ x: 0.2, y: 0 }}
                    end={{ x: 0.5, y: 0.6 }}
                    style={{ ...SPECULAR_FILL, borderRadius }}
                />
            ) : null}
            {props.children}
        </View>
    );
});

/** Apply an opacity to a #RRGGBB hex; passes non-hex colors through unchanged. */
function applyOpacity(color: string, opacity: number): string {
    const hex = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
    if (!hex) return color;
    const n = parseInt(hex[1]!, 16);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Plain (non-unistyles) absolute fill for the specular gradient layer: passing a
 * unistyles style object to `expo-linear-gradient` silently applies NOTHING on
 * web (the gradient div renders position:relative/height:0), so the highlight
 * never painted. A plain object survives the third-party component's style path
 * on every platform. Same fix as `recapStory/RecapStorySurface.GRADIENT_FILL`.
 */
const SPECULAR_FILL = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '55%',
} as const;

const styles = StyleSheet.create(() => ({
    root: {
        position: 'relative',
        overflow: 'hidden',
    },
}));
