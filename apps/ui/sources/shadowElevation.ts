import { Platform, type ViewStyle } from 'react-native';

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

/** Dark surfaces: stronger cast shadows so depth reads on dark UI. */
export function buildDarkShadowLevels(): ShadowLevels {
    return {
        1: token(
            '0 2px 8px rgba(0, 0, 0, 0.32), 0 1px 3px rgba(0, 0, 0, 0.48)',
            '#000000',
            { width: 0, height: 1 },
            0.28,
            5,
            2,
        ),
        2: token(
            '0 2px 12px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.5)',
            '#000000',
            { width: 0, height: 2 },
            0.34,
            6,
            3,
        ),
        3: token(
            '0 4px 20px rgba(0, 0, 0, 0.45), 0 2px 10px rgba(0, 0, 0, 0.42)',
            '#000000',
            { width: 0, height: 3 },
            0.38,
            10,
            5,
        ),
        4: token(
            '0 8px 32px rgba(0, 0, 0, 0.5), 0 4px 16px rgba(0, 0, 0, 0.45)',
            '#000000',
            { width: 0, height: 4 },
            0.45,
            14,
            8,
        ),
        5: token(
            '0 14px 44px rgba(0, 0, 0, 0.55), 0 6px 22px rgba(0, 0, 0, 0.48)',
            '#000000',
            { width: 0, height: 8 },
            0.5,
            18,
            12,
        ),
    };
}

/** Rotated popover arrow on web: keep a dedicated token (RN-web shadow + transforms are finicky). */
export function buildShadowPopoverArrowBoxShadow(dark: boolean): string {
    return dark
        ? '0 4px 14px rgba(0, 0, 0, 0.55)'
        : '0 4px 14px rgba(0, 0, 0, 0.24)';
}

/**
 * View shadow styles for a themed elevation step.
 * Cast to `ViewStyle` so `boxShadow` (web) is accepted on RN Web.
 */
export function shadowLevelStyle(level: ShadowElevationToken): ViewStyle {
    if (Platform.OS === 'web') {
        return { boxShadow: level.boxShadow } as ViewStyle;
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
 * Same values as {@link shadowLevelStyle}, typed for spreading inside Unistyles `StyleSheet.create`
 * (plain `ViewStyle` breaks its stylesheet inference when spread into style objects).
 */
export function shadowLevelForSheet(level: ShadowElevationToken): any {
    return shadowLevelStyle(level);
}
