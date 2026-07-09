import { URLSearchParams } from 'node:url';

import type { FetchRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import type { ConnectedServiceId } from '@happier-dev/protocol';

import { readSafeOauthProviderErrorCode } from '@/cloud/safeOauthProviderError';
import { mapConnectedAccountOauthPayload } from '@/daemon/connectedServices/descriptors/buildConnectedAccountCredentialRecord';
import { resolveConnectedAccountOauthConfig } from '@/daemon/connectedServices/descriptors/connectedAccountOauthConfig';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';

const CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

export async function refreshConnectedAccountOauthTokens(params: Readonly<{
  serviceId: ConnectedServiceId;
  refreshToken: string;
  now: number;
  runtimeFetch?: FetchRuntimeServiceV1;
}>): Promise<Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  scope: string | null;
  tokenType: string | null;
  expiresAt: number | null;
}>> {
  const config = resolveConnectedAccountOauthConfig({
    serviceId: params.serviceId,
    env: process.env,
    resolveConfidentialClientValue: (resolverKey, envKey, env) => {
      const raw = env[envKey];
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
      throw new Error(`Unsupported connected-service confidential OAuth resolver: ${resolverKey}`);
    },
  });
  const runtimeFetch = params.runtimeFetch ?? createGlobalFetchRuntime();
  const bodyFields: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: config.clientId,
  };
  if (config.confidentialClientValue) {
    bodyFields.client_secret = config.confidentialClientValue;
  }
  const response = await runtimeFetch(
    config.refreshBody === 'json'
      ? {
          url: config.tokenUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyFields),
          signal: AbortSignal.timeout(CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS),
        }
      : {
          url: config.tokenUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(bodyFields),
          signal: AbortSignal.timeout(CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS),
        },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const providerErrorCode = readSafeOauthProviderErrorCode(body);
    const safeError = providerErrorCode ?? response.statusText;
    throw new Error(`Connected account refresh failed (${params.serviceId}, ${response.status}): ${safeError || 'provider_error'}`);
  }
  const json: unknown = await response.json();
  const mapped = mapConnectedAccountOauthPayload({
    descriptor: config.descriptor,
    now: params.now,
    payload: json,
    fallbackRefreshToken: params.refreshToken,
    preserveEmptyOptionalStrings: true,
    allowZeroExpiresIn: true,
  });
  const accessToken = mapped.accessToken.trim();
  if (!accessToken) {
    throw new Error(`Connected account refresh response missing access_token for ${params.serviceId}`);
  }
  return {
    accessToken,
    refreshToken: mapped.refreshToken.trim() ? mapped.refreshToken : params.refreshToken,
    idToken: mapped.idToken,
    scope: mapped.scope,
    tokenType: mapped.tokenType,
    expiresAt: mapped.expiresAt,
  };
}
