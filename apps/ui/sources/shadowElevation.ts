import { Platform } from 'react-native';

/** Canonical UI shadow steps (1 = lowest). Web uses CSS `box-shadow`; native uses a single-shadow approximation. */
export const SHADOW_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type ShadowLevel = (typeof SHADOW_LEVELS)[number];

export type ShadowElevationToken = Readonly<{
    boxShadow: string;
    shadowColor: string;
    shadowOffset: Readonly<{ width: number; height: number }>;
    shadowOpacity: number;
    shadowRadius: number;
    elevation: number;
}>;

export type ShadowLevels = Record<ShadowLevel, ShadowElevationToken>;

export type ShadowLevelStyle =
    | Readonly<{
            boxShadow: string;
        }>
    | Readonly<{
            shadowColor: string;
            shadowOffset: Readonly<{ width: number; height: number }>;
            shadowOpacity: number;
            shadowRadius: number;
            elevation: number;
        }>;

function token(
    boxShadow: string,
    shadowColor: string,
    shadowOffset: Readonly<{ width: number; height: number }>,
    shadowOpacity: number,
    shadowRadius: number,
    elevation: number,
): ShadowElevationToken {
    return {
        boxShadow,
        shadowColor,
        shadowOffset,
        shadowOpacity,
        shadowRadius,
        elevation,
    };
}

/**
 * The elevation ladder, by role. Very low opacity, sized by how far the surface floats: the border and
 * its raised edge (`theme/raisedEdge.ts`) draw the surface's outline, so the shadow only grounds it.
 *
 * | Level | Shape (CSS)       | Role                                                            |
 * |-------|-------------------|-----------------------------------------------------------------|
 * | 1     | xs: 0 1px 2px     | controls (field boxes, outline buttons, chips) and in-flow cards |
 * | 2     | sm: 0 1px 3px     | tooltips, compact menus, small floating marks                   |
 * | 3     | md: 0 4px 6px     | headers and notices that float over content, larger menus        |
 * | 4     | lg: 0 10px 15px   | popovers, dialogs, sheets                                        |
 * | 5     | lg, double alpha  | the rare floating moment that must stand out                     |
 * | 6     | wide, faint       | a full-height overlay pane (not a card)                          |
 *
 * `alpha` is each layer's opacity: 5% on light (a hair of grounding under a visible hairline). Dark
 * grounds swallow a black shadow, so dark doubles it on web; native shadows render heavier than CSS,
 * so the native approximation stays subtler on dark.
 */
function ladderBoxShadows(alpha: number): Record<1 | 2 | 3 | 4 | 5, string> {
    const a = (scale: number) => Math.round(alpha * scale * 1000) / 1000;
    return {
        1: `0 1px 2px rgba(0, 0, 0, ${a(1)})`,
        2: `0 1px 3px rgba(0, 0, 0, ${a(1)}), 0 1px 2px -1px rgba(0, 0, 0, ${a(1)})`,
        3: `0 4px 6px -1px rgba(0, 0, 0, ${a(1)}), 0 2px 4px -2px rgba(0, 0, 0, ${a(1)})`,
        4: `0 10px 15px -3px rgba(0, 0, 0, ${a(1)}), 0 4px 6px -4px rgba(0, 0, 0, ${a(1)})`,
        5: `0 10px 15px -3px rgba(0, 0, 0, ${a(2)}), 0 4px 6px -4px rgba(0, 0, 0, ${a(2)})`,
    };
}

/** Light surfaces. */
export function buildLightShadowLevels(): ShadowLevels {
    const box = ladderBoxShadows(0.05);
    return {
        1: token(box[1], '#000000', { width: 0, height: 1 }, 0.05, 1, 1),
        2: token(box[2], '#000000', { width: 0, height: 1 }, 0.07, 2, 2),
        3: token(box[3], '#000000', { width: 0, height: 3 }, 0.08, 4, 4),
        4: token(box[4], '#000000', { width: 0, height: 6 }, 0.1, 8, 6),
        5: token(box[5], '#000000', { width: 0, height: 6 }, 0.16, 10, 10),
        // Large floating panels (a full-height overlay pane), not cards. A big surface far from the
        // backdrop casts a WIDE, FAINT penumbra — reusing level 5 here reads as a hard dark edge
        // because its blur is tuned for something card-sized. Much larger, much lower opacity.
        6: token(
            '0 24px 90px rgba(0, 0, 0, 0.10), 0 8px 30px rgba(0, 0, 0, 0.05)',
            '#000000',
            { width: 0, height: 12 },
            0.14,
            36,
            16,
        ),
    };
}

/** Dark surfaces: the same shapes; see the ladder note for the alphas. */
export function buildDarkShadowLevels(): ShadowLevels {
    const box = ladderBoxShadows(0.1);
    return {
        1: token(box[1], '#000000', { width: 0, height: 1 }, 0.04, 1, 1),
        2: token(box[2], '#000000', { width: 0, height: 1 }, 0.06, 2, 2),
        3: token(box[3], '#000000', { width: 0, height: 3 }, 0.07, 4, 4),
        4: token(box[4], '#000000', { width: 0, height: 6 }, 0.09, 8, 6),
        5: token(box[5], '#000000', { width: 0, height: 6 }, 0.14, 10, 10),
        6: token('0 24px 90px rgba(0, 0, 0, 0.22), 0 8px 30px rgba(0, 0, 0, 0.12)', '#000000', { width: 0, height: 12 }, 0.26, 36, 16),
    };
}

/** Rotated popover arrow on web: keep a dedicated token (RN-web shadow + transforms are finicky). */
export function buildShadowPopoverArrowBoxShadow(dark: boolean): string {
    // The popover's own level-4 ground, at the arrow's scale, so the arrow never reads darker than its card.
    return dark
        ? '0 4px 6px -2px rgba(0, 0, 0, 0.1)'
        : '0 4px 6px -2px rgba(0, 0, 0, 0.05)';
}

/**
 * Subtle top inner-shadow for a floating glass surface (iOS-26 / Reddit-style
 * inset depth). Light: a faint dark recess at the top edge; dark: a faint light
 * highlight (a dark inset would be invisible on dark chrome). Cross-platform
 * `inset` box-shadow (supported on RN 0.81 Fabric + web). Used by `GlassPanel`.
 */
export function buildGlassInnerShadow(dark: boolean, opacityScale = 1): string {
    const web = Platform.OS === 'web';
    // Light needs a slightly stronger top recess to read on a white surface (a white
    // rim on white barely shows); the dark inset (a white highlight) stays subtle.
    // RN-web paints the inset a touch heavier, so web is kept a hair fainter.
    const baseAlpha = dark ? (web ? 0.025 : 0.05) : (web ? 0.036 : 0.05);
    // `opacityScale` < 1 fades the recess for surfaces where it reads too strong
    // (e.g. the large glass composer). Rounded to keep the rgba() string clean
    // (0.036 * 0.7 = 0.0252 → 0.025) and byte-identical at the default scale = 1.
    const alpha = Math.round(baseAlpha * opacityScale * 1000) / 1000;
    // Negative spread (≈ -offset, larger than the blur) confines the inset to the
    // TOP edge only — the iOS glass top-edge recess — instead of bleeding around all
    // four sides like a plain offset+blur inset.
    return dark
        ? `inset 0px 8px 14px -10px rgba(255, 255, 255, ${alpha})`
        : `inset 0px 8px 14px -10px rgba(0, 0, 0, ${alpha})`;
}

/**
 * Floating glass surface rim. Light: a bright near-white rim (Reddit-style glass
 * edge); dark: a subtle light translucent rim so the surface separates from the
 * dark background. Replaces the plain grey `border.strong` outline. Used by
 * `GlassPanel`.
 */
export function buildGlassBorderColor(dark: boolean): string {
    return dark
        // Keep the dark rim close to the subtle hairline used by Item/ItemGroup
        // chrome (`border.surface` ≈ 0.056) — a full-strength rim reads too strong
        // across a large surface like the composer.
        ? 'rgba(255, 255, 255, 0.08)'
        : 'rgba(255, 255, 255, 0.92)';
}

/**
 * The seam between a docked side pane and the content sheet it sits beside.
 *
 * X-offset only, no spread: the cast has to travel sideways onto the neighbouring pane
 * rather than pool underneath the sheet. It is deliberately far wider and fainter than a
 * card shadow — a full-height edge at card opacity reads as a hard dark line.
 *
 * Web-only by contract. Native has no sideways-only box-shadow equivalent, and the RN
 * `shadow*`/`elevation` approximation would paint on all four edges; native separates the
 * two planes with the seam hairline instead.
 *
 * One owner on purpose: this recipe was previously re-typed at three call sites (the app
 * shell's content sheet and both `MultiPaneHost` docked panes), which is exactly the shape
 * that lets one quietly fall behind the others.
 */
export function buildSeamCastShadow(dark: boolean): string {
    return dark
        ? '-5px 0 22px rgba(0, 0, 0, 0.13)'
        : '-5px 0 22px rgba(0, 0, 0, 0.035)';
}

/**
 * View shadow styles for a themed elevation step.
 */
export function shadowLevelStyle(level: ShadowElevationToken): ShadowLevelStyle {
    if (Platform.OS === 'web') {
        return { boxShadow: level.boxShadow };
    }
    return {
        shadowColor: level.shadowColor,
        shadowOffset: level.shadowOffset,
        shadowOpacity: level.shadowOpacity,
        shadowRadius: level.shadowRadius,
        elevation: level.elevation,
    };
}

/**
 * Dedicated cast shadow for floating glass surfaces (`GlassPanel`, glass composer).
 *
 * A single wide, soft drop shadow with the opacity baked in — this is the one knob
 * for how strong glass shadows read. It is a real theme token (`glass.castShadow`)
 * rather than a runtime transform of the elevation ladder: on web, Unistyles
 * compiles token styles to CSS variables, so transforming `shadowLevels[n].boxShadow`
 * at runtime is a no-op (the value is already a `var(--…)` reference). Baking the
 * opacity into its own token makes the web shadow actually controllable.
 */
export function buildGlassCastShadow(dark: boolean): string {
    // Smaller y-offset than a card shadow so the soft cast wraps a little higher and
    // reads at the top edge of the surface (not just below it).
    return dark
        ? '0px 4px 28px rgba(0, 0, 0, 0.22)'
        : '0px 4px 28px rgba(0, 0, 0, 0.07)';
}

/**
 * Cast shadow style for a floating glass surface (`GlassPanel`).
 *
 * iOS keeps the soft native `shadow*` props (the tuned, device-validated look).
 * Web/Android use the dedicated `glass.castShadow` token (`castBoxShadow`) — the
 * cross-platform box-shadow with its opacity baked in — never Android `elevation`,
 * which renders a hard Material drop-shadow. `soft` halves the iOS opacity for
 * surfaces sitting on an opaque band.
 */
export function buildGlassCastShadowStyle(
    level: ShadowElevationToken,
    castBoxShadow: string,
    soft: boolean,
): ShadowLevelStyle {
    if (Platform.OS === 'ios') {
        return {
            shadowColor: level.shadowColor,
            shadowOffset: level.shadowOffset,
            shadowOpacity: level.shadowOpacity * (soft ? 0.5 : 1),
            shadowRadius: level.shadowRadius,
            elevation: 0,
        };
    }
    return { boxShadow: castBoxShadow };
}
