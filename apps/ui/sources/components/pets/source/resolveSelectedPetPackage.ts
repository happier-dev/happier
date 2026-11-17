import { resolvePetPackage } from './resolvePetPackage';
import type { FeatureDecision} from '@happier-dev/protocol/features/decision';
import type { PetAssetMediaTypeV1} from '@happier-dev/protocol/pets/accountLibrary';
import type { PetPackageSourceV1 } from '@happier-dev/protocol/pets/source';
import type { PetAccountReferenceV1, PetDeviceOverrideV1 } from '@happier-dev/protocol/pets/selection';
import type { LocalPetDaemonTarget } from '@/sync/domains/pets/localPetSourceTypes';

type PetEnabledOverride = 'inherit' | 'enabled' | 'disabled';

export type SelectedPetPackageSource =
    | Extract<PetPackageSourceV1, { kind: 'builtIn' }>
    | Readonly<{
        kind: 'accountPet';
        accountPetId: string;
        sourceKey: string;
        mediaType?: PetAssetMediaTypeV1;
        digest?: string;
    }>
    | Readonly<{
        kind: 'detectedCodexHome';
        sourceKey: string;
        mediaType?: PetAssetMediaTypeV1;
        digest?: string;
        daemonTarget?: LocalPetDaemonTarget;
    }>
    | Readonly<{
        kind: 'happierManagedLocal';
        sourceKey: string;
        mediaType?: PetAssetMediaTypeV1;
        digest?: string;
        daemonTarget?: LocalPetDaemonTarget;
    }>;

export type ResolveSelectedPetPackageInput = Readonly<{
    companionDecision: Pick<FeatureDecision, 'state'> | null;
    syncDecision: Pick<FeatureDecision, 'state'> | null;
    accountSettings: Readonly<{
        petsEnabled: boolean;
        petsSelectedPetRef: PetAccountReferenceV1;
    }>;
    localSettings: Readonly<{
        petsEnabledOverride: PetEnabledOverride;
        petsSelectedPetOverride: PetDeviceOverrideV1;
    }>;
    sources: Readonly<{
        accountPetsById: ReadonlyMap<string, SelectedPetPackageSource>;
        builtInFallbackPetId: string;
        builtInPetIds: readonly string[];
        detectedCodexHomeBySourceKey: ReadonlyMap<string, SelectedPetPackageSource>;
        happierManagedLocalBySourceKey: ReadonlyMap<string, SelectedPetPackageSource>;
    }>;
}>;

export type ResolveSelectedPetPackageResult = Readonly<{
    enabled: boolean;
    source: SelectedPetPackageSource | null;
    fallback: null | Readonly<{
        reason: 'companion_feature_disabled' | 'account_pet_sync_unavailable' | 'unknown_pet_source' | 'pet_disabled';
        originalRef?: PetAccountReferenceV1 | PetDeviceOverrideV1;
        shouldPersist: false;
    }>;
}>;

function builtInFallbackSource(petId: string): SelectedPetPackageSource {
    return { kind: 'builtIn', petId };
}

export function resolveSelectedPetPackage(input: ResolveSelectedPetPackageInput): ResolveSelectedPetPackageResult {
    if (input.companionDecision?.state !== 'enabled') {
        return {
            enabled: false,
            source: null,
            fallback: {
                reason: 'companion_feature_disabled',
                shouldPersist: false,
            },
        };
    }

    const enabled =
        input.localSettings.petsEnabledOverride === 'enabled'
            ? true
            : input.localSettings.petsEnabledOverride === 'disabled'
                ? false
                : input.accountSettings.petsEnabled;

    if (!enabled) {
        return {
            enabled: false,
            source: null,
            fallback: {
                reason: 'pet_disabled',
                shouldPersist: false,
            },
        };
    }

    const localOverride = input.localSettings.petsSelectedPetOverride;
    if (localOverride.kind === 'detectedCodexHome') {
        const source = input.sources.detectedCodexHomeBySourceKey.get(localOverride.sourceKey) ?? null;
        return source
            ? { enabled: true, source, fallback: null }
            : {
                enabled: true,
                source: builtInFallbackSource(input.sources.builtInFallbackPetId),
                fallback: { reason: 'unknown_pet_source', originalRef: localOverride, shouldPersist: false },
            };
    }

    if (localOverride.kind === 'happierManagedLocal') {
        const source = input.sources.happierManagedLocalBySourceKey.get(localOverride.sourceKey) ?? null;
        return source
            ? { enabled: true, source, fallback: null }
            : {
                enabled: true,
                source: builtInFallbackSource(input.sources.builtInFallbackPetId),
                fallback: { reason: 'unknown_pet_source', originalRef: localOverride, shouldPersist: false },
            };
    }

    const accountRef = input.accountSettings.petsSelectedPetRef;
    const lookup = resolvePetPackage({
        ref: accountRef,
        petsEnabled: true,
        syncEnabled: input.syncDecision?.state === 'enabled',
        accountPetsStatus: 'ready',
        accountPetsById: input.sources.accountPetsById,
        builtInPetIds: input.sources.builtInPetIds,
    });
    if (lookup.status === 'ready') return { enabled: true, source: lookup.source, fallback: null };
    return {
        enabled: true,
        source: builtInFallbackSource(input.sources.builtInFallbackPetId),
        fallback: accountRef.kind === 'builtIn' ? null : {
            reason: input.syncDecision?.state !== 'enabled' ? 'account_pet_sync_unavailable' : 'unknown_pet_source',
            originalRef: accountRef,
            shouldPersist: false,
        },
    };
}
