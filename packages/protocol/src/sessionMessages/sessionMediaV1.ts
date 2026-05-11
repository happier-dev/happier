import { z } from 'zod';

export const SESSION_MEDIA_MESSAGE_META_KIND_V1 = 'session_media.v1' as const;

const INLINE_SESSION_MEDIA_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

const FORBIDDEN_SESSION_MEDIA_ITEM_KEYS = new Set([
  'data',
  'base64',
  'b64',
  'b64_json',
  'inlineData',
  'url',
  'uri',
  'fileUrl',
  'backendId',
  'summary',
  'summaryPreview',
  'providerSummary',
]);

function rejectForbiddenSessionMediaKeys(
  value: Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (FORBIDDEN_SESSION_MEDIA_ITEM_KEYS.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: childPath,
        message: `Session media metadata must not persist ${key}`,
      });
    }
    if (Array.isArray(child)) {
      child.forEach((item, index) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          rejectForbiddenSessionMediaKeys(item as Record<string, unknown>, ctx, [...childPath, index]);
        }
      });
      continue;
    }
    if (child && typeof child === 'object') {
      rejectForbiddenSessionMediaKeys(child as Record<string, unknown>, ctx, childPath);
    }
  }
}

function createSafeStringSchema(zod: typeof z) {
  return zod.string().trim().min(1);
}

function createSessionMediaPathSchema(zod: typeof z) {
  return zod
    .string()
    .trim()
    .min(1)
    .superRefine((path, ctx) => {
      const lowerPath = path.toLowerCase();
      if (
        path.startsWith('/')
        || path.startsWith('\\')
        || /^[a-z]:[\\/]/i.test(path)
        || /^[a-z][a-z0-9+.-]*:/i.test(path)
        || lowerPath.startsWith('file://')
        || lowerPath.startsWith('data:')
        || lowerPath.startsWith('http://')
        || lowerPath.startsWith('https://')
        || path.includes('\\')
      ) {
        ctx.addIssue({ code: 'custom', message: 'Session media path must be a relative session file path' });
        return;
      }

      const segments = path.split('/');
      if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
        ctx.addIssue({ code: 'custom', message: 'Session media path must not contain empty or traversal segments' });
      }
    });
}

export function createSessionMediaFailureV1Schema(zod: typeof z) {
  const safeString = createSafeStringSchema(zod);
  return zod
    .object({
      index: zod.number().int().nonnegative(),
      code: safeString,
      role: zod.enum(['input', 'output']),
      category: zod.enum(['attachment', 'generated', 'tool-artifact']),
      mediaKind: zod.literal('image'),
      name: safeString,
      mimeType: zod.enum(INLINE_SESSION_MEDIA_IMAGE_MIME_TYPES).optional(),
      origin: createSessionMediaOriginV1Schema(zod),
      createdAtMs: zod.number().int().nonnegative().optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      rejectForbiddenSessionMediaKeys(value, ctx);
    });
}

export function createSessionMediaOriginV1Schema(zod: typeof z) {
  const safeString = createSafeStringSchema(zod);
  return zod
    .object({
      source: zod.enum(['user-upload', 'provider-generated', 'tool-output', 'acp-content', 'mcp-content', 'local-file']),
      agentId: safeString.optional(),
      toolCallId: safeString.optional(),
      generationId: safeString.optional(),
      providerEventId: safeString.optional(),
      providerFileId: safeString.optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      rejectForbiddenSessionMediaKeys(value, ctx);
    });
}

export function createSessionMediaItemV1Schema(zod: typeof z) {
  const safeString = createSafeStringSchema(zod);
  return zod
    .object({
      id: safeString,
      role: zod.enum(['input', 'output']),
      category: zod.enum(['attachment', 'generated', 'tool-artifact']),
      mediaKind: zod.literal('image'),
      mimeType: zod.enum(INLINE_SESSION_MEDIA_IMAGE_MIME_TYPES),
      name: safeString,
      path: createSessionMediaPathSchema(zod),
      sizeBytes: zod.number().int().positive(),
      sha256: zod.string().regex(/^[a-f0-9]{64}$/i).optional(),
      width: zod.number().int().positive().optional(),
      height: zod.number().int().positive().optional(),
      createdAtMs: zod.number().int().nonnegative().optional(),
      origin: createSessionMediaOriginV1Schema(zod),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      rejectForbiddenSessionMediaKeys(value, ctx);
    });
}

export function createSessionMediaMessagePayloadV1Schema(zod: typeof z) {
  return zod
    .object({
      media: zod.array(createSessionMediaItemV1Schema(zod)),
      failures: zod.array(createSessionMediaFailureV1Schema(zod)).optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      if (value.media.length === 0 && (!value.failures || value.failures.length === 0)) {
        ctx.addIssue({
          code: 'custom',
          path: ['media'],
          message: 'Session media metadata must contain media or failures',
        });
      }
      rejectForbiddenSessionMediaKeys(value, ctx);
    });
}

export function createSessionMediaMessageMetaV1Schema(zod: typeof z) {
  return zod
    .object({
      kind: zod.literal(SESSION_MEDIA_MESSAGE_META_KIND_V1),
      payload: createSessionMediaMessagePayloadV1Schema(zod),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      rejectForbiddenSessionMediaKeys(value, ctx);
    });
}

export const SessionMediaOriginV1Schema = createSessionMediaOriginV1Schema(z);
export const SessionMediaFailureV1Schema = createSessionMediaFailureV1Schema(z);
export const SessionMediaItemV1Schema = createSessionMediaItemV1Schema(z);
export const SessionMediaMessagePayloadV1Schema = createSessionMediaMessagePayloadV1Schema(z);
export const SessionMediaMessageMetaV1Schema = createSessionMediaMessageMetaV1Schema(z);

export type SessionMediaOriginV1 = z.infer<typeof SessionMediaOriginV1Schema>;
export type SessionMediaFailureV1 = z.infer<typeof SessionMediaFailureV1Schema>;
export type SessionMediaItemV1 = z.infer<typeof SessionMediaItemV1Schema>;
export type SessionMediaMessagePayloadV1 = z.infer<typeof SessionMediaMessagePayloadV1Schema>;
export type SessionMediaMessageMetaV1 = z.infer<typeof SessionMediaMessageMetaV1Schema>;
