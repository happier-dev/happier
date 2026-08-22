import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import { AccountProfileResponseSchema, type AccountProfileResponse } from '@happier-dev/protocol';

import { createAuthenticationHttpStatusError, createHttpStatusError, isAuthenticationStatus } from './client/httpStatusError';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';

export async function fetchAccountProfile(opts: Readonly<{ token: string; signal?: AbortSignal }>): Promise<AccountProfileResponse> {
    const response = await axios.get(`${resolveServerHttpBaseUrl()}/v1/account/profile`, {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
        timeout: 15_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
        validateStatus: () => true,
    });
    if (isAuthenticationStatus(response.status)) {
        throw createAuthenticationHttpStatusError(response.status, `Authentication failed while fetching account profile (${response.status})`);
    }
    if (response.status < 200 || response.status >= 300) {
        throw createHttpStatusError(response.status, `Failed to fetch account profile (${response.status})`);
    }
    return AccountProfileResponseSchema.parse(response.data);
}
