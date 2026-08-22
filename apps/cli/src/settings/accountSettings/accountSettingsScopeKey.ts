import { createHash } from 'node:crypto';

import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsCachePath } from './accountSettingsCache';

function tokenScopeKey(token: string): string {
  // Avoid keeping raw access tokens in memory map keys.
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function createAccountSettingsScopeKey(params: Readonly<{
  cachePath: string;
  token: string;
}>): string {
  return `${params.cachePath}::${tokenScopeKey(params.token)}`;
}

/**
 * The one process-local Account lifetime identity shared by settings-backed
 * host consumers that only have the authenticated token available.
 */
export function resolveAccountSettingsScopeKeyForToken(token: string): string {
  return createAccountSettingsScopeKey({
    cachePath: resolveAccountSettingsCachePath({ token }),
    token,
  });
}

export function resolveAccountSettingsScopeKey(credentials: StoredCredentials): string {
  return resolveAccountSettingsScopeKeyForToken(credentials.token);
}
