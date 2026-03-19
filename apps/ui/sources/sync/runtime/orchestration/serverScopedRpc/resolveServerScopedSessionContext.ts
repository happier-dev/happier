import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

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

async function buildScopedContext(params: Readonly<{
  serverId: string;
  serverUrl: string;
  timeoutMs: number;
}>): Promise<Extract<ResolvedServerSessionRpcContext, { scope: 'scoped' }>> {
  const credentials = await TokenStorage.getCredentialsForServerUrl(params.serverUrl, { serverId: params.serverId });
  if (!credentials) {
    throw new Error(`No authentication credentials for target server "${params.serverId}"`);
  }

  const encryption = (await createEncryptionFromAuthCredentials(credentials)) as ScopedRpcSessionEncryptionContext;
  return {
    scope: 'scoped',
    timeoutMs: params.timeoutMs,
    targetServerId: params.serverId,
    targetServerUrl: params.serverUrl,
    token: credentials.token,
    encryption,
  };
}

export async function resolveServerScopedSessionContext(params: Readonly<{
  serverId?: string | null;
  timeoutMs?: number;
  preferScoped?: boolean;
}>): Promise<ResolvedServerSessionRpcContext> {
  const targetServerId = normalizeId(params.serverId);
  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
  const activeSnapshot = getActiveServerSnapshot();

  if (!targetServerId || targetServerId === normalizeId(activeSnapshot.serverId)) {
    if (params.preferScoped === true) {
      return await buildScopedContext({
        serverId: normalizeId(activeSnapshot.serverId),
        serverUrl: activeSnapshot.serverUrl,
        timeoutMs,
      });
    }
    return { scope: 'active', timeoutMs };
  }

  const profiles = listServerProfiles();
  const targetProfile = profiles.find((profile) => normalizeId(profile.id) === targetServerId) ?? null;
  if (!targetProfile) {
    throw new Error(`Target server profile not found for serverId "${targetServerId}"`);
  }

  return await buildScopedContext({
    serverId: targetServerId,
    serverUrl: targetProfile.serverUrl,
    timeoutMs,
  });
}
