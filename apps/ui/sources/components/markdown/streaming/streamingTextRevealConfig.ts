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

export function resolveStreamingTextRevealConfig(input: {
    animated?: boolean;
    preset?: unknown;
}): StreamingTextRevealConfig | null {
    if (input.animated !== true) return null;
    return STREAMING_TEXT_REVEAL_CONFIGS[normalizeStreamingTextRevealPreset(input.preset)];
}
