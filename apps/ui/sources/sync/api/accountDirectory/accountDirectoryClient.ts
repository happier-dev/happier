import { z } from 'zod';
import {
    ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1,
    ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1,
    ACCOUNT_DIRECTORY_PREFERRED_HOME_HTTP_PATH_V1,
    HOME_LOGIN_HTTP_PATH_V1,
    AccountDirectoryHomeDeleteResponseV1Schema,
    AccountDirectoryHomeDeleteRequestV1Schema,
    AccountDirectoryHomePutRequestV1Schema,
    AccountDirectoryHomePutResponseV1Schema,
    AccountDirectoryHomesResponseV1Schema,
    AccountDirectoryMeResponseV1Schema,
    AccountDirectoryPreferredHomePatchRequestV1Schema,
    AccountDirectoryPreferredHomePatchResponseV1Schema,
    AccountDirectoryLinkDeleteRequestV1Schema,
    AccountDirectoryLinkDeleteResponseV1Schema,
    AccountDirectoryLinkPutRequestV1Schema,
    AccountDirectoryLinkPutResponseV1Schema,
    AccountDirectoryRouteErrorResponseV1Schema,
    ACCOUNT_DIRECTORY_ERROR_CODES_V1,
    HomeConnectionDescriptorV1Schema,
    HomeLoginAssertionRequestV1Schema,
    HomeLoginAssertionResponseV1Schema,
    HomeLoginRedemptionRequestV1Schema,
    HomeLoginRedemptionResultV1Schema,
    buildAccountDirectoryHomeHttpPathV1,
    buildAccountDirectoryHomeLoginAssertionHttpPathV1,
    buildAccountDirectoryLinkHttpPathV1,
    type AccountDirectoryHomeEntryV1,
    type AccountDirectoryHomesResponseV1,
    type AccountDirectoryMeResponseV1,
    type HomeConnectionDescriptorV1,
    type HomeConnectionEndpointV1,
    type HomeLoginAssertionV1,
    type HomeLoginRedemptionResponseV1,
    type HomeLoginRedemptionResultV1,
    type AccountDirectoryLinkDeleteResponseV1,
    type AccountDirectoryLinkPutResponseV1,
    type AccountDirectoryErrorCodeV1,
} from '@happier-dev/protocol/auth/accountDirectory';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import {
    normalizeAccountDirectoryEndpoint,
} from '@/auth/accountDirectory/accountDirectoryCredentialStorage';
import type { AccountDirectoryCredentialCustody, AccountDirectoryCredentialTarget, AuthCredentials } from '@/auth/storage/tokenStorage';
import { captureAccountDirectoryCredentialCustody } from '@/auth/storage/tokenStorage';
import type { HomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import type { AccountDirectoryAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';

export const HomeLoginAssertionV1Schema = HomeLoginAssertionResponseV1Schema;
export { HomeConnectionDescriptorV1Schema, HomeLoginAssertionResponseV1Schema as HomeLoginAssertionSchema };
export type {
    AccountDirectoryHomeEntryV1,
    AccountDirectoryHomesResponseV1,
    AccountDirectoryMeResponseV1,
    HomeConnectionDescriptorV1,
    HomeConnectionEndpointV1,
    HomeLoginAssertionV1,
    HomeLoginRedemptionResponseV1,
    HomeLoginRedemptionResultV1,
};

export class AccountDirectoryRequestError extends Error {
    readonly status: number;
    readonly code?: AccountDirectoryErrorCodeV1;
    readonly transient: boolean;

    constructor(status: number, code?: AccountDirectoryErrorCodeV1) {
        super(`Account Service request failed (${status}${code ? `: ${code}` : ''})`);
        this.name = 'AccountDirectoryRequestError';
        this.status = status;
        this.code = code;
        this.transient = status === 408 || status === 429 || status >= 500;
    }
}

export class AccountDirectoryResponseError extends Error {
    constructor(readonly operation: string) {
        super(`Invalid Account Directory response (${operation})`);
        this.name = 'AccountDirectoryResponseError';
    }
}

export function isAccountDirectoryRelinkConflict(error: unknown): boolean {
    return error instanceof AccountDirectoryRequestError
        && error.status === 409
        && error.code === ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidRequest;
}

function normalizeTarget(target: AccountDirectoryCredentialTarget): Readonly<{
    endpoint: string;
    serverIdentityId: string;
}> {
    const normalized = normalizeAccountDirectoryEndpoint(target.endpoint);
    if (!normalized) throw new Error('Invalid Account Service endpoint');
    const serverIdentityId = target.serverIdentityId.trim();
    if (!serverIdentityId) throw new Error('Account Service identity is required');
    return { endpoint: normalized, serverIdentityId };
}

async function readErrorCode(response: Response): Promise<AccountDirectoryErrorCodeV1 | undefined> {
    try {
        const payload: unknown = await response.json();
        const parsed = AccountDirectoryRouteErrorResponseV1Schema.safeParse(payload);
        return parsed.success ? parsed.data.error : undefined;
    } catch {
        return undefined;
    }
}

export type AccountDirectoryClient = ReturnType<typeof createAccountDirectoryClient>;

export function createAccountDirectoryClient(
    target: AccountDirectoryCredentialTarget,
    transport: AccountDirectoryAuthTransport = {},
    credentialCustody?: AccountDirectoryCredentialCustody,
) {
    const { endpoint: baseUrl, serverIdentityId } = normalizeTarget(target);
    const credentialTarget = { endpoint: baseUrl, serverIdentityId };
    const custody = credentialCustody ?? captureAccountDirectoryCredentialCustody(credentialTarget);
    const request = async <T>(path: string, init: RequestInit | undefined, schema: z.ZodType<T>): Promise<T> => {
        if (!path.startsWith('/v1/account-directory/')) throw new Error('Account Service path is not an Account Directory route');
        const credentials = await custody.read();
        if (!custody.isCurrent()) throw new Error('Account Service credential custody superseded');
        const headers = new Headers(init?.headers);
        headers.set('Accept', 'application/json');
        const fetchAtEndpoint = createServerFetchAtEndpoint({
            endpointUrl: baseUrl,
            ...(transport.runtimeOrigin ? { runtimeOrigin: transport.runtimeOrigin } : {}),
            ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
            serverId: serverIdentityId,
            credentials,
        });
        const response = await custody.issue(async () => await fetchAtEndpoint(
            path,
            { ...init, headers },
            { includeAuth: Boolean(credentials), retry: 'none' },
        ));
        if (!response.ok) throw new AccountDirectoryRequestError(response.status, await readErrorCode(response));
        const payload: unknown = await response.json();
        const parsed = schema.safeParse(payload);
        if (!parsed.success) throw new Error(`Invalid Account Service response for ${path}`);
        return parsed.data;
    };

    return {
        endpoint: baseUrl,
        serverIdentityId,
        isCurrent: custody.isCurrent,
        logout: custody.logout,
        request,
        getMe: () => request(ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1, undefined, AccountDirectoryMeResponseV1Schema),
        listHomes: () => request(ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1, undefined, AccountDirectoryHomesResponseV1Schema),
        putHome: (home: Readonly<{ homeServerIdentityId: string; label: string; connectionDescriptor: HomeConnectionDescriptorV1 }>) => request(
            buildAccountDirectoryHomeHttpPathV1(home.homeServerIdentityId),
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(AccountDirectoryHomePutRequestV1Schema.parse({ v: 1, label: home.label, connectionDescriptor: home.connectionDescriptor })) },
            AccountDirectoryHomePutResponseV1Schema,
        ),
        publishHomeDescriptor: async (home: Readonly<{
            homeServerIdentityId: string;
            label: string;
            connectionDescriptor: HomeConnectionDescriptorV1;
        }>) => {
            const body = AccountDirectoryHomePutRequestV1Schema.parse({
                v: 1,
                label: home.label,
                connectionDescriptor: home.connectionDescriptor,
            });
            if (body.connectionDescriptor.homeServerIdentityId !== home.homeServerIdentityId) {
                throw new AccountDirectoryResponseError('home_descriptor_publication');
            }
            const entry = await request(
                buildAccountDirectoryHomeHttpPathV1(home.homeServerIdentityId),
                { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
                AccountDirectoryHomePutResponseV1Schema,
            );
            const expectedDescriptor = body.connectionDescriptor;
            if (entry.homeServerIdentityId !== home.homeServerIdentityId) {
                throw new AccountDirectoryResponseError('home_descriptor_publication');
            }
            if (entry.connectionDescriptor.revision > expectedDescriptor.revision) {
                return { kind: 'current' as const, entry };
            }
            if (JSON.stringify(entry.connectionDescriptor) !== JSON.stringify(expectedDescriptor)) {
                throw new AccountDirectoryResponseError('home_descriptor_publication');
            }
            return { kind: 'published' as const, entry };
        },
        readHomeDescriptor: async (homeServerIdentityId: string) => {
            const directory = await request(
                ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1,
                undefined,
                AccountDirectoryHomesResponseV1Schema,
            );
            return directory.homes.find((home) => home.homeServerIdentityId === homeServerIdentityId) ?? null;
        },
        deleteHome: (homeServerIdentityId: string) => request(
            buildAccountDirectoryHomeHttpPathV1(homeServerIdentityId),
            {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(AccountDirectoryHomeDeleteRequestV1Schema.parse({ v: 1 })),
            },
            AccountDirectoryHomeDeleteResponseV1Schema,
        ),
        setPreferredHome: (homeServerIdentityId: string | null) => request(
            ACCOUNT_DIRECTORY_PREFERRED_HOME_HTTP_PATH_V1,
            { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(AccountDirectoryPreferredHomePatchRequestV1Schema.parse({ v: 1, homeServerIdentityId })) },
            AccountDirectoryPreferredHomePatchResponseV1Schema,
        ),
        requestLoginAssertion: (homeServerIdentityId: string, body: Readonly<{ clientBoxPublicKeyBase64: string }>) => request(
            buildAccountDirectoryHomeLoginAssertionHttpPathV1(homeServerIdentityId),
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(HomeLoginAssertionRequestV1Schema.parse({ v: 1, homeServerIdentityId, ...body })) },
            HomeLoginAssertionResponseV1Schema,
        ),
    };
}

export async function redeemHomeLoginAssertion(
    target: HomeEnrollmentTransport,
    assertion: HomeLoginAssertionV1,
    options: Readonly<{ approvalId?: string }> = {},
): Promise<HomeLoginRedemptionResultV1> {
    const request = HomeLoginRedemptionRequestV1Schema.parse({
        v: 1,
        assertion,
        ...(options.approvalId ? { approvalId: options.approvalId } : null),
    });
    const response = await target.createRequest({
        serverId: target.homeServerIdentityId,
        credentials: null,
    })(HOME_LOGIN_HTTP_PATH_V1, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    }, { includeAuth: false, retry: 'none' });
    if (!response.ok) throw new AccountDirectoryRequestError(response.status, await readErrorCode(response));
    const parsed = HomeLoginRedemptionResultV1Schema.safeParse(await response.json());
    if (!parsed.success) throw new AccountDirectoryResponseError('home_login_redemption');
    return parsed.data;
}

/**
 * Home-targeted Account Directory link PUT. The request always targets the exact Home through
 * the canonical enrollment transport and authenticates with that Home's own full credential —
 * never an Account Service credential. Callers must opt into `relink`: a changed issuer key is a
 * trust change that automatic provisioning must not apply silently.
 */
export async function putHomeDirectoryLink(
    target: HomeEnrollmentTransport,
    link: Readonly<{
        issuerServerIdentityId: string;
        issuerSubjectId: string;
        issuerSigningKeyId: string;
        issuerSigningPublicKeyBase64Url: string;
    }>,
    options: Readonly<{ credentials: AuthCredentials; relink?: boolean }>,
): Promise<AccountDirectoryLinkPutResponseV1> {
    const request = AccountDirectoryLinkPutRequestV1Schema.parse({
        v: 1,
        ...link,
        relink: options.relink ?? false,
    });
    const path = buildAccountDirectoryLinkHttpPathV1(request.issuerServerIdentityId);
    const response = await target.createRequest({
        serverId: target.homeServerIdentityId,
        credentials: options.credentials,
    })(path, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    }, { includeAuth: true, retry: 'none' });
    if (!response.ok) throw new AccountDirectoryRequestError(response.status, await readErrorCode(response));
    const parsed = AccountDirectoryLinkPutResponseV1Schema.safeParse(await response.json());
    if (!parsed.success) throw new AccountDirectoryResponseError('home_directory_link_put');
    return parsed.data;
}

/**
 * Home-targeted Account Directory link DELETE. Removes the Home's pinned trust in the issuer so
 * future delegated sign-in assertions from that Account Service are refused; Home credentials the
 * Home already issued stay valid until revoked on the Home. Authenticates with that Home's own
 * full credential through the canonical enrollment transport, never an Account Service credential.
 */
export async function deleteHomeDirectoryLink(
    target: HomeEnrollmentTransport,
    issuerServerIdentityId: string,
    options: Readonly<{ credentials: AuthCredentials }>,
): Promise<AccountDirectoryLinkDeleteResponseV1> {
    const response = await target.createRequest({
        serverId: target.homeServerIdentityId,
        credentials: options.credentials,
    })(buildAccountDirectoryLinkHttpPathV1(issuerServerIdentityId), {
        method: 'DELETE',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(AccountDirectoryLinkDeleteRequestV1Schema.parse({ v: 1 })),
    }, { includeAuth: true, retry: 'none' });
    if (!response.ok) throw new AccountDirectoryRequestError(response.status, await readErrorCode(response));
    const parsed = AccountDirectoryLinkDeleteResponseV1Schema.safeParse(await response.json());
    if (!parsed.success) throw new AccountDirectoryResponseError('home_directory_link_delete');
    return parsed.data;
}
