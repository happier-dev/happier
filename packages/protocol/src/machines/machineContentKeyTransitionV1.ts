import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

/** The key carrier and both revisions identify the complete incumbent content. */
export const MachineKeyBasisV1Schema = lazySchema(() => z.object({
  dataEncryptionKey: z.string().min(1).nullable(),
  metadataVersion: z.number().int().nonnegative(),
  daemonStateVersion: z.number().int().nonnegative(),
}).strict());
export type MachineKeyBasisV1 = z.infer<typeof MachineKeyBasisV1Schema>;

export const MachineContentKeyTransitionInputV1Schema = lazySchema(() => z.object({
  machineId: z.string().min(1),
  expected: MachineKeyBasisV1Schema,
  next: z.object({
    dataEncryptionKey: z.string().min(1),
    metadata: z.string(),
    daemonState: z.string().nullable(),
  }).strict(),
}).strict());
export type MachineContentKeyTransitionInputV1 = z.infer<typeof MachineContentKeyTransitionInputV1Schema>;

export const MachineContentKeyTransitionRefusalV1Schema = lazySchema(() => z.object({
  kind: z.literal('refused'),
  code: z.enum(['forbidden', 'machine_unavailable', 'machine_storage_mode_mismatch', 'encryption_material_unavailable']),
}).strict());

export type MachineContentKeyTransitionResultV1<PublishedMachineRow> =
  | Readonly<{ kind: 'committed'; machine: PublishedMachineRow }>
  | Readonly<{ kind: 'conflict'; current: MachineKeyBasisV1 }>
  | z.infer<typeof MachineContentKeyTransitionRefusalV1Schema>;

export function createMachineContentKeyTransitionResultV1Schema<T extends z.ZodType>(machineSchema: T) {
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('committed'), machine: machineSchema }).strict(),
    z.object({ kind: z.literal('conflict'), current: MachineKeyBasisV1Schema }).strict(),
    MachineContentKeyTransitionRefusalV1Schema,
  ]);
}
