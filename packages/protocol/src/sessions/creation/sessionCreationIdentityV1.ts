import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';

import { encodeBase64 } from '../../crypto/base64.js';

const textEncoder = new TextEncoder();

export const SESSION_CREATION_TAG_V1_PREFIX = 'create:v1:' as const;
const SESSION_CREATION_KEY_V1_MAX_UTF8_BYTES = 256;
const SESSION_CREATION_NAMESPACE_V1_MAX_UTF8_BYTES = 256;

function boundedTrimmedUtf8String(
  maxUtf8Bytes: number,
  label: string,
) {
  return z.string().trim().min(1).superRefine((value, context) => {
    if (textEncoder.encode(value).byteLength > maxUtf8Bytes) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: maxUtf8Bytes,
        inclusive: true,
        origin: 'string',
        message: `${label} exceeds its UTF-8 byte limit.`,
      });
    }
  });
}

/**
 * Public durable identity for one logical Session creation. The host derives
 * its namespace and never accepts a final server tag from callers.
 */
export const SessionCreationKeyV1Schema = boundedTrimmedUtf8String(
  SESSION_CREATION_KEY_V1_MAX_UTF8_BYTES,
  'Session creation key',
).brand<'SessionCreationKeyV1'>();
export type SessionCreationKeyV1 = z.infer<typeof SessionCreationKeyV1Schema>;

const SessionCreationNamespaceV1Schema = boundedTrimmedUtf8String(
  SESSION_CREATION_NAMESPACE_V1_MAX_UTF8_BYTES,
  'Session creation namespace',
);

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
