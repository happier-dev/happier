import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_SCOPES } from '@happier-dev/agents';
import { ConnectedServiceImportError } from '@/cloud/connectedServices/connectedServiceImportError';
import { refreshConnectedAccountOauthTokens, ConnectedServiceOauthRefreshError } from '@/daemon/connectedServices/refresh/serviceRefreshers';
import type { AgyAuthTokens } from './authenticate';
import { readAgyNativeCredential } from './nativeCredentials';

export async function importAgyCredentials(options: Readonly<{ source: string; signal?: AbortSignal }>): Promise<AgyAuthTokens> {
  options.signal?.throwIfAborted();
  if (options.source !== 'cli' && options.source !== 'cli-file') throw new ConnectedServiceImportError('unsupported_source', 'Unsupported Antigravity import source');
  const native = await readAgyNativeCredential(options.source, options.signal);
  let accessToken = native.accessToken;
  let refreshToken = native.refreshToken;
  // Explicit user import intent authorizes the refresh an expired native token needs.
  if (!accessToken || (native.expiresAt !== null && native.expiresAt <= Date.now())) {
    try {
      const refreshed = await refreshConnectedAccountOauthTokens({ serviceId: 'antigravity', refreshToken, now: Date.now(), signal: options.signal });
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken;
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new ConnectedServiceImportError(error instanceof ConnectedServiceOauthRefreshError && ['invalid_grant', 'provider_401', 'provider_403'].includes(error.category) ? 'reauthorization_required' : 'provider_error', 'Antigravity native login could not be imported');
    }
  }
  let response: Response;
  let value: unknown;
  try {
    response = await fetch(`https://oauth2.googleapis.com/tokeninfo?${new URLSearchParams({ access_token: accessToken })}`, { signal: options.signal });
    value = response.ok ? await response.json() : null;
  } catch {
    options.signal?.throwIfAborted();
    throw new ConnectedServiceImportError('provider_error', 'Antigravity native login could not be verified');
  }
  if (!response.ok) {
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw new ConnectedServiceImportError(rejected ? 'reauthorization_required' : 'provider_error', 'Antigravity native login could not be verified');
  }
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const scope = typeof data.scope === 'string' ? data.scope.trim() : '';
  const scopes = new Set(scope.split(/\s+/));
  const expiresIn = typeof data.expires_in === 'string' || typeof data.expires_in === 'number' ? Number(data.expires_in) : NaN;
  if (data.azp !== AGY_OAUTH_CLIENT_ID || !Number.isFinite(expiresIn) || expiresIn <= 0 || !AGY_OAUTH_SCOPES.every((required) => scopes.has(required))) {
    throw new ConnectedServiceImportError('reauthorization_required', 'Antigravity native login needs reauthorization');
  }
  return {
    access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: Math.trunc(expiresIn), scope,
    providerAccountId: typeof data.sub === 'string' && data.sub.trim() ? data.sub.trim() : null,
    providerEmail: typeof data.email === 'string' && data.email.trim() ? data.email.trim() : null,
  };
}
