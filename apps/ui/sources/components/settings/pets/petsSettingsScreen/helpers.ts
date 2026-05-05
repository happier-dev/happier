import type {
    DaemonPetImportLocalPackageRequestV1,
    DiscoveredPetPackageV1,
    ImportedLocalPetPackageV1,
} from '@happier-dev/protocol';

import type {
    LocalPetPreviewAsset,
    LocalPetSourceMetadata,
} from '@/sync/domains/pets/localPetSourceTypes';

import type {
    DesktopPetOverlayVisibilityModeOverride,
    DetectedPet,
    LocalDevicePetRow,
    ManagedLocalPet,
    PetEnabledOverride,
    PetImportCandidate,
} from './types';

const PET_ENABLED_OVERRIDE_IDS = new Set(['inherit', 'enabled', 'disabled']);
const DESKTOP_PET_OVERLAY_VISIBILITY_MODE_OVERRIDE_IDS = new Set([
    'inherit',
    'attentionOrActive',
    'alwaysWhenEnabled',
    'attentionOnly',
]);

export const USE_ON_THIS_DEVICE_ACTION_ID = 'use-on-this-device';
export const IMPORT_TO_ACCOUNT_ACTION_ID = 'import-to-account';
export const REMOVE_FROM_DEVICE_ACTION_ID = 'remove-from-device';

export function isPetEnabledOverride(value: string): value is PetEnabledOverride {
    return PET_ENABLED_OVERRIDE_IDS.has(value);
}

export function isDesktopPetOverlayVisibilityModeOverride(
    value: string,
): value is DesktopPetOverlayVisibilityModeOverride {
    return DESKTOP_PET_OVERLAY_VISIBILITY_MODE_OVERRIDE_IDS.has(value);
}

export function sanitizeTestIdPart(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'pet';
}

export const sourceRowTestId = (scope: 'local' | 'account', petId: string) =>
    `settings-pets-select-source-${scope}-${sanitizeTestIdPart(petId)}`;
export const detectedRowTestId = (petId: string) => `settings-pets-detected-source-${sanitizeTestIdPart(petId)}`;
export const useOnDeviceActionTestId = (petId: string) => `settings-pets-use-on-this-device-${sanitizeTestIdPart(petId)}`;
export const importToAccountActionTestId = (petId: string) => `settings-pets-import-to-account-${sanitizeTestIdPart(petId)}`;
export const removeFromDeviceActionTestId = (petId: string) => `settings-pets-remove-from-device-${sanitizeTestIdPart(petId)}`;

export function upsertByKey<T>(rows: readonly T[], next: T, readKey: (row: T) => string): T[] {
    const nextKey = readKey(next);
    const existingIndex = rows.findIndex((row) => readKey(row) === nextKey);
    if (existingIndex < 0) return [...rows, next];
    const copy = rows.slice();
    copy[existingIndex] = next;
    return copy;
}

export const isManagedLocalPet = (pet: ImportedLocalPetPackageV1 | DiscoveredPetPackageV1): pet is ManagedLocalPet =>
    pet.source.kind === 'happierManagedLocal';
export const isDetectedPet = (pet: DiscoveredPetPackageV1): pet is DetectedPet => pet.source.kind === 'detectedCodexHome';

export function metadataToLocalPetRow(source: LocalPetSourceMetadata): LocalDevicePetRow | null {
    if (source.source.kind !== 'happierManagedLocal') return null;
    return {
        sourceKey: source.sourceKey,
        petId: source.manifest.id,
        displayName: source.displayName,
        source: source.source,
        previewAsset: {
            sourceKey: source.sourceKey,
            mediaType: source.mediaType,
            digest: source.digest,
            sizeBytes: source.sizeBytes,
            target: source.daemonTarget,
        },
    };
}

export function managedPetToLocalPetRow(
    pet: ManagedLocalPet,
    target: LocalPetPreviewAsset['target'],
): LocalDevicePetRow {
    return {
        sourceKey: pet.sourceKey,
        petId: pet.petId,
        displayName: pet.displayName,
        source: pet.source,
        previewAsset: {
            sourceKey: pet.sourceKey,
            mediaType: pet.mediaType,
            digest: pet.digest ?? null,
            sizeBytes: pet.sizeBytes ?? null,
            target,
        },
    };
}

export function buildImportPayload(
    candidate: PetImportCandidate | null,
): Pick<DaemonPetImportLocalPackageRequestV1, 'sourceKey' | 'packagePath'> | null {
    if (!candidate) return null;
    if (candidate.sourceKey) return { sourceKey: candidate.sourceKey };
    const packagePath = 'packagePath' in candidate ? candidate.packagePath : null;
    if (typeof packagePath === 'string' && packagePath.length > 0) return { packagePath };
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object');
}

function readStringField(value: unknown, key: string): string | null {
    if (!isRecord(value)) return null;
    const field = value[key];
    return typeof field === 'string' ? field : null;
}

export function isRpcMethodNotAvailableError(value: unknown): boolean {
    if (readStringField(value, 'errorCode') === 'RPC_METHOD_NOT_AVAILABLE') return true;
    if (readStringField(value, 'code') === 'RPC_METHOD_NOT_AVAILABLE') return true;
    const message = readStringField(value, 'message') ?? readStringField(value, 'error');
    if (message?.includes('RPC_METHOD_NOT_AVAILABLE')) return true;
    if (message?.includes('RPC method not available')) return true;
    if (message?.toLowerCase().includes('rpc method not available')) return true;
    if (isRecord(value)) {
        return [
            value.cause,
            value.payload,
            value.response,
            value.error,
        ].some(isRpcMethodNotAvailableError);
    }
    return false;
}
