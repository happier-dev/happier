import { z } from '../zodRuntimePolicy.js';
import { getMachineMetadataFieldV1, readMachineMetadataFieldV1, mutateMachineMetadataFieldV1,
  type MachineMetadataFieldPortV1, type MachineMetadataFieldReadV1 } from './machineMetadataFieldV1.js';

import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

// Action input/output inference consumes the classic schema at this public seam.
export const MachineFinitePolicyV1Schema = lazyZodSchema(() => z.strictObject({
  accepting: z.boolean(),
  runAtMost: z.nullable(z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER))),
}));
export type MachineFinitePolicyV1 = z.infer<typeof MachineFinitePolicyV1Schema>;
export const MachineFinitePolicyV1StoredSchema = createStoredReadSchema(MachineFinitePolicyV1Schema);

export const MachineFinitePolicyMutationV1Schema = lazyZodSchema(() => z.strictObject({
  expectedPolicy: MachineFinitePolicyV1Schema,
  expectedMetadataVersion: z.number().check(z.int(), z.nonnegative()),
  policy: MachineFinitePolicyV1Schema,
}));
export type MachineFinitePolicyMutationV1 = z.infer<typeof MachineFinitePolicyMutationV1Schema>;

export const MachineFinitePolicyGetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ready'), policy: MachineFinitePolicyV1Schema,
    source: z.enum(['default', 'stored']), metadataVersion: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.enum(['locked', 'invalid', 'unavailable']) }),
]));
export type MachineFinitePolicyGetResultV1 = z.infer<typeof MachineFinitePolicyGetResultV1Schema>;

export const MachineFinitePolicyMutationResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['applied', 'satisfied', 'unchanged', 'conflict']),
    policy: MachineFinitePolicyV1Schema, metadataVersion: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.enum(['outcomeUnknown', 'cancelled', 'locked', 'invalid', 'unavailable']) }),
]));
export type MachineFinitePolicyMutationResultV1 = z.infer<typeof MachineFinitePolicyMutationResultV1Schema>;

export type MachineFinitePolicyMetadataReadV1 = MachineMetadataFieldReadV1;
export type MachineFinitePolicyMetadataPortV1 = MachineMetadataFieldPortV1;

const definition = {
  field: 'finitePolicyV1', storedSchema: MachineFinitePolicyV1StoredSchema,
  defaultValue: (): MachineFinitePolicyV1 => ({ accepting: true, runAtMost: null }),
  equal: (left: MachineFinitePolicyV1, right: MachineFinitePolicyV1) =>
    left.accepting === right.accepting && left.runAtMost === right.runAtMost,
};
export function readMachineFinitePolicyV1(openedMetadata: unknown) {
  return readMachineMetadataFieldV1(openedMetadata, definition);
}
export async function getMachineFinitePolicyV1(port: MachineFinitePolicyMetadataPortV1): Promise<MachineFinitePolicyGetResultV1> {
  return getMachineMetadataFieldV1(port, definition);
}
/** Compare only policy semantics; unrelated metadata contention rebases through the incumbent CAS. */
export async function mutateMachineFinitePolicyV1(
  input: unknown,
  port: MachineFinitePolicyMetadataPortV1,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<MachineFinitePolicyMutationResultV1> {
  const parsed = MachineFinitePolicyMutationV1Schema.safeParse(input);
  if (!parsed.success) return { status: 'invalid' };
  return mutateMachineMetadataFieldV1({ ...parsed.data, comparison: 'field' }, port, definition, options);
}
