import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { decodeBase64, readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';

/**
 * The Team-logo admission contract.
 *
 * A Team logo is submitted as inline bytes and published by the server. The
 * client never supplies a blob path, a width, or a thumbhash: those are outputs
 * of the media owner, and accepting them would make blob custody and rendered
 * geometry caller-controlled.
 *
 * The released shared `ImageRef` output shape is deliberately not tightened to
 * express this input. `ImageRef` is what the server publishes; this is what a
 * caller may send, and the two have different trust.
 */

/**
 * The formats the existing image processor accepts today. Widening this set is
 * a decision for that owner — it needs a decoder measurement and a re-encode
 * path per format — so the Team boundary inherits the established pair rather
 * than promising the native picker's full output.
 */
export const TEAM_LOGO_ACCEPTED_MIME_TYPES_V1 = ['image/png', 'image/jpeg'] as const;
export const TeamLogoMimeTypeV1Schema = lazyZodSchema(() => z.enum(TEAM_LOGO_ACCEPTED_MIME_TYPES_V1));
export type TeamLogoMimeTypeV1 = z.infer<typeof TeamLogoMimeTypeV1Schema>;

/**
 * The decoded source-byte budget.
 *
 * The protected resource is the image decoder, not the transport: the shared
 * `SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1` ceiling is two orders of
 * magnitude larger and exists for bulk request producers. A quality-encoded
 * 12-megapixel photograph — the realistic worst case a native picker hands us
 * — is a few megabytes, so 8 MiB admits genuine picker output with headroom
 * while keeping a single upload far from the decoder's memory budget.
 */
export const TEAM_LOGO_MAX_SOURCE_BYTES_V1 = 8 * 1024 * 1024;

/**
 * The decoder pixel budget, expressed as its actual cost: the processor decodes
 * to raw RGBA at 4 bytes per pixel, so this bound is a 64 MiB working set. It is
 * an independent bound because a compressed byte count says nothing about
 * decoded size — a decompression-bomb PNG is small on the wire and enormous in
 * memory, and only this bound stops it before any pixel is allocated.
 */
export const TEAM_LOGO_MAX_SOURCE_PIXELS_V1 = (64 * 1024 * 1024) / 4;

/**
 * The published square edge. The largest surface that renders a Team logo is
 * the Team header at roughly 128 pt, which is 384 px on a 3× display; 512 keeps
 * headroom for that without publishing an original-resolution photograph as a
 * Team's branding.
 */
export const TEAM_LOGO_PUBLISHED_EDGE_V1 = 512;

/** Base64 inflates by 4/3 and pads to a multiple of four. */
export const TEAM_LOGO_MAX_SOURCE_BASE64_LENGTH_V1 = Math.ceil(TEAM_LOGO_MAX_SOURCE_BYTES_V1 / 3) * 4;

/**
 * The route body limit: a maximal base64 payload plus the small JSON envelope
 * that carries it. It narrows the shared transport ceiling for this one route
 * so an oversized upload is refused by the transport rather than buffered.
 */
export const TEAM_LOGO_REQUEST_MAX_BODY_BYTES_V1 = TEAM_LOGO_MAX_SOURCE_BASE64_LENGTH_V1 + 4096;

export const TeamLogoSourceV1Schema = lazyZodSchema(() => z.object({
  mimeType: TeamLogoMimeTypeV1Schema,
  dataBase64: z.string().min(1).max(TEAM_LOGO_MAX_SOURCE_BASE64_LENGTH_V1),
}).strict());
export type TeamLogoSourceV1 = z.infer<typeof TeamLogoSourceV1Schema>;

/** `teams.logo.set`. The UI picker and the CLI file adapter produce this same input. */
export const TeamLogoSetInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: z.string().min(1).max(64),
  image: TeamLogoSourceV1Schema,
}).strict());
export type TeamLogoSetInputV1 = z.infer<typeof TeamLogoSetInputV1Schema>;

export type TeamLogoSourceDecodeV1 =
  | Readonly<{ status: 'ok'; bytes: Uint8Array; mimeType: TeamLogoMimeTypeV1 }>
  | Readonly<{ status: 'invalid'; reason: 'malformed' | 'too_large' }>;

/**
 * Decodes the payload strictly.
 *
 * The shared decoder is deliberately lenient — it strips stray characters so
 * incidental whitespace cannot break an ordinary read. That is wrong here: at a
 * media boundary a payload that is not canonical base64 is a malformed upload,
 * not one to silently repair into different bytes than the caller sent.
 */
export function decodeTeamLogoSourceV1(source: TeamLogoSourceV1): TeamLogoSourceDecodeV1 {
  const decodedLength = readCanonicalPaddedBase64DecodedLength(source.dataBase64);
  if (decodedLength === null || decodedLength === 0) return { status: 'invalid', reason: 'malformed' };
  if (decodedLength > TEAM_LOGO_MAX_SOURCE_BYTES_V1) return { status: 'invalid', reason: 'too_large' };
  return { status: 'ok', bytes: decodeBase64(source.dataBase64, 'base64'), mimeType: source.mimeType };
}
