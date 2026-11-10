import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { MachinePublishedRowWireV1Schema, type MachinePublishedRowV1 } from './machineContentKeyTransitionV1.js';

export type MachineReadBatchRequestV1 = Readonly<{ machineIds: string[] }>;
export type MachineReadBatchResultV1 =
  | Readonly<{ machineId: string; status: 'found'; machine: MachinePublishedRowV1 }>
  | Readonly<{ machineId: string; status: 'not_found' }>;
export type MachineReadBatchResponseV1 = Readonly<{ results: MachineReadBatchResultV1[] }>;

/** Physical batching of exact reads; each ID retains the exact reader's admission. */
export const MachineReadBatchRequestV1Schema: z.ZodMiniType<MachineReadBatchRequestV1> = lazyZodSchema(() => z.strictObject({
  machineIds: z.array(z.string().check(z.minLength(1))),
}));

export const MachineReadBatchResultV1Schema: z.ZodMiniType<MachineReadBatchResultV1> = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ machineId: z.string().check(z.minLength(1)), status: z.literal('found'), machine: MachinePublishedRowWireV1Schema }),
  // Absence and unavailable access are indistinguishable, as on the exact GET.
  z.strictObject({ machineId: z.string().check(z.minLength(1)), status: z.literal('not_found') }),
]));
export const MachineReadBatchResponseV1Schema: z.ZodMiniType<MachineReadBatchResponseV1> = lazyZodSchema(() => z.strictObject({
  results: z.array(MachineReadBatchResultV1Schema),
}));
