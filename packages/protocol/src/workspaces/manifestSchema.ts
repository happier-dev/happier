import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const WorkspaceManifestRelativePathSchema = lazyZodSchema(() => z
  .string().check(z.minLength(1), z.refine((value) => !value.startsWith('/') && !value.startsWith('\\') && !/^[a-zA-Z]:[\\/]/.test(value), {
    message: 'Workspace manifest paths must be relative',
  }), z.refine((value) => value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'), {
      message: 'Workspace manifest paths must stay within the workspace root',
    })));

export const WorkspaceManifestEntryKindSchema = lazyZodSchema(() => z.enum(['directory', 'file', 'symlink']));
export type WorkspaceManifestEntryKind = z.infer<typeof WorkspaceManifestEntryKindSchema>;

const WorkspaceManifestDirectoryEntrySchema = lazyZodSchema(() => z.strictObject({
    relativePath: WorkspaceManifestRelativePathSchema,
    kind: z.literal('directory'),
  }));

const WorkspaceManifestFileEntrySchema = lazyZodSchema(() => z.strictObject({
    relativePath: WorkspaceManifestRelativePathSchema,
    kind: z.literal('file'),
    digest: z.string().check(z.minLength(1)),
    sizeBytes: z.number().check(z.int(), z.nonnegative()),
    executable: z.boolean(),
  }));

const WorkspaceManifestSymlinkEntrySchema = lazyZodSchema(() => z.strictObject({
    relativePath: WorkspaceManifestRelativePathSchema,
    kind: z.literal('symlink'),
    target: z.string().check(z.minLength(1)),
  }));

export const WorkspaceManifestEntrySchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  WorkspaceManifestDirectoryEntrySchema,
  WorkspaceManifestFileEntrySchema,
  WorkspaceManifestSymlinkEntrySchema,
]));
export type WorkspaceManifestEntry = z.infer<typeof WorkspaceManifestEntrySchema>;

export const WorkspaceManifestFingerprintSchema = lazyZodSchema(() => z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/)));
export type WorkspaceManifestFingerprint = z.infer<typeof WorkspaceManifestFingerprintSchema>;

export const WorkspaceManifestSchema = lazyZodSchema(() => z.strictObject({
    entries: z.array(WorkspaceManifestEntrySchema),
    fingerprint: z.optional(WorkspaceManifestFingerprintSchema),
  }));
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;
