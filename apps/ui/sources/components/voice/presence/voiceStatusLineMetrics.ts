export type VoiceStatusLineSize = 'pill' | 'island' | 'hero';

/** Conversation and read-aloud status words share their type metrics. */
export const VOICE_STATUS_LINE_METRICS: Readonly<Record<VoiceStatusLineSize, Readonly<{ fontSize: number; lineHeight: number; gap: number }>>> = {
    pill: { fontSize: 12.5, lineHeight: 16, gap: 7 },
    island: { fontSize: 13, lineHeight: 17, gap: 7 },
    hero: { fontSize: 17, lineHeight: 22, gap: 10 },
};
