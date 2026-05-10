import { createHash } from 'node:crypto';

import type { Credentials } from '@/persistence';
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

export function resolveAccountSettingsScopeKey(credentials: Credentials): string {
  return createAccountSettingsScopeKey({
    cachePath: resolveAccountSettingsCachePath(credentials),
    token: credentials.token,
  });
}
