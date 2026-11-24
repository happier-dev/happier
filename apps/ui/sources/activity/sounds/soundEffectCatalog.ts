import { z } from 'zod';

/**
 * Every bundled sound effect, named after its file in `assets/sounds` without the extension.
 * The id doubles as the label people pick in Settings. Metro can only bundle assets it sees in a
 * literal `require`, so adding a file there also needs an entry here and in `soundEffectSources`.
 */
export const SOUND_EFFECT_IDS = [
    'sound_electro_158',
    'sound_electro_284',
    'sound_electro_48',
    'sound_electro_67',
    'sound_electro_79',
    'sound_electro_chord1',
    'sound_electro-flutter',
    'sound_electro_pop1',
    'sound_electro_swell-taps',
    'sound_electro_windows-ish1',
] as const;

export type SoundEffectId = (typeof SOUND_EFFECT_IDS)[number];

/**
 * The session changes that can play a sound: the red, yellow and green status colours, plus a
 * session continuing on its own after a usage limit.
 */
export type SoundEffectEvent = 'error' | 'attention' | 'success' | 'resume';

export const DEFAULT_SOUND_EFFECT_IDS: Readonly<Record<SoundEffectEvent, SoundEffectId>> = Object.freeze({
    error: 'sound_electro_158',
    attention: 'sound_electro_swell-taps',
    success: 'sound_electro_windows-ish1',
    resume: 'sound_electro_pop1',
});

/** A stored choice for a sound that is no longer bundled falls back to that event's default. */
export function soundEffectIdSchema(event: SoundEffectEvent) {
    return z.enum(SOUND_EFFECT_IDS).catch(DEFAULT_SOUND_EFFECT_IDS[event]);
}
