import { isLegacyHomeAccountToken } from '@/auth/context/credentialAuthority';
import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { authGetTokenAtEndpoint } from '@/auth/flows/getToken';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import {
  TokenStorage,
  isLegacyAuthCredentials,
  type AuthCredentials,
  type LegacyAuthCredentials,
} from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { parseToken } from '@/utils/auth/parseToken';

/** The Home the stored credential belongs to, captured before any request. */
export type LegacyHomeCredentialExchangeTarget = Readonly<{
  serverUrl: string;
  serverId: string;
  runtimeOrigin?: string;
  homeCarrier?: HomeCarrier;
}>;

// One attempt per Home and stored credential for this app process: a refusal or an
// unreachable Home is not retried until the next launch, and a success is never repeated.
const attempts = new Map<string, Promise<boolean>>();

/**
 * Quietly replace a released 0.2 Home bearer with a current signed-provenance one,
 * proven with the Account key this device already stores (key-challenge v2, existing
 * Account only). Any failure keeps the stored 0.2 credential: it still serves ordinary
 * Home routes, so nobody is signed out. Resolves true once the replacement is stored.
 */
export function exchangeLegacyHomeCredentialOnce(
  target: LegacyHomeCredentialExchangeTarget,
  credentials: AuthCredentials,
): Promise<boolean> {
  if (
    !isLegacyAuthCredentials(credentials) ||
    !isLegacyHomeAccountToken(credentials.token)
  )
    return Promise.resolve(false);
  const key = `${target.serverId}\u0000${resolveAuthCredentialsScopeKey(credentials)}`;
  let attempt = attempts.get(key);
  if (!attempt) {
    attempt = exchange(target, credentials).catch(() => false);
    attempts.set(key, attempt);
  }
  return attempt;
}

async function exchange(
  target: LegacyHomeCredentialExchangeTarget,
  credentials: LegacyAuthCredentials,
): Promise<boolean> {
  const accountId = parseToken(credentials.token);
  const secret = decodeBase64(credentials.secret, 'base64url');
  try {
    if (secret.length !== 32) return false;
    const home = resolveHomeAuthenticationTarget({
      kind: 'saved_profile',
      profileRef: target.serverId,
    });
    const issued = await authGetTokenAtEndpoint({
      ...(home ?? {
        endpointUrl: target.serverUrl,
        canonicalServerUrl: target.serverUrl,
      }),
      serverId: target.serverId,
      ...(target.runtimeOrigin ? { runtimeOrigin: target.runtimeOrigin } : {}),
      ...(target.homeCarrier ? { homeCarrier: target.homeCarrier } : {}),
      secret,
      expectedAccountId: accountId,
      requireExistingAccount: true,
      requireKeyChallengeV2: true,
    });
    if (parseToken(issued.token) !== accountId) return false;
    // Same Account, same key and custody: only the bearer changes, and only while this
    // Home still holds the credential the exchange started from.
    return await TokenStorage.setCredentialsForServerUrl(
      target.serverUrl,
      {
        serverId: target.serverId,
        expectedCredentials: credentials,
        preserveHistoricalEncryption: true,
      },
      { ...credentials, token: issued.token },
    );
  } finally {
    secret.fill(0);
  }
}
