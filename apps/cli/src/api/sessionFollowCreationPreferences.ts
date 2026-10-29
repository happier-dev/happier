import axios from '@/api/client/credentialAxios';
import { SessionAutoFollowPreferencesResponseSchema, SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/** A Session host captures only its owning Account's operational creation choice. */
export function createSessionRunReportPolicyReader(input: Readonly<{
  serverId: string; serverHttpBaseUrl: string; accountId: string;
  readCredentials: () => Promise<StoredCredentials | null>;
  isCurrent: () => boolean | Promise<boolean>;
}>): (signal?: AbortSignal) => Promise<FollowPolicyV1> {
  const unavailable = () => Object.assign(new Error('Run report preferences are unavailable'), { code: 'execution_run_not_allowed' });
  const baseUrl = normalizeServerHttpBaseUrl(input.serverHttpBaseUrl);
  return async signal => {
    signal?.throwIfAborted();
    if (!await input.isCurrent()) throw unavailable();
    const credentials = await input.readCredentials();
    const scope = credentials?.requesterSessionCredentialScope;
    if (!credentials || readAccountIdFromToken(credentials.token) !== input.accountId
      || scope && (scope.serverId !== input.serverId || normalizeServerHttpBaseUrl(scope.serverHttpBaseUrl) !== baseUrl)) throw unavailable();
    const response = await axios.get<unknown>(`${baseUrl}${SESSION_FOLLOW_HTTP_PATHS_V1.preferences}`, {
      headers: { Authorization: `Bearer ${credentials.token}` }, ...(signal ? { signal } : {}), validateStatus: () => true,
    });
    const parsed = SessionAutoFollowPreferencesResponseSchema.safeParse(response.data);
    // An old/malformed response or a failed read is unavailable, never Important.
    if (response.status !== 200 || !parsed.success || !parsed.data.runReportPolicy
      || !await input.isCurrent() || (await input.readCredentials())?.token !== credentials.token) throw unavailable();
    return parsed.data.runReportPolicy;
  };
}
