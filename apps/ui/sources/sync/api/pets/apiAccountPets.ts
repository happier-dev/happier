import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import { serverFetch, type ServerFetch } from "@/sync/http/client";
import { AccountPetCreateResponseV1Schema, AccountPetDeleteResponseV1Schema, AccountPetAssetReadResponseV1Schema,
    PetAssetMediaTypeV1Schema, type AccountPetCreateRequestV1, type PetAssetMediaTypeV1 } from '@happier-dev/protocol/pets/accountLibrary';
import { resolveAccountPetReadAdmission } from '@/sync/domains/pets/resolveAccountPetReadAdmission';

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

/** Renderer and template authoring read the same authenticated Account asset. */
export async function readAccountPetSpritesheet(credentials: AuthCredentials, accountPetId: string,
    options: Readonly<{ request: ServerFetch; signal?: AbortSignal }>): Promise<
        | Readonly<{ ok: true; mediaType: PetAssetMediaTypeV1; bytes: Uint8Array }>
        | Readonly<{ ok: false; errorCode: string; error: string }>
    > {
    const request: ServerFetch = (path, init, requestOptions) => options.request(path, { ...init, signal: options.signal }, requestOptions);
    const admission = await resolveAccountPetReadAdmission(credentials, { request });
    options.signal?.throwIfAborted();
    if (admission.status === 'unavailable') return { ok: false, errorCode: admission.reason, error: admission.reason };
    const response = await request(`/v1/account/pets/${encodeURIComponent(accountPetId)}/spritesheet`, {
        headers: { Authorization: `Bearer ${credentials.token}` },
    }, { includeAuth: false, retry: 'none' });
    if (!response.ok) {
        const parsed = AccountPetAssetReadResponseV1Schema.safeParse(await response.json());
        if (parsed.success && !parsed.data.ok) return parsed.data;
        return { ok: false, errorCode: 'invalid_result', error: 'invalid_result' };
    }
    const mediaType = PetAssetMediaTypeV1Schema.safeParse(response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase());
    if (!mediaType.success) return { ok: false, errorCode: 'invalid_result', error: 'invalid_result' };
    return { ok: true, mediaType: mediaType.data, bytes: new Uint8Array(await response.arrayBuffer()) };
}

export async function deleteAccountPet(credentials: AuthCredentials, accountPetId: string,
    options: Readonly<{ request: ServerFetch; signal?: AbortSignal }>) {
    const response = await options.request(`/v1/account/pets/${encodeURIComponent(accountPetId)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` }, signal: options.signal,
    }, { includeAuth: false, retry: 'none' });
    return AccountPetDeleteResponseV1Schema.parse(await response.json());
}
