import type { PetAccountReferenceV1 } from '@happier-dev/protocol/pets/selection';
import type { SelectedPetPackageSource } from './resolveSelectedPetPackage';
import type { AccountPetLibraryStatus } from '@/sync/domains/pets/accountPetLibraryTypes';

export type PetPackageLookupResult =
    | Readonly<{ status: 'pending'; source: null }>
    | Readonly<{ status: 'unavailable'; source: null }>
    | Readonly<{ status: 'ready'; source: SelectedPetPackageSource }>;

/** Reference lookup only; companion preferences and fallback belong to its caller. */
export function resolvePetPackage(input: Readonly<{
    ref: PetAccountReferenceV1 | null | undefined;
    petsEnabled: boolean;
    syncEnabled: boolean;
    accountPetsStatus: AccountPetLibraryStatus;
    accountPetsById: ReadonlyMap<string, SelectedPetPackageSource>;
    builtInPetIds: readonly string[];
}>): PetPackageLookupResult {
    if (!input.ref || !input.petsEnabled) return { status: 'unavailable', source: null };
    if (input.ref.kind === 'builtIn') {
        return input.builtInPetIds.includes(input.ref.petId)
            ? { status: 'ready', source: { kind: 'builtIn', petId: input.ref.petId } }
            : { status: 'unavailable', source: null };
    }
    if (!input.syncEnabled || input.accountPetsStatus === 'unavailable') return { status: 'unavailable', source: null };
    const source = input.accountPetsById.get(input.ref.accountPetId);
    if (source) return { status: 'ready', source };
    return { status: input.accountPetsStatus === 'pending' ? 'pending' : 'unavailable', source: null };
}
