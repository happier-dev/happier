import axios from 'axios';
import { ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1, AccountApiTokenEncryptionAccessResponseV1Schema, AccountApiTokensServerErrorV1Schema, parseAccountApiTokenBearerV1 } from '@happier-dev/protocol/auth/accountApiTokens';

import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export type AccountServerPatEncryptionAccessReader = (
  token: string, signal?: AbortSignal,
) => Promise<Readonly<{ statusCode: number; body: unknown }>>;

/** Home owns token currentness and wrapping; the daemon only forwards the opaque PAT-self record. */
export function createAccountServerPatEncryptionAccessReader(options: Readonly<{
  accountId: string; serverBaseUrl: string;
}>): AccountServerPatEncryptionAccessReader {
  const url = `${normalizeServerHttpBaseUrl(options.serverBaseUrl)}${ACCOUNT_API_TOKEN_ENCRYPTION_ACCESS_HTTP_PATH_V1}`;
  return async (token, signal) => {
    const bearer = parseAccountApiTokenBearerV1(token);
    if (!bearer) return { statusCode: 401, body: { error: 'invalid_token' } };
    try {
      signal?.throwIfAborted();
      const response = await axios.post<unknown>(url, {}, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(signal ? { signal } : {}), validateStatus: () => true,
      });
      signal?.throwIfAborted();
      const parsed = AccountApiTokenEncryptionAccessResponseV1Schema.safeParse(response.data);
      if (response.status === 200 && parsed.success && parsed.data.accountId === options.accountId
        && parsed.data.tokenId === bearer.tokenId) return { statusCode: 200, body: parsed.data };
      if (response.status === 401) return { statusCode: 401, body: { error: 'invalid_token' } };
      const failure = AccountApiTokensServerErrorV1Schema.safeParse(response.data);
      if ((response.status === 403 || response.status === 409) && failure.success) {
        return { statusCode: response.status, body: failure.data };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return { statusCode: 503, body: { error: 'auth_unavailable' } };
  };
}
