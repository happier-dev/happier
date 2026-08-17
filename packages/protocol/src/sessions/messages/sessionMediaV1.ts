import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';

export const SESSION_MEDIA_MESSAGE_META_KIND_V1 = 'session_media.v1' as const;

export const SESSION_MEDIA_IMAGE_MIME_TYPES_V1 = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export const SESSION_MEDIA_VIDEO_MIME_TYPES_V1 = [
  'video/webm',
] as const;

export const SESSION_MEDIA_MIME_TYPES_V1 = [
  ...SESSION_MEDIA_IMAGE_MIME_TYPES_V1,
  ...SESSION_MEDIA_VIDEO_MIME_TYPES_V1,
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
  'sourcePath',
  'sourceUri',
  'sourceUrl',
  'filePath',
  'localPath',
  'provider',
  'providerId',
  'backendId',
  'summary',
  'summaryPreview',
  'providerSummary',
]);

const FORBIDDEN_SESSION_MEDIA_PASSTHROUGH_KEYS = new Set([
  ...FORBIDDEN_SESSION_MEDIA_ITEM_KEYS,
  'path',
]);

const SESSION_MEDIA_ORIGIN_ROOT_KEYS = new Set([
  'source',
  'agentId',
  'toolCallId',
  'generationId',
  'agentEventId',
  'providerFileId',
]);

const SESSION_MEDIA_FAILURE_ROOT_KEYS = new Set([
  'index',
  'code',
  'role',
  'category',
  'mediaKind',
  'name',
  'mimeType',
  'origin',
  'createdAtMs',
]);

const SESSION_MEDIA_ITEM_ROOT_KEYS = new Set([
  'id',
  'role',
  'category',
  'mediaKind',
  'mimeType',
  'name',
  'path',
  'sizeBytes',
  'sha256',
  'width',
  'height',
  'createdAtMs',
  'origin',
]);

const SESSION_MEDIA_PAYLOAD_ROOT_KEYS = new Set([
  'media',
  'failures',
]);

const SESSION_MEDIA_ENVELOPE_ROOT_KEYS = new Set([
  'kind',
  'payload',
]);

function rejectForbiddenSessionMediaKeys(
  value: Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
  forbiddenKeys: ReadonlySet<string> = FORBIDDEN_SESSION_MEDIA_ITEM_KEYS,
  allowedRootKeys: ReadonlySet<string> = new Set(),
): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const isAllowedRootKey = path.length === 0 && allowedRootKeys.has(key);
    if (isAllowedRootKey) continue;
    if (!isAllowedRootKey && forbiddenKeys.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: childPath,
        message: `Session media metadata must not persist ${key}`,
      });
    }
    if (Array.isArray(child)) {
      child.forEach((item, index) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          rejectForbiddenSessionMediaKeys(
            item as Record<string, unknown>,
            ctx,
            [...childPath, index],
            forbiddenKeys,
            allowedRootKeys,
          );
        }
      });
      continue;
    }
    if (child && typeof child === 'object') {
      rejectForbiddenSessionMediaKeys(
        child as Record<string, unknown>,
        ctx,
        childPath,
        forbiddenKeys,
        allowedRootKeys,
      );
    }
  }
}

function isUnsafePassthroughStringValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isForbiddenSessionMediaEnvPathReference(trimmed)) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-z]:[\\/]/i.test(trimmed)) return true;
  if (/^(?:data|file|https?|blob):/iu.test(trimmed)) return true;
  if (/;base64,/iu.test(trimmed)) return true;
  if (isBase64LikeSessionMediaString(trimmed)) return true;
  return false;
}

function isForbiddenSessionMediaEnvPathReference(value: string): boolean {
  return /^\$(?:HOME|CODEX_HOME)(?:$|[\\/])/u.test(value)
    || /^\$\{(?:HOME|CODEX_HOME)\}(?:$|[\\/])/u.test(value);
}

function isBase64LikeSessionMediaString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 11) return false;
  if (trimmed.includes('.') || /\s/u.test(trimmed)) return false;
  if (!/[A-Z]/u.test(trimmed) || !/[a-z]/u.test(trimmed) || !/[0-9+/_=-]/u.test(trimmed)) return false;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(trimmed)) return false;
  const unpadded = trimmed.replace(/=+$/u, '');
  const normalized = unpadded.replace(/-/gu, '+').replace(/_/gu, '/');
  if (normalized.length % 4 === 1) return false;
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    const decoded = decodeBase64(padded, 'base64');
    if (decoded.byteLength < 8) return false;
    return encodeBase64(decoded, 'base64').replace(/=+$/u, '') === normalized;
  } catch {
    return false;
  }
}

function rejectUnsafePassthroughStringValues(
  value: Readonly<Record<string, unknown>>,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
  allowedRootKeys: ReadonlySet<string> = new Set(),
): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (path.length === 0 && allowedRootKeys.has(key)) continue;

    if (typeof child === 'string') {
      if (isUnsafePassthroughStringValue(child)) {
        ctx.addIssue({
          code: 'custom',
          path: childPath,
          message: `Session media metadata must not persist unsafe string value for ${key}`,
        });
      }
      continue;
    }

    if (Array.isArray(child)) {
      child.forEach((item, index) => {
        if (typeof item === 'string') {
          if (isUnsafePassthroughStringValue(item)) {
            ctx.addIssue({
              code: 'custom',
              path: [...childPath, index],
              message: `Session media metadata must not persist unsafe string value for ${key}`,
            });
          }
          return;
        }
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          rejectUnsafePassthroughStringValues(item as Record<string, unknown>, ctx, [...childPath, index]);
        }
      });
      continue;
    }

    if (child && typeof child === 'object') {
      rejectUnsafePassthroughStringValues(child as Record<string, unknown>, ctx, childPath);
    }
  }
}

function createSafeStringSchema(zod: typeof z) {
  return zod.string().trim().min(1);
}

function createSessionMediaFailureNameSchema(zod: typeof z) {
  return createSafeStringSchema(zod).superRefine((name, ctx) => {
    if (isUnsafePassthroughStringValue(name)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Session media failure name must not persist unsafe source data',
      });
    }
  });
}

function createSessionMediaTrustedStringSchema(zod: typeof z, label: string) {
  return createSafeStringSchema(zod).superRefine((value, ctx) => {
    if (isUnsafePassthroughStringValue(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `Session media ${label} must not persist unsafe source data`,
      });
    }
  });
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
        || isForbiddenSessionMediaEnvPathReference(path)
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

function isInlineSessionMediaImageMimeType(value: string): boolean {
  return (SESSION_MEDIA_IMAGE_MIME_TYPES_V1 as readonly string[]).includes(value);
}

function isReferenceSessionMediaVideoMimeType(value: string): boolean {
  return (SESSION_MEDIA_VIDEO_MIME_TYPES_V1 as readonly string[]).includes(value);
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
      name: createSessionMediaFailureNameSchema(zod),
      mimeType: zod.enum(SESSION_MEDIA_IMAGE_MIME_TYPES_V1).optional(),
      origin: createSessionMediaOriginV1Schema(zod),
      createdAtMs: zod.number().int().nonnegative().optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      rejectForbiddenSessionMediaKeys(value, ctx, [], FORBIDDEN_SESSION_MEDIA_PASSTHROUGH_KEYS, SESSION_MEDIA_FAILURE_ROOT_KEYS);
      rejectUnsafePassthroughStringValues(value, ctx, [], SESSION_MEDIA_FAILURE_ROOT_KEYS);
    });
}

export function createSessionMediaOriginV1Schema(zod: typeof z) {
  const safeIdentifier = createSessionMediaTrustedStringSchema(zod, 'origin identifier');
  return zod
    .object({
      source: zod.enum(['user-upload', 'provider-generated', 'tool-output', 'acp-content', 'mcp-content', 'local-file']),
      agentId: safeIdentifier.optional(),
      toolCallId: safeIdentifier.optional(),
      generationId: safeIdentifier.optional(),
      agentEventId: safeIdentifier.optional(),
      providerFileId: safeIdentifier.optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      rejectForbiddenSessionMediaKeys(value, ctx, [], FORBIDDEN_SESSION_MEDIA_PASSTHROUGH_KEYS, SESSION_MEDIA_ORIGIN_ROOT_KEYS);
      rejectUnsafePassthroughStringValues(value, ctx, [], SESSION_MEDIA_ORIGIN_ROOT_KEYS);
    });
}

export function createSessionMediaItemV1Schema(zod: typeof z) {
  const safeTrustedString = createSessionMediaTrustedStringSchema(zod, 'item identity');
  return zod
    .object({
      id: safeTrustedString,
      role: zod.enum(['input', 'output']),
      category: zod.enum(['attachment', 'generated', 'tool-artifact']),
      mediaKind: zod.enum(['image', 'video']),
      mimeType: zod.enum(SESSION_MEDIA_MIME_TYPES_V1),
      name: safeTrustedString,
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
      if (value.mediaKind === 'image' && !isInlineSessionMediaImageMimeType(value.mimeType)) {
        ctx.addIssue({
          code: 'custom',
          path: ['mimeType'],
          message: 'Session media image MIME type is unsupported',
        });
      }
      if (value.mediaKind === 'video') {
        if (!isReferenceSessionMediaVideoMimeType(value.mimeType)) {
          ctx.addIssue({
            code: 'custom',
            path: ['mimeType'],
            message: 'Session media video MIME type is unsupported',
          });
        }
        if (value.width !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['width'],
            message: 'Session media video metadata must not persist image dimensions',
          });
        }
        if (value.height !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['height'],
            message: 'Session media video metadata must not persist image dimensions',
          });
        }
      }
      rejectForbiddenSessionMediaKeys(value, ctx, [], FORBIDDEN_SESSION_MEDIA_PASSTHROUGH_KEYS, SESSION_MEDIA_ITEM_ROOT_KEYS);
      rejectUnsafePassthroughStringValues(value, ctx, [], SESSION_MEDIA_ITEM_ROOT_KEYS);
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
      rejectForbiddenSessionMediaKeys(value, ctx, [], FORBIDDEN_SESSION_MEDIA_PASSTHROUGH_KEYS, SESSION_MEDIA_PAYLOAD_ROOT_KEYS);
      rejectUnsafePassthroughStringValues(value, ctx, [], SESSION_MEDIA_PAYLOAD_ROOT_KEYS);
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
      rejectForbiddenSessionMediaKeys(value, ctx, [], FORBIDDEN_SESSION_MEDIA_PASSTHROUGH_KEYS, SESSION_MEDIA_ENVELOPE_ROOT_KEYS);
      rejectUnsafePassthroughStringValues(value, ctx, [], SESSION_MEDIA_ENVELOPE_ROOT_KEYS);
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
