import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

const WorkspaceManifestRelativePathSchema = lazySchema(() => z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.startsWith('\\') && !/^[a-zA-Z]:[\\/]/.test(value), {
    message: 'Workspace manifest paths must be relative',
  })
  .refine(
    (value) => value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    {
      message: 'Workspace manifest paths must stay within the workspace root',
    },
  ));

export const WorkspaceManifestEntryKindSchema = lazySchema(() => z.enum(['directory', 'file', 'symlink']));
export type WorkspaceManifestEntryKind = z.infer<typeof WorkspaceManifestEntryKindSchema>;

const WorkspaceManifestDirectoryEntrySchema = lazySchema(() => z
  .object({
    relativePath: WorkspaceManifestRelativePathSchema,
    kind: z.literal('directory'),
  })
  .strict());

const WorkspaceManifestFileEntrySchema = lazySchema(() => z
  .object({
    relativePath: WorkspaceManifestRelativePathSchema,
    kind: z.literal('file'),
    digest: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    executable: z.boolean(),
  })
  .strict());

const WorkspaceManifestSymlinkEntrySchema = lazySchema(() => z
  .object({
    relativePath: WorkspaceManifestRelativePathSchema,
    kind: z.literal('symlink'),
    target: z.string().min(1),
  })
  .strict());

export const WorkspaceManifestEntrySchema = lazySchema(() => z.discriminatedUnion('kind', [
  WorkspaceManifestDirectoryEntrySchema,
  WorkspaceManifestFileEntrySchema,
  WorkspaceManifestSymlinkEntrySchema,
]));
export type WorkspaceManifestEntry = z.infer<typeof WorkspaceManifestEntrySchema>;

export const WorkspaceManifestFingerprintSchema = lazySchema(() => z.string().regex(/^sha256:[a-f0-9]{64}$/));
export type WorkspaceManifestFingerprint = z.infer<typeof WorkspaceManifestFingerprintSchema>;

export const WorkspaceManifestSchema = lazySchema(() => z
  .object({
    entries: z.array(WorkspaceManifestEntrySchema),
    fingerprint: WorkspaceManifestFingerprintSchema.optional(),
  })
  .strict());
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;
