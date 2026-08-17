import { z } from 'zod';

import {
  decodeBase64,
  encodeBase64,
  readCanonicalPaddedBase64DecodedLength,
} from '../crypto/base64.js';
import {
  OpenableContentClassV1Schema,
  normalizeOpenableContentExactMimeTypeV1 as normalizedExactMimeType,
  normalizeOpenableContentExtensionV1 as normalizedExtension,
} from './openableContentViewerV1.js';

export {
  OpenableContentClassV1Schema,
  OpenableContentPreferenceSelectorV1Schema,
  OpenableContentViewerIdentityV1Schema,
  OpenableContentViewerSelectorV1Schema,
  PluginOpenableContentViewerContributionV1Schema,
  compareOpenableContentViewerMatchesV1,
  matchOpenableContentViewerV1,
  normalizeOpenableContentPreferenceSelectorV1,
  normalizeOpenableContentPreferenceSelectorsV1,
  normalizeOpenableContentViewerSelectorV1,
  parseOpenableContentPreferenceSelectorV1,
  parseOpenableContentViewerIdentityV1,
  serializeOpenableContentPreferenceSelectorV1,
} from './openableContentViewerV1.js';
export type {
  OpenableContentClassV1,
  OpenableContentMetadataV1,
  OpenableContentPreferenceSelectorV1,
  OpenableContentViewerIdentityV1,
  OpenableContentViewerMatchV1,
  OpenableContentViewerSelectorV1,
  PluginOpenableContentViewerContributionV1,
  QualifiedOpenableContentViewerMatchV1,
} from './openableContentViewerV1.js';

export const DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1 = 256 * 1024;
export const HARD_OPENABLE_CONTENT_MAX_BYTES_V1 = 10_000_000;

const OPAQUE_WORKSPACE_FILE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MAX_OPENABLE_CONTENT_REVISION_LENGTH_V1 = 256;
const MAX_OPENABLE_CONTENT_BASE64_CHARS_V1 = Math.ceil(HARD_OPENABLE_CONTENT_MAX_BYTES_V1 / 3) * 4;

function normalizeWithSchemaError(
  value: string,
  context: z.RefinementCtx,
  normalize: (value: string) => string,
  message: string,
): string | typeof z.NEVER {
  try {
    return normalize(value);
  } catch {
    context.addIssue({ code: 'custom', message });
    return z.NEVER;
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isCanonicalBase64WithinOpenableContentHardLimit(value: string): boolean {
  const decodedLength = readCanonicalPaddedBase64DecodedLength(value);
  if (decodedLength === null || decodedLength > HARD_OPENABLE_CONTENT_MAX_BYTES_V1) return false;
  try {
    return encodeBase64(decodeBase64(value, 'base64'), 'base64') === value;
  } catch {
    return false;
  }
}

export const OpenableContentRefV1Schema = z.object({
  kind: z.literal('workspaceFile'),
  handle: z.string().min(1).max(256).regex(
    OPAQUE_WORKSPACE_FILE_HANDLE,
    'Openable workspace-file handles must be opaque URL-safe tokens.',
  ),
}).strict();
export type OpenableContentRefV1 = z.infer<typeof OpenableContentRefV1Schema>;

/** Public stat input for one exact opaque openable-content reference. */
export const OpenableContentStatRequestV1Schema = z.object({
  ref: OpenableContentRefV1Schema,
}).strict();
export type OpenableContentStatRequestV1 = z.infer<typeof OpenableContentStatRequestV1Schema>;

/** Canonical host-observed revision, never a filesystem path or editor hash. */
export const OpenableContentRevisionV1Schema = z.string().trim().min(1).max(MAX_OPENABLE_CONTENT_REVISION_LENGTH_V1);
export type OpenableContentRevisionV1 = z.infer<typeof OpenableContentRevisionV1Schema>;

/** Normalized, exact MIME metadata returned only by the host workspace owner. */
export const OpenableContentMimeTypeV1Schema = z.string().min(1).max(256).transform((value, context) => (
  normalizeWithSchemaError(
    value,
    context,
    normalizedExactMimeType,
    'Openable content MIME metadata must be a normalized exact MIME type.',
  )
));
export type OpenableContentMimeTypeV1 = z.output<typeof OpenableContentMimeTypeV1Schema>;

/** Normalized filename extension metadata; it is never a path segment. */
export const OpenableContentExtensionV1Schema = z.string().min(1).max(256).transform((value, context) => (
  normalizeWithSchemaError(
    value,
    context,
    normalizedExtension,
    'Openable content extension metadata must be a normalized extension.',
  )
));
export type OpenableContentExtensionV1 = z.output<typeof OpenableContentExtensionV1Schema>;

/**
 * The only JSON-safe content representations. Byte arrays intentionally never
 * cross this public UI host boundary.
 */
export const OpenableContentBodyV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('utf8'),
    text: z.string().superRefine((value, context) => {
      if (utf8ByteLength(value) > HARD_OPENABLE_CONTENT_MAX_BYTES_V1) {
        context.addIssue({
          code: 'custom',
          message: 'Openable UTF-8 content exceeds the hard byte limit.',
        });
      }
    }),
  }).strict(),
  z.object({
    kind: z.literal('base64'),
    base64: z.string().max(MAX_OPENABLE_CONTENT_BASE64_CHARS_V1).refine(
      isCanonicalBase64WithinOpenableContentHardLimit,
      'Openable binary content must be canonical base64 within the hard byte limit.',
    ),
  }).strict(),
]);
export type OpenableContentBodyV1 = z.infer<typeof OpenableContentBodyV1Schema>;

/**
 * Public read input. `maxBytes` defaults at the canonical owner, then remains
 * bounded by the immutable hard ceiling; mounted viewers cannot increase it.
 */
export const OpenableContentReadRequestV1Schema = z.object({
  ref: OpenableContentRefV1Schema,
  expectedRevision: OpenableContentRevisionV1Schema,
  maxBytes: z.number()
    .int()
    .min(1)
    .max(HARD_OPENABLE_CONTENT_MAX_BYTES_V1)
    .default(DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1),
}).strict();
export type OpenableContentReadRequestV1 = z.output<typeof OpenableContentReadRequestV1Schema>;
export type OpenableContentReadRequestInputV1 = z.input<typeof OpenableContentReadRequestV1Schema>;

export const OpenableContentStatResultV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    mimeType: OpenableContentMimeTypeV1Schema,
    contentClass: OpenableContentClassV1Schema,
    extension: OpenableContentExtensionV1Schema.optional(),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    revision: OpenableContentRevisionV1Schema,
  }).strict(),
  z.object({ status: z.enum(['unavailable', 'unsupported', 'cancelled']) }).strict(),
]);
export type OpenableContentStatResultV1 = z.infer<typeof OpenableContentStatResultV1Schema>;
export type OpenableContentStatReadyV1 = Extract<OpenableContentStatResultV1, { status: 'ready' }>;

export const OpenableContentReadResultV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    content: OpenableContentBodyV1Schema,
    revision: OpenableContentRevisionV1Schema,
  }).strict(),
  z.object({
    status: z.literal('tooLarge'),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({ status: z.enum(['unavailable', 'changed', 'unsupported', 'cancelled']) }).strict(),
]);
export type OpenableContentReadResultV1 = z.infer<typeof OpenableContentReadResultV1Schema>;
export type OpenableContentReadReadyV1 = Extract<OpenableContentReadResultV1, { status: 'ready' }>;
