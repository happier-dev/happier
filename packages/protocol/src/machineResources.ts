import { z } from 'zod';

export const MachineResourcesCpuSchema = z.object({
  usagePercent: z.number().min(0).max(100),
}).passthrough();
export type MachineResourcesCpu = z.infer<typeof MachineResourcesCpuSchema>;

export const MachineResourcesMemorySchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  usagePercent: z.number().min(0).max(100),
}).passthrough();
export type MachineResourcesMemory = z.infer<typeof MachineResourcesMemorySchema>;

export const MachineResourcesDiskSchema = z.object({
  path: z.string().min(1),
  totalBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  usagePercent: z.number().min(0).max(100),
}).passthrough();
export type MachineResourcesDisk = z.infer<typeof MachineResourcesDiskSchema>;

export const MachineResourcesSnapshotSchema = z.object({
  sampledAt: z.number().int().nonnegative(),
  cpu: MachineResourcesCpuSchema,
  memory: MachineResourcesMemorySchema,
  disk: MachineResourcesDiskSchema,
}).passthrough();
export type MachineResourcesSnapshot = z.infer<typeof MachineResourcesSnapshotSchema>;

export const DaemonResourcesGetResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    snapshot: MachineResourcesSnapshotSchema,
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1),
    errorCode: z.string().min(1).optional(),
  }).passthrough(),
]);
export type DaemonResourcesGetResponse = z.infer<typeof DaemonResourcesGetResponseSchema>;
