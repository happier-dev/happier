import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { buildGlassCastShadowStyle, type ShadowLevel } from '@/shadowElevation';

import { GlassSurface } from './GlassSurface';
import type { GlassSurfaceGroup } from './glassMaterial';

/** Full-capsule radius — the default iOS-26 floating-chrome shape. */
const CAPSULE_RADIUS = 999;
/** Cast-shadow elevation tuned for the large floating bars. */
const DEFAULT_SHADOW_LEVEL: ShadowLevel = 4;
/** The surface fills a caller-sized frame. */
const FILL_FRAME: ViewStyle = { flex: 1 };

export type GlassPanelProps = Readonly<{
    children: React.ReactNode;
    /** Corner radius. Defaults to a full capsule. */
    radius?: number;
    /**
     * Soften the cast shadow — for panels sitting on an opaque band (no content
     * showing through), where the full shadow reads too strong.
     */
    softShadow?: boolean;
    /**
     * Cast-shadow elevation step. Defaults to the large-bar level; smaller
     * controls (e.g. the jump-to-bottom button) should pass a lower level so the
     * drop shadow stays proportionate to their size.
     */
    shadowLevel?: ShadowLevel;
    /**
     * Apply the top inner-shadow (inset depth). Defaults to on. Disable on short
     * controls where the fixed inset blur covers too much of the surface and reads
     * heavier than on a tall bar.
     */
    innerShadow?: boolean;
    /** Fill color for the solid tier. Defaults to `surface.base` (matches the tab bar). */
    surfaceColor?: string;
    glassEffectStyle?: 'regular' | 'clear';
    /** Constrain the panel width (e.g. the tab bar's content max-width). */
    maxWidth?: number;
    /** Inner layout style for the surface (padding, alignment). Do not pass an opaque background. */
    style?: StyleProp<ViewStyle>;
    /**
     * How the panel sizes as an item of its parent (e.g. `alignSelf` + `aspectRatio` for a capsule
     * the parent row stretches). It applies to the outermost box, which also casts the shadow, and
     * the glass surface fills it, so shadow and glass always share one size. Sizing passed through
     * `style` instead would only reach the inner surface.
     */
    frameStyle?: StyleProp<ViewStyle>;
    testID?: string;
    surfaceGroup?: GlassSurfaceGroup;
}>;

/**
 * Reusable iOS-26 "Liquid Glass" floating surface: a tiered glass/blur/solid
 * material (`GlassSurface`) wrapped with the canonical glass treatment — a bright
 * rim, a subtle top inner-shadow for inset depth, and a soft cast shadow on an
 * un-clipped wrapper (so it renders around the clipped material).
 *
 * Shared by the floating tab bars, the jump-to-bottom button, and the optional
 * glass composer, so every floating glass element reads consistently. Callers
 * pass only their content plus per-use layout (padding via `style`, `radius`,
 * `maxWidth`); the glass treatment and material live here.
 */
export const GlassPanel = React.memo(function GlassPanel(props: GlassPanelProps) {
    const { theme } = useUnistyles();
    const radius = props.radius ?? CAPSULE_RADIUS;
    const shadowLevel = props.shadowLevel ?? DEFAULT_SHADOW_LEVEL;

    return (
        <View
            style={[
                { borderRadius: radius },
                props.maxWidth !== undefined ? { maxWidth: props.maxWidth } : null,
                // Cross-platform soft cast shadow (boxShadow on Android/web, native
                // shadow* on iOS) — never Android `elevation`, which reads hard.
                buildGlassCastShadowStyle(theme.colors.shadowLevels[shadowLevel], theme.colors.glass.castShadow, props.softShadow === true),
                props.frameStyle,
            ]}
        >
            <GlassSurface
                testID={props.testID}
                surfaceGroup={props.surfaceGroup}
                glassEffectStyle={props.glassEffectStyle}
                solidColor={props.surfaceColor}
                style={[
                    {
                        borderRadius: radius,
                        overflow: 'hidden',
                        // Reddit-style glass rim + (optional) subtle top inner-shadow for inset depth.
                        borderWidth: 1.5,
                        borderColor: theme.colors.glass.border,
                        boxShadow: props.innerShadow === false ? undefined : theme.colors.glass.innerShadow,
                    },
                    props.frameStyle ? FILL_FRAME : null,
                    props.style,
                ]}
            >
                {props.children}
            </GlassSurface>
        </View>
    );
});
