export type StreamingTextRevealPreset = 'subtle' | 'full';

export type StreamingTextRevealConfig = Readonly<{
    durationMs: number;
    easing: string;
    translateYPx: number;
}>;

const STREAMING_TEXT_REVEAL_CONFIGS: Record<StreamingTextRevealPreset, StreamingTextRevealConfig> = {
    subtle: {
        durationMs: 150,
        easing: 'ease-out',
        translateYPx: 2,
    },
    full: {
        durationMs: 180,
        easing: 'ease-out',
        translateYPx: 3,
    },
};

export function normalizeStreamingTextRevealPreset(value: unknown): StreamingTextRevealPreset {
    return value === 'full' ? 'full' : 'subtle';
}

type NavigatorCapabilityLike = {
    deviceMemory?: unknown;
    hardwareConcurrency?: unknown;
};

function readNavigatorCapability(): NavigatorCapabilityLike | null {
    if (typeof navigator === 'undefined') return null;
    return navigator as NavigatorCapabilityLike;
}

/**
 * Every revealed word runs its own short CSS animation while text streams, so a live
 * transcript always has an animation in flight. On hosts that asked for reduced motion the
 * OS accessibility contract wins, and on low-capability hosts (few cores or little memory,
 * where the per-word compositor work lands on a busy main thread) the animation costs more
 * than the polish is worth. Both take the plain non-animated rendering branch; the preset
 * system and capable hosts are unchanged. The reduced-motion fact reaches this owner as an
 * input from the shared `useReducedMotionPreference` store (the process-wide reader of that
 * preference) instead of a per-render `matchMedia` probe, and capability reads fail closed
 * to "capable" when the host exposes no capability facts.
 */
function shouldDisableRevealForLowCapabilityHost(): boolean {
    const navigatorCapability = readNavigatorCapability();
    if (navigatorCapability == null) return false;
    const { deviceMemory, hardwareConcurrency } = navigatorCapability;
    if (typeof hardwareConcurrency === 'number' && Number.isFinite(hardwareConcurrency) && hardwareConcurrency <= 4) {
        return true;
    }
    return typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) && deviceMemory <= 4;
}

export function resolveStreamingTextRevealConfig(input: {
    animated?: boolean;
    preset?: unknown;
    reducedMotion: boolean;
}): StreamingTextRevealConfig | null {
    if (input.animated !== true) return null;
    if (input.reducedMotion) return null;
    if (shouldDisableRevealForLowCapabilityHost()) return null;
    return STREAMING_TEXT_REVEAL_CONFIGS[normalizeStreamingTextRevealPreset(input.preset)];
}
