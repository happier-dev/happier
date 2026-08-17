import { sha256 } from '@noble/hashes/sha2';

import { encodeBase64 } from '../../crypto/base64.js';
import { SessionCreationTagV1Schema } from '../creation/sessionCreationIdentityV1.js';
import { SessionIdSchema } from '../idsV1.js';
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
 * The Message-owned first-input identity for a canonical Session creation.
 * It deliberately follows the durable creation tag rather than the transport
 * retry nonce, while retaining the exact target Session namespace.
 */
export function buildSessionSpawnInitialInputLocalIdV1(params: Readonly<{
  sessionId: string;
  sessionCreationTag: string;
}>): string {
  const sessionId = SessionIdSchema.parse(params.sessionId);
  const sessionCreationTag = SessionCreationTagV1Schema.parse(params.sessionCreationTag);
  const idempotencyKey = `session-create-initial:v1:${sessionCreationTag}`;
  const canonicalIdentity = JSON.stringify([
    SESSION_INPUT_LOCAL_ID_DOMAIN_V1,
    1,
    `${SESSION_SPAWN_INITIAL_NAMESPACE_PREFIX_V1}${sessionCreationTag}`,
    sessionId,
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
