import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import { serverFetch } from "@/sync/http/client";

import {
    AccountPetsListResponseSchema,
    type AccountPetMetadata,
} from "@/sync/domains/pets/accountPetLibraryTypes";

export async function listAccountPets(credentials: AuthCredentials): Promise<AccountPetMetadata[]> {
    const response = await serverFetch("/v1/account/pets", {
        headers: {
            Authorization: `Bearer ${credentials.token}`,
        },
    }, { includeAuth: false, retry: "none" });

    if (!response.ok) {
        throw new Error(`Account pets request failed: ${response.status}`);
    }

    const raw = await response.json();
    const parsed = AccountPetsListResponseSchema.parse(raw);
    if (!parsed.ok) {
        throw new Error(parsed.errorCode);
    }
    return parsed.pets;
}
