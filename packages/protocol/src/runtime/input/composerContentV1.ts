import { z } from 'zod';

import {
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../../plugins/contributionIdentity.js';
import { SessionExecutionTargetV1Schema } from '../../sessions/creation/sessionSpawnNewResultV1.js';
import {
  SESSION_MEDIA_IMAGE_MIME_TYPES_V1,
  SESSION_MEDIA_MIME_TYPES_V1,
  SESSION_MEDIA_VIDEO_MIME_TYPES_V1,
} from '../../sessions/messages/sessionMediaV1.js';
import { DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1 } from '../../plugins/openableContent.js';
import { readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

/** Type-only public projection; content schemas keep their plain JSON runtime values. */
type DeepReadonly<T> = T extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

/** The one negotiated operation required before media selection, staging, or submission. */
export const COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 = 'composer.mediaContent.v1' as const;
export type ComposerMediaContentCapabilityV1 = typeof COMPOSER_MEDIA_CONTENT_CAPABILITY_V1;
export const ComposerMediaContentCapabilityV1Schema = z.literal(COMPOSER_MEDIA_CONTENT_CAPABILITY_V1);

/** One bounded inspection reuses the incumbent UI content-read ceiling. */
export const MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 = DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1;

export const COMPOSER_CONTENT_MEDIA_KINDS_V1 = ['image', 'video'] as const;
export const ComposerContentMediaKindV1Schema = z.enum(COMPOSER_CONTENT_MEDIA_KINDS_V1);
export type ComposerContentMediaKindV1 = z.infer<typeof ComposerContentMediaKindV1Schema>;

export const ComposerContentMimeTypeV1Schema = z.enum(SESSION_MEDIA_MIME_TYPES_V1);
export type ComposerContentMimeTypeV1 = z.infer<typeof ComposerContentMimeTypeV1Schema>;

const ComposerContentOpaqueIdV1Schema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u, 'Composer content identities must be opaque URL-safe identifiers.');

export const ComposerContentDisplayNameV1Schema = z.string()
  .trim()
  .min(1)
  .max(255)
  .superRefine((value, context) => {
    if (value === '.' || value === '..' || /[\\/]/u.test(value) || /^(?:data|file|https?|blob):/iu.test(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Composer content display names must not contain a path or URI.',
      });
    }
  });
export type ComposerContentDisplayNameV1 = z.infer<typeof ComposerContentDisplayNameV1Schema>;

/**
 * A target- and contribution-bound claim for completed transfer-owned staged
 * media. It intentionally contains metadata only: source paths, bytes, and
 * transfer-session state remain with their incumbent owners.
 */
export const ComposerContentHandleV1Schema = z.object({
  v: z.literal(1),
  id: ComposerContentOpaqueIdV1Schema,
  executionTarget: SessionExecutionTargetV1Schema,
  owner: asProtocolZod(PluginContributionIdentityV1Schema),
  mediaKind: ComposerContentMediaKindV1Schema,
  mimeType: ComposerContentMimeTypeV1Schema,
  name: ComposerContentDisplayNameV1Schema,
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/iu, 'Composer content digests must be SHA-256 hex.'),
}).strict().superRefine((value, context) => {
  if (value.mediaKind === 'image' && !(SESSION_MEDIA_IMAGE_MIME_TYPES_V1 as readonly string[]).includes(value.mimeType)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mimeType'],
      message: 'Composer image content MIME type is unsupported.',
    });
  }
  if (value.mediaKind === 'video' && !(SESSION_MEDIA_VIDEO_MIME_TYPES_V1 as readonly string[]).includes(value.mimeType)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mimeType'],
      message: 'Composer video content MIME type is unsupported.',
    });
  }
});
export type ComposerContentHandleV1 = DeepReadonly<z.infer<typeof ComposerContentHandleV1Schema>>;

/** Draft-only content: the target daemon still owns the staged media. */
export const ComposerStagedMediaContentV1Schema = z.object({
  kind: z.literal('stagedMedia'),
  handle: ComposerContentHandleV1Schema,
}).strict();
export type ComposerStagedMediaContentV1 = DeepReadonly<z.infer<typeof ComposerStagedMediaContentV1Schema>>;

/** Admitted-only content: SessionMedia owns the durable media bytes and metadata. */
export const ComposerSessionMediaContentV1Schema = z.object({
  kind: z.literal('sessionMedia'),
  mediaId: ComposerContentOpaqueIdV1Schema,
}).strict();
export type ComposerSessionMediaContentV1 = DeepReadonly<z.infer<typeof ComposerSessionMediaContentV1Schema>>;

/** A mounted Composer contributor may choose only its own declared attachment id and supported media kinds. */
export const ComposerContentPickMediaRequestV1Schema = z.object({
  attachmentLocalId: z.string().trim().min(1).max(256),
  kinds: z.array(ComposerContentMediaKindV1Schema).min(1).max(COMPOSER_CONTENT_MEDIA_KINDS_V1.length)
    .superRefine((kinds, context) => {
      if (new Set(kinds).size !== kinds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Composer media kinds must not repeat.',
        });
      }
    }),
}).strict();
export type ComposerContentPickMediaRequestV1 = DeepReadonly<z.infer<typeof ComposerContentPickMediaRequestV1Schema>>;

/** A one-shot bounded inspection; it is not a public transfer-session or chunk protocol. */
export const ComposerContentInspectRequestV1Schema = z.object({
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxBytes: z.number().int().positive().max(MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1),
}).strict();
export type ComposerContentInspectRequestV1 = DeepReadonly<z.infer<typeof ComposerContentInspectRequestV1Schema>>;

const MAX_COMPOSER_CONTENT_INSPECT_BASE64_CHARS_V1 = Math.ceil(MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1 / 3) * 4;

/** JSON-safe wire result. The SDK decodes it to bytes without exposing a transfer identity. */
export const ComposerContentInspectWireResultV1Schema = z.object({
  offset: ComposerContentInspectRequestV1Schema.shape.offset,
  bytesBase64: z.string().max(MAX_COMPOSER_CONTENT_INSPECT_BASE64_CHARS_V1).superRefine((value, context) => {
    const decodedLength = readCanonicalPaddedBase64DecodedLength(value);
    if (decodedLength === null || decodedLength > MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Composer content inspection bytes must be canonical base64 within the inspection limit.',
      });
    }
  }),
  eof: z.boolean(),
}).strict();
export type ComposerContentInspectWireResultV1 = DeepReadonly<
  z.infer<typeof ComposerContentInspectWireResultV1Schema>
>;

/** Re-exported structural owner type for SDK declarations without a second identity shape. */
export type ComposerContentOwnerV1 = DeepReadonly<PluginContributionIdentityV1>;
