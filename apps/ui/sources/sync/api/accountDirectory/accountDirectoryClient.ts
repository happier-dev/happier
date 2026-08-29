import { z } from 'zod';
import {
    AccountDirectoryHomeDeleteResponseV1Schema,
    AccountDirectoryHomePutRequestV1Schema,
    AccountDirectoryHomePutResponseV1Schema,
    AccountDirectoryHomesResponseV1Schema,
    AccountDirectoryMeResponseV1Schema,
    AccountDirectoryPreferredHomePatchResponseV1Schema,
    HomeConnectionDescriptorV1Schema,
    HomeLoginAssertionResponseV1Schema,
    HomeLoginRedemptionRequestV1Schema,
    HomeLoginRedemptionResultV1Schema,
    type AccountDirectoryHomeEntryV1,
    type AccountDirectoryHomesResponseV1,
    type AccountDirectoryMeResponseV1,
    type HomeConnectionDescriptorV1,
    type HomeLoginAssertionV1,
    type HomeLoginRedemptionResponseV1,
} from '@happier-dev/protocol';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import {
    accountDirectoryCredentialStorage,
    normalizeAccountDirectoryEndpoint,
} from '@/auth/accountDirectory/accountDirectoryCredentialStorage';

export const HomeLoginAssertionV1Schema = HomeLoginAssertionResponseV1Schema;
export const HomeLoginRedemptionResponseV1Schema = HomeLoginRedemptionResultV1Schema;
export type {
    AccountDirectoryHomeEntryV1,
    AccountDirectoryHomesResponseV1,
    AccountDirectoryMeResponseV1,
    HomeConnectionDescriptorV1,
    HomeLoginAssertionV1,
    HomeLoginRedemptionResponseV1,
};

export class AccountDirectoryRequestError extends Error {
    readonly status: number;
    readonly code?: string;

    constructor(status: number, code?: string) {
        super(`Account Service request failed (${status}${code ? `: ${code}` : ''})`);
        this.name = 'AccountDirectoryRequestError';
        this.status = status;
        this.code = code;
    }
}

function normalizeEndpoint(endpoint: string): string {
    const normalized = normalizeAccountDirectoryEndpoint(endpoint);
    if (!normalized) throw new Error('Invalid Account Service endpoint');
    return normalized;
}

async function readErrorCode(response: Response): Promise<string | undefined> {
    try {
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
        const code = (payload as Record<string, unknown>).error;
        return typeof code === 'string' ? code : undefined;
    } catch {
        return undefined;
    }
}

export type AccountDirectoryClient = ReturnType<typeof createAccountDirectoryClient>;

export function createAccountDirectoryClient(endpoint: string, options: Readonly<{ token?: string }> = {}) {
    const baseUrl = normalizeEndpoint(endpoint);
    const request = async <T>(path: string, init: RequestInit | undefined, schema: z.ZodType<T>): Promise<T> => {
        if (!path.startsWith('/v1/account-directory/')) throw new Error('Account Service path is not an Account Directory route');
        const credentials = options.token
            ? { token: options.token }
            : await accountDirectoryCredentialStorage.get(baseUrl);
        const headers = new Headers(init?.headers);
        headers.set('Accept', 'application/json');
        if (credentials?.token) headers.set('Authorization', `Bearer ${credentials.token}`);
        const response = await runtimeFetch(`${baseUrl}${path}`, { ...init, headers });
        if (!response.ok) throw new AccountDirectoryRequestError(response.status, await readErrorCode(response));
        const payload: unknown = await response.json();
        const parsed = schema.safeParse(payload);
        if (!parsed.success) throw new Error(`Invalid Account Service response for ${path}`);
        return parsed.data;
    };

    return {
        endpoint: baseUrl,
        request,
        getMe: () => request('/v1/account-directory/me', undefined, AccountDirectoryMeResponseV1Schema),
        listHomes: () => request('/v1/account-directory/homes', undefined, AccountDirectoryHomesResponseV1Schema),
        putHome: (home: Readonly<{ homeServerIdentityId: string; label: string; connectionDescriptor: HomeConnectionDescriptorV1 }>) => request(
            `/v1/account-directory/homes/${encodeURIComponent(home.homeServerIdentityId)}`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(AccountDirectoryHomePutRequestV1Schema.parse({ v: 1, label: home.label, connectionDescriptor: home.connectionDescriptor })) },
            AccountDirectoryHomePutResponseV1Schema,
        ),
        deleteHome: (homeServerIdentityId: string) => request(
            `/v1/account-directory/homes/${encodeURIComponent(homeServerIdentityId)}`,
            { method: 'DELETE' },
            AccountDirectoryHomeDeleteResponseV1Schema,
        ),
        setPreferredHome: (homeServerIdentityId: string | null) => request(
            '/v1/account-directory/homes/preferred',
            { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(AccountDirectoryPreferredHomePatchRequestV1Schema.parse({ v: 1, homeServerIdentityId })) },
            AccountDirectoryPreferredHomePatchResponseV1Schema,
        ),
        requestLoginAssertion: (homeServerIdentityId: string, body: Readonly<{ clientBoxPublicKeyBase64: string }>) => request(
            `/v1/account-directory/homes/${encodeURIComponent(homeServerIdentityId)}/login-assertion`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(HomeLoginAssertionRequestV1Schema.parse({ v: 1, homeServerIdentityId, ...body })) },
            HomeLoginAssertionResponseV1Schema,
        ),
    };
}

export async function redeemHomeLoginAssertion(
    endpoint: string,
    assertion: HomeLoginAssertionV1,
): Promise<HomeLoginRedemptionResponseV1> {
    const baseUrl = normalizeEndpoint(endpoint);
    const request = HomeLoginRedemptionRequestV1Schema.parse({ v: 1, assertion });
    const response = await runtimeFetch(`${baseUrl}/v1/auth/home-login`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    });
    if (!response.ok) throw new AccountDirectoryRequestError(response.status, await readErrorCode(response));
    const parsed = HomeLoginRedemptionResultV1Schema.safeParse(await response.json());
    if (!parsed.success || parsed.data.outcome !== 'authorized') {
        if (parsed.success && parsed.data.outcome === 'approval_required') {
            throw new AccountDirectoryRequestError(202, 'approval_required');
        }
        throw new Error('Invalid Home login redemption response');
    }
    return parsed.data;
}
