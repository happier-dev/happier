import { z } from 'zod';

import { BrowserLocalServicePreviewTargetV1Schema } from '../../../browser/target/v1.js';
import { LocalServiceLoopbackHostV1Schema } from '../hosts.js';

export const LocalServicePreviewOwnerV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('session'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('plugin'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('agent'), id: z.string().trim().min(1).max(256) }).strict(),
]);
export type LocalServicePreviewOwnerV1 = z.infer<typeof LocalServicePreviewOwnerV1Schema>;

export const LocalServicePreviewTargetV1Schema = z
  .object({
    scheme: z.enum(['http', 'https']),
    host: LocalServiceLoopbackHostV1Schema,
    port: z.number().int().min(1).max(65_535),
  })
  .strict();
export type LocalServicePreviewTargetV1 = z.infer<typeof LocalServicePreviewTargetV1Schema>;

export const LocalServicePreviewInitialPathV1Schema = z
  .object({
    pathname: z.string().startsWith('/').max(2_048),
    search: z
      .string()
      .max(2_048)
      .refine((value) => value.length === 0 || value.startsWith('?'), {
        message: 'Search must be empty or start with "?".',
      })
      .optional()
      .default(''),
  })
  .strict();
export type LocalServicePreviewInitialPathV1 = z.infer<typeof LocalServicePreviewInitialPathV1Schema>;

export const LocalServicePreviewDisplayV1Schema = z
  .object({
    title: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(256).optional(),
    addressLabel: z.string().trim().min(1).max(256),
    folderLabel: z.string().trim().min(1).max(256).optional(),
    iconToken: z.string().trim().min(1).max(64).optional(),
    tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'accent']).optional(),
    diagnostics: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type LocalServicePreviewDisplayV1 = z.infer<typeof LocalServicePreviewDisplayV1Schema>;

export const LocalServicePreviewPolicyV1Schema = z
  .object({
    allowedMethods: z
      .array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']))
      .min(1)
      .default(['GET', 'HEAD', 'OPTIONS']),
    cookiePolicy: z.enum(['drop', 'isolate', 'rewrite']).default('drop'),
    compressionPolicy: z.enum(['identity', 'decode_reencode']).default('identity'),
    redirectPolicy: z.enum(['preserve_host_origin', 'rewrite_path_mode']).default('preserve_host_origin'),
    maxRequestBodyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxResponseBodyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type LocalServicePreviewPolicyV1 = z.infer<typeof LocalServicePreviewPolicyV1Schema>;

export const LocalServicePreviewOriginModeV1Schema = z.enum(['host', 'path']);
export type LocalServicePreviewOriginModeV1 = z.infer<typeof LocalServicePreviewOriginModeV1Schema>;

export const LocalServicePreviewResourceV1Schema = z
  .object({
    previewId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    machineId: z.string().trim().min(1).max(256),
    owner: LocalServicePreviewOwnerV1Schema,
    target: LocalServicePreviewTargetV1Schema,
    initialPath: LocalServicePreviewInitialPathV1Schema,
    display: LocalServicePreviewDisplayV1Schema,
    originMode: LocalServicePreviewOriginModeV1Schema,
    policy: LocalServicePreviewPolicyV1Schema.optional(),
    browserTarget: BrowserLocalServicePreviewTargetV1Schema.optional(),
  })
  .strict();
export type LocalServicePreviewResourceV1 = z.infer<typeof LocalServicePreviewResourceV1Schema>;

export const LocalServicePreviewTokenV1Schema = z
  .object({
    kind: z.literal('preview_access'),
    tokenId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    machineId: z.string().trim().min(1).max(256),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    exchangeMode: z.enum(['url', 'cookie']),
  })
  .strict();
export type LocalServicePreviewTokenV1 = z.infer<typeof LocalServicePreviewTokenV1Schema>;
