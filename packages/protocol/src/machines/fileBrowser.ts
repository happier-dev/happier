import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const MachineFileBrowserRootSchema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  path: z.string().min(1),
}).passthrough());
export type MachineFileBrowserRoot = z.infer<typeof MachineFileBrowserRootSchema>;

export const MachineFileBrowserDirectoryEntrySchema = lazyZodSchema(() => z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  type: z.enum(['file', 'directory', 'other']),
  size: z.number().int().nonnegative().optional(),
  modified: z.number().int().nonnegative().optional(),
  gitIgnored: z.boolean().optional(),
}).passthrough());
export type MachineFileBrowserDirectoryEntry = z.infer<typeof MachineFileBrowserDirectoryEntrySchema>;

export const DaemonFilesystemListRootsResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    roots: z.array(MachineFileBrowserRootSchema),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1),
    errorCode: z.string().min(1).optional(),
  }).passthrough(),
]));
export type DaemonFilesystemListRootsResponse = z.infer<typeof DaemonFilesystemListRootsResponseSchema>;

export const DaemonFilesystemListDirectoryRequestSchema = lazyZodSchema(() => z.object({
  path: z.string().min(1),
  includeFiles: z.boolean().optional(),
  includeGitIgnore: z.boolean().optional(),
  maxEntries: z.number().int().positive().nullable().optional(),
}).passthrough());
export type DaemonFilesystemListDirectoryRequest = z.infer<typeof DaemonFilesystemListDirectoryRequestSchema>;

export const DaemonFilesystemListDirectoryResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    path: z.string().min(1),
    entries: z.array(MachineFileBrowserDirectoryEntrySchema),
    truncated: z.boolean(),
    gitIgnoreAvailable: z.boolean().optional(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1),
    errorCode: z.string().min(1).optional(),
  }).passthrough(),
]));
export type DaemonFilesystemListDirectoryResponse = z.infer<typeof DaemonFilesystemListDirectoryResponseSchema>;
