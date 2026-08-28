import { sha256 } from '@noble/hashes/sha2';

import { encodeBase64 } from '../../crypto/base64.js';
import { SessionCreationTagV1Schema } from '../creation/sessionCreationIdentityV1.js';
import { readPendingLocalId } from '../pending/pendingLocalId.js';

const textEncoder = new TextEncoder();
const SESSION_INPUT_LOCAL_ID_DOMAIN_V1 = 'happier.session-input.local-id.v1';
const SESSION_SPAWN_INITIAL_NAMESPACE_PREFIX_V1 = 'sessionSpawnInitial:';

export function buildSpawnedFirstTurnLocalId(spawnNonce: unknown): string | null {
  if (typeof spawnNonce !== 'string') return null;
  const normalizedSpawnNonce = spawnNonce.trim();
  return normalizedSpawnNonce.length > 0
    ? `spawn-first-turn:${normalizedSpawnNonce}`
    : null;
}

/**
 * Derives the one Message-owned identity shared by canonical Session-create
 * initial input and the post-create Composer attachment journey. The durable
 * creation tag, rather than a process-attempt nonce, keeps retry identity
 * stable across daemon and UI restarts.
 */
export function buildSessionSpawnInitialInputLocalIdV1(params: Readonly<{
  sessionCreationTag: string;
}>): string {
  const sessionCreationTag = SessionCreationTagV1Schema.parse(params.sessionCreationTag);
  const idempotencyKey = `session-create-initial:v1:${sessionCreationTag}`;
  const canonicalIdentity = JSON.stringify([
    SESSION_INPUT_LOCAL_ID_DOMAIN_V1,
    1,
    `${SESSION_SPAWN_INITIAL_NAMESPACE_PREFIX_V1}${sessionCreationTag}`,
    idempotencyKey,
  ]);
  const localId = readPendingLocalId(
    `plugin-input-v1:${encodeBase64(sha256(textEncoder.encode(canonicalIdentity)), 'base64url')}`,
  );
  if (localId === null) {
    throw new Error('Derived Session spawn initial input local id is invalid');
  }
  return localId;
}
