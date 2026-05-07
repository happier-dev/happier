import type { FeatureDecision, PetAssetMediaTypeV1, PetPackageSourceV1 } from '@happier-dev/protocol';
import type { LocalPetDaemonTarget } from '@/sync/domains/pets/localPetSourceMetadata';

type AccountPetReference =
    | Extract<PetPackageSourceV1, { kind: 'builtIn' }>
    | Pick<Extract<PetPackageSourceV1, { kind: 'accountPet' }>, 'kind' | 'accountPetId'>;

type LocalPetReferenceOverride =
    | Readonly<{ kind: 'inherit' }>
    | Pick<Extract<PetPackageSourceV1, { kind: 'detectedCodexHome' }>, 'kind' | 'sourceKey'>
    | Pick<Extract<PetPackageSourceV1, { kind: 'happierManagedLocal' }>, 'kind' | 'sourceKey'>;

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
        petsSelectedPetRef: AccountPetReference;
    }>;
    localSettings: Readonly<{
        petsEnabledOverride: PetEnabledOverride;
        petsSelectedPetOverride: LocalPetReferenceOverride;
    }>;
    sources: Readonly<{
        accountPetsById: ReadonlyMap<string, SelectedPetPackageSource>;
        builtInFallbackPetId: string;
        builtInPetIds: readonly string[];
        happierManagedLocalBySourceKey: ReadonlyMap<string, SelectedPetPackageSource>;
    }>;
}>;

export type ResolveSelectedPetPackageResult = Readonly<{
    enabled: boolean;
    source: SelectedPetPackageSource | null;
    fallback: null | Readonly<{
        reason: 'companion_feature_disabled' | 'account_pet_sync_unavailable' | 'unknown_pet_source' | 'pet_disabled';
        originalRef?: AccountPetReference | LocalPetReferenceOverride;
        shouldPersist: false;
    }>;
}>;

function builtInFallbackSource(petId: string): SelectedPetPackageSource {
    return { kind: 'builtIn', petId };
}

function resolveBuiltInSource(
    petId: string,
    builtInPetIds: readonly string[],
    builtInFallbackPetId: string,
): SelectedPetPackageSource {
    if (builtInPetIds.includes(petId)) {
        return { kind: 'builtIn', petId };
    }
    return builtInFallbackSource(builtInFallbackPetId);
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
        return {
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
    if (accountRef.kind === 'builtIn') {
        return {
            enabled: true,
            source: resolveBuiltInSource(
                accountRef.petId,
                input.sources.builtInPetIds,
                input.sources.builtInFallbackPetId,
            ),
            fallback: null,
        };
    }

    if (input.syncDecision?.state !== 'enabled') {
        return {
            enabled: true,
            source: builtInFallbackSource(input.sources.builtInFallbackPetId),
            fallback: {
                reason: 'account_pet_sync_unavailable',
                originalRef: accountRef,
                shouldPersist: false,
            },
        };
    }

    const accountSource = input.sources.accountPetsById.get(accountRef.accountPetId) ?? null;
    return accountSource
        ? { enabled: true, source: accountSource, fallback: null }
        : {
            enabled: true,
            source: builtInFallbackSource(input.sources.builtInFallbackPetId),
            fallback: { reason: 'unknown_pet_source', originalRef: accountRef, shouldPersist: false },
        };
}
