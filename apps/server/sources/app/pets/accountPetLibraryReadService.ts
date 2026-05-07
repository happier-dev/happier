import type {
    AccountPetAssetReadResult,
    ListAccountPetsForAccountParams,
    ReadAccountPetAssetForAccountParams,
} from "./accountPetLibraryService";
import { getDefaultAccountPetLibraryServices } from "./accountPetLibraryRuntime";

export async function listAccountPetsForAccount(params: ListAccountPetsForAccountParams) {
    return await getDefaultAccountPetLibraryServices().listAccountPetsForAccount(params);
}

export async function readAccountPetAssetForAccount(
    params: ReadAccountPetAssetForAccountParams,
): Promise<AccountPetAssetReadResult | null> {
    return await getDefaultAccountPetLibraryServices().readAccountPetAssetForAccount(params);
}
