import { createHash } from 'node:crypto';

import type { ConnectedServiceId } from '@happier-dev/protocol';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';

const QUOTA_PERSISTENCE_KEY_PREFIX = 'connected-service-quota';
const UNKNOWN_SCOPE = 'unknown';

export type QuotaPersistenceAccountScope =
  | Readonly<{ kind: 'known'; value: string }>
  | Readonly<{ kind: 'unknown' }>;

function normalizeScope(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : UNKNOWN_SCOPE;
}

export function hashQuotaPersistenceScope(value: string | null | undefined): string {
  return createHash('sha256')
    .update(normalizeScope(value), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function normalizeAccountScope(value: string | QuotaPersistenceAccountScope | null | undefined): string {
  if (value && typeof value === 'object') {
    return value.kind === 'known' ? normalizeScope(value.value) : UNKNOWN_SCOPE;
  }
  return normalizeScope(value);
}

export function resolveQuotaPersistenceAccountScope(
  credentials?: Readonly<{ token?: string | null }>,
): QuotaPersistenceAccountScope {
  const normalizedToken = String(credentials?.token ?? '').trim();
  if (!normalizedToken) return { kind: 'unknown' };

  const payload = decodeJwtPayload(normalizedToken);
  const sub = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  if (sub) return { kind: 'known', value: `sub-${hashQuotaPersistenceScope(sub)}` };

  return { kind: 'known', value: `token-${hashQuotaPersistenceScope(normalizedToken)}` };
}

export function buildQuotaPersistenceKey(input: Readonly<{
  serverScope: string | null | undefined;
  accountScope: string | QuotaPersistenceAccountScope | null | undefined;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): string {
  return [
    QUOTA_PERSISTENCE_KEY_PREFIX,
    hashQuotaPersistenceScope(input.serverScope),
    hashQuotaPersistenceScope(normalizeAccountScope(input.accountScope)),
    hashQuotaPersistenceScope(input.serviceId),
    hashQuotaPersistenceScope(input.profileId),
  ].join(':');
}
