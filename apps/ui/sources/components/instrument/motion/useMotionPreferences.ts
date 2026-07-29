import * as React from 'react';
import { Platform } from 'react-native';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useSetting } from '@/sync/domains/state/storage';

import { INSTRUMENT_DURATIONS, INSTRUMENT_SPRINGS } from './motionTokens';

/**
 * Motion-preference chokepoint for the instrument kit — the "anti-christmas-tree"
 * dial. Instrument components read their motion caps ONLY through this hook; they
 * never touch the raw `visualEffectsLevel` / `animatedNumbers` / `contextGaugeStyle`
 * settings or the OS reduce-motion flag directly. This keeps one place that maps
 * (user setting × OS accessibility flag × platform) → resolved caps.
 */

export type MotionLevel = 'full' | 'subtle' | 'minimal';
export type ContextGaugeStyle = 'gauge' | 'text' | 'hidden';

/** How an entrance plays once resolved. */
export type EntranceSpec = Readonly<{
    /** `'travel'` = spring in from offset/scale; `'crossfade'` = opacity only. */
    kind: 'travel' | 'crossfade';
    durationMs: number;
}>;

export type MotionPreferences = Readonly<{
    /** Effective level after the OS reduce-motion override is applied. */
    level: MotionLevel;
    /** Signature spring family (constant; exposed for ergonomic access). */
    springs: typeof INSTRUMENT_SPRINGS;
    /** Resolved entrance behavior for a single mount. */
    entrance: EntranceSpec;
    /** Shaders / shimmer / specular highlights — only at `full`. */
    effectsEnabled: boolean;
    /** Odometer number rolls — user toggle AND not `minimal`. */
    animatedNumbersEnabled: boolean;
    /** Haptic feedback — native only AND not `minimal`. */
    hapticsEnabled: boolean;
    /** True when the OS reduce-motion / reduce-transparency flag forced the level. */
    reduceMotion: boolean;
    /** Presentation choice for in-session context usage. */
    contextGaugeStyle: ContextGaugeStyle;
}>;

export type MotionPreferencesInput = Readonly<{
    visualEffectsLevel: MotionLevel;
    animatedNumbers: boolean;
    contextGaugeStyle: ContextGaugeStyle;
    /** OS `prefers-reduced-motion` (web) / Reduce Motion (native). */
    osReduceMotion: boolean;
    /** True when running on the web platform. */
    isWeb: boolean;
}>;

/**
 * Pure resolver — the full (setting × OS flag × platform) → caps matrix. Unit
 * tested in isolation. OS reduce-motion FORCES `minimal` regardless of setting.
 */
export function resolveMotionPreferences(input: MotionPreferencesInput): MotionPreferences {
    const level: MotionLevel = input.osReduceMotion ? 'minimal' : input.visualEffectsLevel;
    const isMinimal = level === 'minimal';

    const entrance: EntranceSpec = isMinimal
        ? { kind: 'crossfade', durationMs: INSTRUMENT_DURATIONS.crossfadeMinimal }
        : { kind: 'travel', durationMs: INSTRUMENT_DURATIONS.entrance };

    return {
        level,
        springs: INSTRUMENT_SPRINGS,
        entrance,
        effectsEnabled: level === 'full',
        animatedNumbersEnabled: input.animatedNumbers && !isMinimal,
        hapticsEnabled: !input.isWeb && !isMinimal,
        reduceMotion: input.osReduceMotion,
        contextGaugeStyle: input.contextGaugeStyle,
    };
}

/**
 * React hook binding the live settings + OS reduce-motion flag to the resolved
 * caps. The ONLY sanctioned way for a kit component to learn its motion budget.
 */
export function useMotionPreferences(): MotionPreferences {
    const visualEffectsLevel = useSetting('visualEffectsLevel');
    const animatedNumbers = useSetting('animatedNumbers');
    const contextGaugeStyle = useSetting('contextGaugeStyle');
    const osReduceMotion = useReducedMotionPreference();
    const isWeb = Platform.OS === 'web';

    return React.useMemo(
        () => resolveMotionPreferences({
            visualEffectsLevel,
            animatedNumbers,
            contextGaugeStyle,
            osReduceMotion,
            isWeb,
        }),
        [visualEffectsLevel, animatedNumbers, contextGaugeStyle, osReduceMotion, isWeb],
    );
}
