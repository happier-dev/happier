import type { BuildPetCompanionActivityModelInput, PetCompanionActivityModel } from './petCompanionActivityTypes';

/** Presentation only: admission, vocabulary and tray membership belong to shared activity. */
export function buildPetCompanionActivityModel(input: BuildPetCompanionActivityModelInput): PetCompanionActivityModel {
    const dismissed = input.dismissedTrayItemKeys instanceof Set
        ? input.dismissedTrayItemKeys : new Set(input.dismissedTrayItemKeys);
    const primary = input.projection.entries.find(entry => entry.activity === input.projection.activity);
    return {
        state: input.projection.activity,
        address: primary?.address ?? null,
        sessionId: primary?.sessionId ?? null,
        trayItems: input.projection.tray.filter(entry => !dismissed.has(entry.dismissKey))
            .map(entry => ({ ...entry, actions: { open: true, dismiss: true, quickReply: true } })),
    };
}
