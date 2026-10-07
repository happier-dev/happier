import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';

import { encodeBase64 } from '../../crypto/base64.js';

const textEncoder = new TextEncoder();

export const SESSION_CREATION_TAG_V1_PREFIX = 'create:v1:' as const;

/**
 * Public durable identity for one logical Session creation. The host derives
 * its namespace and never accepts a final server tag from callers.
 */
export const SessionCreationKeyV1Schema = z.string().trim().min(1)
  .brand<'SessionCreationKeyV1'>();
export type SessionCreationKeyV1 = z.infer<typeof SessionCreationKeyV1Schema>;

const SessionCreationNamespaceV1Schema = z.string().trim().min(1);

export const SessionCreationTagV1Schema = z.string().regex(
  /^create:v1:[A-Za-z0-9_-]{43}$/u,
  'Session creation tags must be canonical opaque V1 SHA-256 identifiers.',
).brand<'SessionCreationTagV1'>();
export type SessionCreationTagV1 = z.infer<typeof SessionCreationTagV1Schema>;

/**
 * Produces the sole persisted Session tag from a host-owned caller namespace
 * and one validated public creation key. The raw key remains out of server
 * indexes, logs, and API payloads.
 */
export function deriveSessionCreationTagV1(params: Readonly<{
  callerCreationNamespace: string;
  creationKey: string;
}>): SessionCreationTagV1 {
  const namespace = SessionCreationNamespaceV1Schema.parse(
    params.callerCreationNamespace,
  );
  const creationKey = SessionCreationKeyV1Schema.parse(params.creationKey);
  const digest = encodeBase64(
    sha256(textEncoder.encode(`${namespace}\0${creationKey}`)),
    'base64url',
  );
  return SessionCreationTagV1Schema.parse(
    `${SESSION_CREATION_TAG_V1_PREFIX}${digest}`,
  );
}
