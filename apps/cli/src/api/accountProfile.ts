import { buildCurrentAccountStoredContentCompatibilityHttpHeaders, readCliClientUpgradeRequired } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import { AccountProfileResponseSchema, AccountSelfProfileV1Schema } from '@happier-dev/protocol/account/profile';
import type { AccountSelfProfileV1 } from '@happier-dev/protocol/account/profile';
import type { AccountProfileResponse } from '@happier-dev/protocol';
import { CLIENT_UPGRADE_REQUIRED_HTTP_STATUS } from '@happier-dev/protocol/clientCompatibility/upgradeRequiredV1';

import { createAuthenticationHttpStatusError, createHttpStatusError, isAuthenticationStatus } from './client/httpStatusError';
import { projectHomeAuthorizationHttpFailure } from './client/homeAuthorizationHttpFailure';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';

type AccountProfileReadOptions = Readonly<{ token: string; signal?: AbortSignal;
    authorizeRequest?: (request: Readonly<{ method: string; path: string }>) => Readonly<Record<string, string>> | null;
}>;

export function fetchAccountProfile(opts: AccountProfileReadOptions & { projection: 'self' }): Promise<AccountSelfProfileV1>;
export function fetchAccountProfile(opts: AccountProfileReadOptions & { projection?: 'full' }): Promise<AccountProfileResponse>;
export function fetchAccountProfile(opts: AccountProfileReadOptions & { projection?: 'full' | 'self' }): Promise<AccountProfileResponse | AccountSelfProfileV1>;
export async function fetchAccountProfile(opts: AccountProfileReadOptions & { projection?: 'full' | 'self' }): Promise<AccountProfileResponse | AccountSelfProfileV1> {
    const authorization = opts.authorizeRequest
        ? opts.authorizeRequest({ method: 'GET', path: '/v1/account/profile' })
        : { Authorization: `Bearer ${opts.token}` };
    if (!authorization) throw createAuthenticationHttpStatusError(403, 'Account profile authorization unavailable');
    const response = await axios.get(`${resolveServerHttpBaseUrl()}/v1/account/profile`, {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorization, 'Content-Type': 'application/json' },
        timeout: 15_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
        validateStatus: () => true,
    });
    if (isAuthenticationStatus(response.status)) {
        const failure = projectHomeAuthorizationHttpFailure(response.status, authorization, response.data);
        // The shared projector attaches a cause only to an actual signed request.
        // Keep ordinary bearer recovery while retaining the signed Action refusal.
        if (failure.failureCause) {
            throw Object.assign(createHttpStatusError(response.status, failure.error, failure.errorCode), {
                details: failure.details, failureCause: failure.failureCause,
            });
        }
        throw createAuthenticationHttpStatusError(response.status, `Authentication failed while fetching account profile (${response.status})`, response.data);
    }
    if (response.status < 200 || response.status >= 300) {
        const upgrade = response.status === CLIENT_UPGRADE_REQUIRED_HTTP_STATUS
            ? readCliClientUpgradeRequired(response.data) : null;
        if (upgrade) {
            throw Object.assign(createHttpStatusError(response.status, 'Account profile requires a client upgrade', upgrade.error), {
                data: upgrade,
            });
        }
        throw createHttpStatusError(response.status, `Failed to fetch account profile (${response.status})`);
    }
    return opts.projection === 'self'
        ? AccountSelfProfileV1Schema.parse(response.data)
        : AccountProfileResponseSchema.parse(response.data);
}
