import type { AuthCredentials } from "@/auth/storage/tokenStorage";
import { serverFetch, type ServerFetch } from "@/sync/http/client";
import { AccountPetCreateResponseV1Schema, AccountPetDeleteResponseV1Schema, AccountPetAssetReadResponseV1Schema,
    PetAssetMediaTypeV1Schema, type AccountPetCreateRequestV1,
    type AccountPetLibraryEntryV1, type PetAssetMediaTypeV1 } from '@happier-dev/protocol/pets/accountLibrary';
import { validateAccountPetCreateRequestV1 } from '@happier-dev/protocol/pets/accountPetCreateValidation';
import { openAccountPetSpritesheetV1, openAccountPetStoredEntryForModeV1, sealAccountPetPackageV1 } from '@happier-dev/protocol/pets/accountPetEncryptionV1';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { inspectPetAtlasImage } from '@/sync/domains/pets/inspectPetAtlasImage';
import { resolveAccountPetReadAdmission } from '@/sync/domains/pets/resolveAccountPetReadAdmission';

import {
    AccountPetsListResponseSchema,
    type AccountPetsListResponse,
} from "@/sync/domains/pets/accountPetLibraryTypes";

/** The library as this client reads it: E2EE entries arrive opened; failed opens are omitted. */
export type OpenedAccountPetsListResponse =
    | Readonly<{ ok: true; pets: AccountPetLibraryEntryV1[] }>
    | Extract<AccountPetsListResponse, { ok: false }>;

export type AccountPetCreateResult =
    | Readonly<{ ok: true; pet: AccountPetLibraryEntryV1; reused?: true }>
    | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;

const UNAVAILABLE = { ok: false, errorCode: 'custom_pet_sync_unavailable', error: 'custom_pet_sync_unavailable' } as const;

export async function listAccountPets(
    credentials: AuthCredentials,
    options: Readonly<{ request?: ServerFetch }> = {},
): Promise<OpenedAccountPetsListResponse> {
    const request = options.request ?? serverFetch;
    const admission = await resolveAccountPetReadAdmission(credentials, options.request ? { request: options.request } : {});
    if (admission.status === 'unavailable') return UNAVAILABLE;
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
    if (!parsed.ok) return parsed;
    // A mode mismatch or an entry that fails to open settles missing, so faces keep their seeded fallback.
    const pets = parsed.pets.flatMap(entry => openAccountPetStoredEntryForModeV1(entry, admission.account) ?? []);
    return { ok: true, pets };
}

/**
 * The Account create owner for UI writers. Plain Accounts send the package for Home
 * validation; E2EE Accounts validate here with the protocol owner, then seal it under
 * the Account envelope, because the Home sees only ciphertext.
 */
export async function createAccountPet(credentials: AuthCredentials, input: AccountPetCreateRequestV1,
    options: Readonly<{ request: ServerFetch; signal?: AbortSignal }>): Promise<AccountPetCreateResult> {
    const admission = await resolveAccountPetReadAdmission(credentials, { request: options.request, usage: 'fresh-authority' });
    options.signal?.throwIfAborted();
    if (admission.status === 'unavailable') return UNAVAILABLE;
    let body: unknown = input;
    if (admission.account.mode === 'e2ee') {
        const validated = await validateAccountPetCreateRequestV1(input, { inspectAtlas: inspectPetAtlasImage });
        options.signal?.throwIfAborted();
        if (!validated.ok) return { ok: false, errorCode: validated.errorCode, error: validated.error, details: { reason: validated.reason } };
        const sealed = sealAccountPetPackageV1({ validated, material: admission.account.material, randomBytes: getRandomBytes });
        if (!sealed.ok) return { ok: false, errorCode: sealed.errorCode, error: sealed.error, details: { reason: sealed.reason } };
        body = sealed.request;
    }
    const response = await options.request('/v1/account/pets', {
        method: 'POST', headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: options.signal,
    }, { includeAuth: false, retry: 'none' });
    const result = AccountPetCreateResponseV1Schema.parse(await response.json());
    if (!result.ok) return result;
    const pet = openAccountPetStoredEntryForModeV1(result.pet, admission.account);
    if (!pet) return { ok: false, errorCode: 'internal_error', error: 'account_pet_unopenable' };
    return { ok: true, pet, ...(result.reused ? { reused: true as const } : {}) };
}

/** Renderer and template authoring read the same authenticated Account asset. */
export async function readAccountPetSpritesheet(credentials: AuthCredentials, accountPetId: string,
    options: Readonly<{
        request: ServerFetch;
        signal?: AbortSignal;
        /** The opened entry's spritesheet; E2EE Accounts bind the decrypted bytes to it. */
        expected?: Readonly<{ mediaType: PetAssetMediaTypeV1; digest: string }>;
    }>): Promise<
        | Readonly<{ ok: true; mediaType: PetAssetMediaTypeV1; bytes: Uint8Array }>
        | Readonly<{ ok: false; errorCode: string; error: string }>
    > {
    const request: ServerFetch = (path, init, requestOptions) => options.request(path, { ...init, signal: options.signal }, requestOptions);
    const admission = await resolveAccountPetReadAdmission(credentials, { request });
    options.signal?.throwIfAborted();
    if (admission.status === 'unavailable') return { ok: false, errorCode: admission.reason, error: admission.reason };
    if (admission.account.mode === 'e2ee' && !options.expected) return UNAVAILABLE;
    const response = await request(`/v1/account/pets/${encodeURIComponent(accountPetId)}/spritesheet`, {
        headers: { Authorization: `Bearer ${credentials.token}` },
    }, { includeAuth: false, retry: 'none' });
    if (!response.ok) {
        const parsed = AccountPetAssetReadResponseV1Schema.safeParse(await response.json());
        if (parsed.success && !parsed.data.ok) return parsed.data;
        return { ok: false, errorCode: 'invalid_result', error: 'invalid_result' };
    }
    if (admission.account.mode === 'e2ee' && options.expected) {
        const bytes = openAccountPetSpritesheetV1({
            ciphertext: new Uint8Array(await response.arrayBuffer()), material: admission.account.material, expected: options.expected,
        });
        return bytes ? { ok: true, mediaType: options.expected.mediaType, bytes } : UNAVAILABLE;
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
