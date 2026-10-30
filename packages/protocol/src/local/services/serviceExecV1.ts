import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { WorkflowMachineCommandOutputV1Schema } from '../../workflows/commandOutputV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const literalArgument = () => z.string().check(z.refine(value => !value.includes('\0'), 'Arguments cannot contain NUL'));
const argv = () => z.array(literalArgument()).check(z.minLength(1),
  z.refine(value => value[0] !== '', 'The executable argument cannot be empty'));
const machine = () => ({ serverId: id(), machineId: id(), argv: argv() });

/** Native host authority comes only from the selected admitted owner. */
export const MachineServiceExecInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ...machine(),
    target: z.strictObject({ kind: z.literal('current'), serviceId: id(), expectedGeneration: id() }),
    mode: z.enum(['exec', 'run']),
  }),
  z.strictObject({
    ...machine(),
    target: z.strictObject({ kind: z.literal('candidate'), deploymentId: id(), service: id() }),
    mode: z.literal('run'),
  }),
]));
export type MachineServiceExecInputV1 = z.infer<typeof MachineServiceExecInputV1Schema>;

/** A dispatched command with no authoritative exit must never look successful. */
export const MachineServiceExecResultV1Schema = lazyZodSchema(() => z.union([
  WorkflowMachineCommandOutputV1Schema,
  z.strictObject({ kind: z.literal('outcome_unknown') }),
]));
export type MachineServiceExecResultV1 = z.infer<typeof MachineServiceExecResultV1Schema>;
