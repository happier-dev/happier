import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

import type { ScopedRpcSessionEncryptionContext } from './serverScopedRpcTypes';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

export type ResolvedServerSessionRpcContext =
  | Readonly<{ scope: 'active'; timeoutMs: number }>
  | Readonly<{
      scope: 'scoped';
      timeoutMs: number;
      targetServerId: string;
      targetServerUrl: string;
      token: string;
      encryption: ScopedRpcSessionEncryptionContext;
    }>;

export async function resolveServerScopedSessionContext(params: Readonly<{ serverId?: string | null; timeoutMs?: number }>): Promise<ResolvedServerSessionRpcContext> {
  const targetServerId = normalizeId(params.serverId);
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
  const activeSnapshot = getActiveServerSnapshot();

  if (!targetServerId || targetServerId === normalizeId(activeSnapshot.serverId)) {
    return { scope: 'active', timeoutMs };
  }

  const profiles = listServerProfiles();
  const targetProfile = profiles.find((profile) => normalizeId(profile.id) === targetServerId) ?? null;
  if (!targetProfile) {
    throw new Error(`Target server profile not found for serverId "${targetServerId}"`);
  }

  const activeUrlKey = createServerUrlComparableKey(activeSnapshot.serverUrl);
  const targetUrlKey = createServerUrlComparableKey(targetProfile.serverUrl);
  if (activeUrlKey && targetUrlKey && activeUrlKey === targetUrlKey) {
    return { scope: 'active', timeoutMs };
  }

  const credentials = await TokenStorage.getCredentialsForServerUrl(targetProfile.serverUrl);
  if (!credentials) {
    throw new Error(`No authentication credentials for target server "${targetServerId}"`);
  }

  const encryption = (await createEncryptionFromAuthCredentials(credentials)) as ScopedRpcSessionEncryptionContext;
  return {
    scope: 'scoped',
    timeoutMs,
    targetServerId,
    targetServerUrl: targetProfile.serverUrl,
    token: credentials.token,
    encryption,
  };
}
