import { selectSavedSecretReferenceSettingsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { retainShallow } from '@/sync/domains/state/structuralSharing';

/** Publish raw reference inputs once at the Settings owner, classifying only changed roots. */
export function projectSavedSecretReferenceSettings(
    settings: Readonly<Record<string, unknown>>,
    previousSettings?: Readonly<Record<string, unknown>>,
    previousReferences?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
    if (!previousSettings || !previousReferences) return selectSavedSecretReferenceSettingsV1(settings);
    if (settings === previousSettings) return previousReferences;
    const references = { ...previousReferences };
    for (const key of Object.keys(references)) {
        if (!Object.prototype.hasOwnProperty.call(settings, key)) delete references[key];
    }
    for (const [key, value] of Object.entries(settings)) {
        if (Object.prototype.hasOwnProperty.call(previousSettings, key) && Object.is(previousSettings[key], value)) continue;
        // The Protocol owner recognizes both known roots and identifiable future carriers.
        const selected = selectSavedSecretReferenceSettingsV1({ [key]: value });
        if (Object.prototype.hasOwnProperty.call(selected, key)) references[key] = value;
        else delete references[key];
    }
    return retainShallow(previousReferences, references);
}
