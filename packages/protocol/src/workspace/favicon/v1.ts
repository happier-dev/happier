import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const WorkspaceFaviconMimeTypeV1Schema = lazyZodSchema(() => z.enum([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'image/x-icon',
]));
export type WorkspaceFaviconMimeTypeV1 = z.infer<typeof WorkspaceFaviconMimeTypeV1Schema>;

export const WorkspaceFaviconResolveRequestV1Schema = lazyZodSchema(() => z.object({
  workspacePath: z.string().check(z.minLength(1)),
}));
export type WorkspaceFaviconResolveRequestV1 = z.infer<typeof WorkspaceFaviconResolveRequestV1Schema>;

export const WorkspaceFaviconResolveResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({
    success: z.literal(true),
    found: z.literal(true),
    relativePath: z.string().check(z.minLength(1)),
    mimeType: WorkspaceFaviconMimeTypeV1Schema,
    contentBase64: z.string().check(z.minLength(1)),
    sizeBytes: z.number().check(z.int(), z.nonnegative()),
    modifiedMs: z.optional(z.number().check(z.nonnegative())),
  }),
  z.object({
    success: z.literal(true),
    found: z.literal(false),
  }),
  z.object({
    success: z.literal(false),
    errorCode: z.string(),
    error: z.string(),
  }),
]));
export type WorkspaceFaviconResolveResponseV1 = z.infer<typeof WorkspaceFaviconResolveResponseV1Schema>;
