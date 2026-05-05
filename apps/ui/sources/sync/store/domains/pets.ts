import type { AccountPetMetadata } from "@/sync/domains/pets/accountPetLibraryTypes";
import type { LocalPetSourceMetadata } from "@/sync/domains/pets/localPetSourceTypes";
import { normalizeAccountPetsById } from "@/sync/domains/pets/normalizeAccountPetLibrary";
import {
    loadLocalPetSourcesBySourceKey,
    saveLocalPetSourcesBySourceKey,
} from "@/sync/domains/state/localPetSourcePersistence";

import type { StoreGet, StoreSet } from "./_shared";

export type PetsDomain = {
    accountPetsById: Record<string, AccountPetMetadata>;
    localPetSourcesBySourceKey: Record<string, LocalPetSourceMetadata>;
    applyAccountPets: (pets: AccountPetMetadata[]) => void;
    upsertAccountPet: (pet: AccountPetMetadata) => void;
    removeAccountPet: (petId: string) => void;
    upsertLocalPetSources: (sources: readonly LocalPetSourceMetadata[]) => void;
    removeLocalPetSource: (sourceKey: string) => void;
};

export function createPetsDomain<S extends PetsDomain>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): PetsDomain {
    const localPetSourcesBySourceKey = loadLocalPetSourcesBySourceKey();

    return {
        accountPetsById: {},
        localPetSourcesBySourceKey,
        applyAccountPets: (pets) =>
            set((state) => ({
                ...state,
                accountPetsById: normalizeAccountPetsById(pets),
            })),
        upsertAccountPet: (pet) =>
            set((state) => ({
                ...state,
                accountPetsById: {
                    ...state.accountPetsById,
                    [pet.accountPetId]: pet,
                },
            })),
        removeAccountPet: (petId) =>
            set((state) => {
                const next = { ...state.accountPetsById };
                delete next[petId];
                return {
                    ...state,
                    accountPetsById: next,
                };
            }),
        upsertLocalPetSources: (sources) =>
            set((state) => {
                const next = { ...state.localPetSourcesBySourceKey };
                for (const source of sources) {
                    next[source.sourceKey] = source;
                }
                saveLocalPetSourcesBySourceKey(next);
                return {
                    ...state,
                    localPetSourcesBySourceKey: next,
                };
            }),
        removeLocalPetSource: (sourceKey) =>
            set((state) => {
                const next = { ...state.localPetSourcesBySourceKey };
                delete next[sourceKey];
                saveLocalPetSourcesBySourceKey(next);
                return {
                    ...state,
                    localPetSourcesBySourceKey: next,
                };
            }),
    };
}
