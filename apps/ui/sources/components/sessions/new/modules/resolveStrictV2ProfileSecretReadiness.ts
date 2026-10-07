import { SecretReferenceOverlayV1Schema, type SecretReferenceOverlayV1 } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import type { AIBackendProfile } from '@happier-dev/protocol/profiles/backendProfileSchema';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';

export type StrictV2ProfileSecretReadiness =
    | Readonly<{ ok: true; secretReferenceOverlay?: SecretReferenceOverlayV1 }>
    | Readonly<{
        ok: false;
        reason:
            | 'secret_requirement_unsatisfied'
            | 'saved_secret_selection_unavailable'
            | 'session_only_secret_not_representable';
    }>;

function normalizeNonEmpty(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

/**
 * Validates the UI's Profile secret choices without opening secret material.
 *
 * The stable Profile id remains the persisted/default binding owner. A saved
 * selection that differs from that binding is projected as the value-free
 * one-launch overlay; secret material never leaves the daemon materializer.
 */
export function resolveStrictV2ProfileSecretReadiness(input: Readonly<{
    profile: AIBackendProfile;
    defaultBindings?: Readonly<Record<string, string>> | null;
    selectedSecretIds?: Readonly<Record<string, string | null | undefined>> | null;
    sessionOnlyValues?: Readonly<Record<string, string | null | undefined>> | null;
    machineEnvReadyByName?: Readonly<Record<string, boolean | null | undefined>> | null;
    resolveSavedSecretReference: (ref: string) => SavedSecretReferenceResolution;
}>): StrictV2ProfileSecretReadiness {
    if (Object.values(input.sessionOnlyValues ?? {}).some((value) => (
        typeof value === 'string' && value.length > 0
    ))) {
        return { ok: false, reason: 'session_only_secret_not_representable' };
    }

    const overlayBindings: Record<string, { ref: string; revision?: number }> = {};
    for (const requirement of input.profile.envVarRequirements ?? []) {
        if ((requirement.kind ?? 'secret') !== 'secret') continue;
        const selectedRef = normalizeNonEmpty(input.selectedSecretIds?.[requirement.name]);
        const defaultRef = normalizeNonEmpty(input.defaultBindings?.[requirement.name]);
        const effectiveRef = selectedRef ?? defaultRef;
        if (effectiveRef) {
            const resolution = input.resolveSavedSecretReference(effectiveRef);
            if (resolution.status !== 'ready') {
                return { ok: false, reason: 'saved_secret_selection_unavailable' };
            }
            if (selectedRef && selectedRef !== defaultRef) {
                if (resolution.kind === 'shared_resource') {
                    if (!Number.isSafeInteger(resolution.revision) || (resolution.revision ?? 0) < 1) {
                        return { ok: false, reason: 'saved_secret_selection_unavailable' };
                    }
                    overlayBindings[requirement.name] = {
                        ref: selectedRef,
                        revision: resolution.revision!,
                    };
                } else {
                    overlayBindings[requirement.name] = { ref: selectedRef };
                }
            }
            continue;
        }
        if (input.machineEnvReadyByName?.[requirement.name] === true) continue;
        if (requirement.required === true) {
            return { ok: false, reason: 'secret_requirement_unsatisfied' };
        }
    }
    if (Object.keys(overlayBindings).length === 0) return { ok: true };
    return {
        ok: true,
        secretReferenceOverlay: SecretReferenceOverlayV1Schema.parse({
            v: 1,
            bindings: overlayBindings,
        }),
    };
}
