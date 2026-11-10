import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { FilesystemEffectFailureDetailsV1Schema } from './filesystemFailure.js';

export const MachineFileBrowserRootSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1)),
  label: z.string().check(z.minLength(1)),
  path: z.string().check(z.minLength(1)),
}));
export type MachineFileBrowserRoot = z.infer<typeof MachineFileBrowserRootSchema>;

export const MachineFileBrowserDirectoryEntrySchema = lazyZodSchema(() => z.looseObject({
  name: z.string().check(z.minLength(1)),
  path: z.string().check(z.minLength(1)),
  type: z.enum(['file', 'directory', 'other']),
  size: z.optional(z.number().check(z.int(), z.nonnegative())),
  modified: z.optional(z.number().check(z.int(), z.nonnegative())),
  gitIgnored: z.optional(z.boolean()),
}));
export type MachineFileBrowserDirectoryEntry = z.infer<typeof MachineFileBrowserDirectoryEntrySchema>;

export const DaemonFilesystemListRootsResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.looseObject({
    ok: z.literal(true),
    roots: z.array(MachineFileBrowserRootSchema),
  }),
  z.looseObject({
    ok: z.literal(false),
    error: z.string().check(z.minLength(1)),
    errorCode: z.optional(z.string().check(z.minLength(1))),
    details: z.optional(FilesystemEffectFailureDetailsV1Schema),
  }),
]));
export type DaemonFilesystemListRootsResponse = z.infer<typeof DaemonFilesystemListRootsResponseSchema>;

export const DaemonFilesystemListDirectoryRequestSchema = lazyZodSchema(() => z.looseObject({
  path: z.string().check(z.minLength(1)),
  includeFiles: z.optional(z.boolean()),
  includeGitIgnore: z.optional(z.boolean()),
  maxEntries: z.optional(z.nullable(z.number().check(z.int(), z.positive()))),
}));
export type DaemonFilesystemListDirectoryRequest = z.infer<typeof DaemonFilesystemListDirectoryRequestSchema>;

export const DaemonFilesystemListDirectoryResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.looseObject({
    ok: z.literal(true),
    path: z.string().check(z.minLength(1)),
    entries: z.array(MachineFileBrowserDirectoryEntrySchema),
    truncated: z.boolean(),
    gitIgnoreAvailable: z.optional(z.boolean()),
  }),
  z.looseObject({
    ok: z.literal(false),
    error: z.string().check(z.minLength(1)),
    errorCode: z.optional(z.string().check(z.minLength(1))),
    details: z.optional(FilesystemEffectFailureDetailsV1Schema),
  }),
]));
export type DaemonFilesystemListDirectoryResponse = z.infer<typeof DaemonFilesystemListDirectoryResponseSchema>;
