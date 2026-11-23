import type { SoundEffectId } from './soundEffectCatalog';

/** Bundled audio for each sound effect. Kept apart from the catalog so settings never load audio. */
export const SOUND_EFFECT_SOURCES: Readonly<Record<SoundEffectId, number>> = Object.freeze({
    'sound_electro_158': require('@/assets/sounds/sound_electro_158.mp3'),
    'sound_electro_284': require('@/assets/sounds/sound_electro_284.mp3'),
    'sound_electro_48': require('@/assets/sounds/sound_electro_48.mp3'),
    'sound_electro_67': require('@/assets/sounds/sound_electro_67.mp3'),
    'sound_electro_79': require('@/assets/sounds/sound_electro_79.mp3'),
    'sound_electro_chord1': require('@/assets/sounds/sound_electro_chord1.mp3'),
    'sound_electro-flutter': require('@/assets/sounds/sound_electro-flutter.mp3'),
    'sound_electro_pop1': require('@/assets/sounds/sound_electro_pop1.mp3'),
    'sound_electro_swell-taps': require('@/assets/sounds/sound_electro_swell-taps.mp3'),
    'sound_electro_windows-ish1': require('@/assets/sounds/sound_electro_windows-ish1.mp3'),
});
