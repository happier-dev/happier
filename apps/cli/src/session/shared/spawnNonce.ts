import { randomUUID } from 'node:crypto';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import { hashStableJsonIdentity } from '@/utils/stableJsonIdentity';

export function normalizeSpawnNonce(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function createStableSpawnNonce(namespace: string, identity: unknown): string {
  const normalizedNamespace = namespace.trim();
  if (!normalizedNamespace) {
    throw new Error('Spawn nonce namespace is required');
  }
  return `${normalizedNamespace}:${hashStableJsonIdentity(identity)}`;
}

export function createRandomSpawnNonce(namespace: string): string {
  const normalizedNamespace = namespace.trim();
  if (!normalizedNamespace) {
    throw new Error('Spawn nonce namespace is required');
  }
  return `${normalizedNamespace}:${randomUUID()}`;
}

export function isAmbiguousSpawnSessionFailure(
  result: SpawnSessionResult,
): result is Extract<SpawnSessionResult, { type: 'error' }> {
  return result.type === 'error' && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT;
}
