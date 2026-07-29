import { Platform } from 'react-native';

/** Canonical UI shadow steps (1 = lowest). Web uses CSS `box-shadow`; native uses a single-shadow approximation. */
export const SHADOW_LEVELS = [1, 2, 3, 4, 5] as const;
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

/** Light surfaces: level 1 matches product spec (lowest elevation). */
export function buildLightShadowLevels(): ShadowLevels {
    return {
        1: token(
            '0 2px 8px rgba(0, 0, 0, 0.01), 0 1px 3px rgba(0, 0, 0, 0.03)',
            '#000000',
            { width: 0, height: 1 },
            0.06,
            4,
            1,
        ),
        2: token(
            '0 2px 10px rgba(0, 0, 0, 0.04), 0 2px 6px rgba(0, 0, 0, 0.06)',
            '#000000',
            { width: 0, height: 2 },
            0.1,
            5,
            2,
        ),
        3: token(
            '0 4px 18px rgba(0, 0, 0, 0.07), 0 2px 8px rgba(0, 0, 0, 0.09)',
            '#000000',
            { width: 0, height: 3 },
            0.14,
            8,
            4,
        ),
        4: token(
            '0 8px 28px rgba(0, 0, 0, 0.11), 0 4px 14px rgba(0, 0, 0, 0.09)',
            '#000000',
            { width: 0, height: 4 },
            0.18,
            12,
            6,
        ),
        5: token(
            '0 14px 40px rgba(0, 0, 0, 0.16), 0 6px 18px rgba(0, 0, 0, 0.12)',
            '#000000',
            { width: 0, height: 8 },
            0.22,
            16,
            10,
        ),
    };
}

/** Dark surfaces: subtler cast shadows so depth reads without over-lifting dark chrome. */
export function buildDarkShadowLevels(): ShadowLevels {
    return {
        1: token('0 1px 4px rgba(0, 0, 0, 0.02), 0 1px 2px rgba(0, 0, 0, 0.03)', '#000000', { width: 0, height: 1 }, 0.04, 3, 1),
        2: token('0 2px 6px rgba(0, 0, 0, 0.04), 0 2px 4px rgba(0, 0, 0, 0.05)', '#000000', { width: 0, height: 2 }, 0.08, 4, 2),
        3: token('0 3px 10px rgba(0, 0, 0, 0.06), 0 2px 6px rgba(0, 0, 0, 0.07)', '#000000', { width: 0, height: 3 }, 0.12, 7, 4),
        4: token('0 5px 16px rgba(0, 0, 0, 0.08), 0 3px 8px rgba(0, 0, 0, 0.09)', '#000000', { width: 0, height: 4 }, 0.16, 10, 6),
        5: token('0 8px 22px rgba(0, 0, 0, 0.10), 0 4px 10px rgba(0, 0, 0, 0.12)', '#000000', { width: 0, height: 8 }, 0.20, 14, 10),
    };
}

/** Rotated popover arrow on web: keep a dedicated token (RN-web shadow + transforms are finicky). */
export function buildShadowPopoverArrowBoxShadow(dark: boolean): string {
    return dark
        ? '0 3px 10px rgba(0, 0, 0, 0.42)'
        : '0 4px 14px rgba(0, 0, 0, 0.24)';
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
