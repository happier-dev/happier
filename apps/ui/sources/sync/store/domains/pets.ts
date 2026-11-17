import type { AccountPetMetadata, AccountPetLibraryStatus } from "@/sync/domains/pets/accountPetLibraryTypes";
import type { LocalPetSourceMetadata } from "@/sync/domains/pets/localPetSourceTypes";
import { normalizeAccountPetsById } from "@/sync/domains/pets/normalizeAccountPetLibrary";
import {
    loadLocalPetSourcesBySourceKey,
    saveLocalPetSourcesBySourceKey,
} from "@/sync/domains/state/localPetSourcePersistence";

import type { StoreGet, StoreSet } from "./_shared";
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type PetsDomain = {
    accountPetsStatus: AccountPetLibraryStatus;
    setAccountPetsStatus: (status: AccountPetLibraryStatus) => void;
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
        accountPetsStatus: 'pending',
        setAccountPetsStatus: (accountPetsStatus) => set((state) => state.accountPetsStatus === accountPetsStatus ? state : ({ ...state, accountPetsStatus })),
        accountPetsById: {},
        localPetSourcesBySourceKey,
        applyAccountPets: (pets) =>
            set((state) => {
                const incoming = normalizeAccountPetsById(pets);
                if (sameStrictJsonValue(state.accountPetsById, incoming)) return state.accountPetsStatus === 'ready' ? state : { ...state, accountPetsStatus: 'ready' as const };
                const accountPetsById = Object.fromEntries(Object.entries(incoming).map(([id, pet]) => [id,
                    sameStrictJsonValue(state.accountPetsById[id], pet) ? state.accountPetsById[id]! : pet]));
                return { ...state, accountPetsById, accountPetsStatus: 'ready' as const };
            }),
        upsertAccountPet: (pet) =>
            set((state) => sameStrictJsonValue(state.accountPetsById[pet.accountPetId], pet) ? state : ({
                ...state,
                accountPetsById: {
                    ...state.accountPetsById,
                    [pet.accountPetId]: pet,
                },
            })),
        removeAccountPet: (petId) =>
            set((state) => {
                if (!Object.prototype.hasOwnProperty.call(state.accountPetsById, petId)) return state;
                const next = { ...state.accountPetsById };
                delete next[petId];
                return {
                    ...state,
                    accountPetsById: next,
                };
            }),
        upsertLocalPetSources: (sources) =>
            set((state) => {
                let next: Record<string, LocalPetSourceMetadata> | null = null;
                for (const source of sources) {
                    if (sameStrictJsonValue((next ?? state.localPetSourcesBySourceKey)[source.sourceKey], source)) continue;
                    next ??= { ...state.localPetSourcesBySourceKey };
                    next[source.sourceKey] = source;
                }
                if (next === null) return state;
                saveLocalPetSourcesBySourceKey(next);
                return {
                    ...state,
                    localPetSourcesBySourceKey: next,
                };
            }),
        removeLocalPetSource: (sourceKey) =>
            set((state) => {
                if (!Object.prototype.hasOwnProperty.call(state.localPetSourcesBySourceKey, sourceKey)) return state;
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
