import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import { serverFetch, type ServerFetch } from "@/sync/http/client";
import { AccountPetCreateResponseV1Schema, AccountPetDeleteResponseV1Schema,
    type AccountPetCreateRequestV1 } from '@happier-dev/protocol/pets/accountLibrary';

import {
    AccountPetsListResponseSchema,
    type AccountPetsListResponse,
} from "@/sync/domains/pets/accountPetLibraryTypes";

export async function listAccountPets(
    credentials: AuthCredentials,
    options: Readonly<{ request?: ServerFetch }> = {},
): Promise<AccountPetsListResponse> {
    const request = options.request ?? serverFetch;
    const response = await request("/v1/account/pets", {
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

export async function createAccountPet(credentials: AuthCredentials, input: AccountPetCreateRequestV1,
    options: Readonly<{ request: ServerFetch; signal?: AbortSignal }>) {
    const response = await options.request('/v1/account/pets', {
        method: 'POST', headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input), signal: options.signal,
    }, { includeAuth: false, retry: 'none' });
    return AccountPetCreateResponseV1Schema.parse(await response.json());
}

export async function deleteAccountPet(credentials: AuthCredentials, accountPetId: string,
    options: Readonly<{ request: ServerFetch; signal?: AbortSignal }>) {
    const response = await options.request(`/v1/account/pets/${encodeURIComponent(accountPetId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` }, signal: options.signal,
    }, { includeAuth: false, retry: 'none' });
    return AccountPetDeleteResponseV1Schema.parse(await response.json());
}
