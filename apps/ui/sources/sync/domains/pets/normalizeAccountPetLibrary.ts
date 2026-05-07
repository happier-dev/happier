import type { AccountPetMetadata } from "./accountPetLibraryTypes";

export function normalizeAccountPetsById(
    pets: readonly AccountPetMetadata[],
): Record<string, AccountPetMetadata> {
    const byId: Record<string, AccountPetMetadata> = {};
    for (const pet of pets) {
        byId[pet.accountPetId] = pet;
    }
    return byId;
}
