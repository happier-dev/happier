import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import { serverFetch } from "@/sync/http/client";

import {
    AccountPetsListResponseSchema,
    type AccountPetsListResponse,
} from "@/sync/domains/pets/accountPetLibraryTypes";

export async function listAccountPets(credentials: AuthCredentials): Promise<AccountPetsListResponse> {
    const response = await serverFetch("/v1/account/pets", {
        headers: {
            Authorization: `Bearer ${credentials.token}`,
        },
    }, { includeAuth: false, retry: "none" });

    const raw = await response.json();
    const parsed = AccountPetsListResponseSchema.parse(raw);
    if (!response.ok && parsed.ok) {
        throw new Error(`Account pets request failed: ${response.status}`);
    }
    return parsed;
}
