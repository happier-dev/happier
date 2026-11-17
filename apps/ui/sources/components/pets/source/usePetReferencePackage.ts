import * as React from 'react';
import type { PetAccountReferenceV1 } from '@happier-dev/protocol/pets/selection';
import type { PetCellBoundsV1 } from '@happier-dev/protocol/pets/atlasPixelInspection';
import { BUILT_IN_PET_IDS, resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import type { SelectedPetPackageSource } from './resolveSelectedPetPackage';
import { resolvePetPackage } from './resolvePetPackage';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { storage, usePeripheralFeedDemand } from '@/sync/domains/state/storage';

export type PetReferencePackageResult =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'ready'; source: SelectedPetPackageSource; displayName: string; opaqueBounds: PetCellBoundsV1 | null;
        spriteVersionNumber: 1 | 2; hasNeutralLookCell: boolean }>;

/** Faces consume feature decisions and library readiness, independent of companion preferences. */
export function usePetReferencePackage(
    ref: PetAccountReferenceV1 | null | undefined,
    options: Readonly<{ enabled?: boolean }> = {},
): PetReferencePackageResult {
    const enabled = options.enabled !== false;
    const companionDecision = useFeatureDecision('pets.companion');
    const syncDecision = useFeatureDecision('pets.sync');
    const accountPetId = enabled && ref?.kind === 'accountPet' ? ref.accountPetId : null;
    const accountPet = storage(state => accountPetId ? state.accountPetsById[accountPetId] : undefined);
    const accountPetsStatus = storage(state => accountPetId ? state.accountPetsStatus : 'pending');
    usePeripheralFeedDemand('accountPets', Boolean(accountPetId) && companionDecision?.state === 'enabled' && syncDecision?.state === 'enabled');
    const kind = ref?.kind;
    const petId = ref?.kind === 'builtIn' ? ref.petId : null;
    return React.useMemo(() => {
        if (!enabled || !kind) return { status: 'unavailable' };
        if (!companionDecision) return { status: 'pending' };
        if (companionDecision.state !== 'enabled') return { status: 'unavailable' };
        if (kind === 'accountPet' && !syncDecision) return { status: 'pending' };
        const source: SelectedPetPackageSource | null = accountPet ? {
            kind: 'accountPet', accountPetId: accountPet.accountPetId, sourceKey: accountPet.accountPetId,
            mediaType: accountPet.spritesheetAssetRef.mediaType, digest: accountPet.spritesheetAssetRef.digest,
            spriteVersionNumber: accountPet.manifest.spriteVersionNumber,
        } : null;
        const lookup = resolvePetPackage({
            ref: kind === 'builtIn' && petId ? { kind, petId } : accountPetId ? { kind: 'accountPet', accountPetId } : null,
            petsEnabled: companionDecision.state === 'enabled', syncEnabled: syncDecision?.state === 'enabled',
            accountPetsStatus, accountPetsById: new Map(source && accountPetId ? [[accountPetId, source]] : []),
            builtInPetIds: BUILT_IN_PET_IDS,
        });
        if (lookup.status !== 'ready') return { status: lookup.status };
        const builtIn = lookup.source.kind === 'builtIn' ? resolveBuiltInPetPackage(lookup.source.petId) : null;
        return { status: 'ready', source: lookup.source,
            displayName: builtIn?.manifest.displayName ?? accountPet?.manifest.displayName ?? '',
            opaqueBounds: builtIn?.opaqueBounds ?? accountPet?.opaqueBounds ?? null,
            spriteVersionNumber: accountPet?.manifest.spriteVersionNumber ?? 1,
            hasNeutralLookCell: accountPet?.hasNeutralLookCell === true };
    }, [enabled, kind, petId, accountPetId, companionDecision, syncDecision, accountPet, accountPetsStatus]);
}
