import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';

const KeysetCursorPayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  q: z.string().min(1),
  p: z.array(z.union([z.string(), z.number()])).min(1).max(4),
}).strict());

export const KEYSET_CURSOR_MAX_LENGTH_V1 = 512;
const KEYSET_CURSOR_ENCODER = new TextEncoder();
const KEYSET_CURSOR_DECODER = new TextDecoder();

export type KeysetCursorPartV1 = string | number;

export type KeysetCursorPartsDecodeV1 =
  | Readonly<{ status: 'ok'; parts: readonly KeysetCursorPartV1[] }>
  | Readonly<{ status: 'invalid' }>;

/** Bind the complete query without putting its unbounded filters into the cursor. */
function queryBinding(queryKey: string): string {
  return computeCanonicalDomainSeparatedDigest('happier-keyset-cursor-query-v1', [queryKey]);
}

/** The single query-bound keyset cursor codec used by server collection pages. */
export function encodeKeysetCursorV1(input: Readonly<{
  queryKey: string;
  parts: readonly KeysetCursorPartV1[];
}>): string {
  const payload = JSON.stringify({ v: 1, q: queryBinding(input.queryKey), p: input.parts });
  return encodeBase64(KEYSET_CURSOR_ENCODER.encode(payload), 'base64url');
}

export function decodeKeysetCursorV1(value: string, queryKey: string): KeysetCursorPartsDecodeV1 {
  if (value.length === 0 || value.length > KEYSET_CURSOR_MAX_LENGTH_V1) return { status: 'invalid' };
  let candidate: unknown;
  try {
    candidate = JSON.parse(KEYSET_CURSOR_DECODER.decode(decodeBase64(value, 'base64url')));
  } catch {
    return { status: 'invalid' };
  }
  const payload = KeysetCursorPayloadV1Schema.safeParse(candidate);
  if (!payload.success || payload.data.q !== queryBinding(queryKey)) return { status: 'invalid' };
  return { status: 'ok', parts: payload.data.p };
}

export function readKeysetCursorTimeV1(part: KeysetCursorPartV1 | undefined): number | null {
  return typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 ? part : null;
}

export function readKeysetCursorIdV1(part: KeysetCursorPartV1 | undefined): string | null {
  return typeof part === 'string' && part.length > 0 ? part : null;
}

export function readKeysetCursorTextV1(part: KeysetCursorPartV1 | undefined): string | null {
  return typeof part === 'string' ? part : null;
}
