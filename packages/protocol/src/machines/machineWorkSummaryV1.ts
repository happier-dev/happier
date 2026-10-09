import * as z from 'zod/mini';

import { lazyDefinition } from '../lazyZodSchema.js';
import { createProtocolComposableSchema, ProtocolValidationError } from '../plugins/actions/protocolComposableSchema.js';
import { MachineCustodianV1Schema, MachineAccessRefusalV1Schema, MachineTargetV1Schema } from './machineAccessV1.js';
import { WorkerLoadObservationV1Schema } from '../workspaces/projectWorkerExecutionV1.js';

/**
 * Content-free work summary wire epoch V1, independent of package SemVer.
 * Both object boundaries are closed; unavailable carries no inferred counts.
 * Requester counts come only from managed live-work inventory; finite load
 * comes separately from the incumbent Project admission owner.
 */
export const MachineWorkSummaryV1Schema = lazyDefinition(() => {
  const count = z.number().check(z.int(), z.nonnegative());
  const requester = z.readonly(z.strictObject({
    ...MachineCustodianV1Schema.shape,
    sessions: count,
    tasks: count,
    terminals: count,
  }));
  return z.readonly(z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('current'),
      requesters: z.readonly(z.array(requester)),
      // Older producers omit this advisory field; absence never means zero.
      finiteLoad: z.optional(WorkerLoadObservationV1Schema),
    }),
    z.strictObject({ kind: z.literal('unavailable') }),
  ]));
});

export type MachineWorkSummaryV1 = z.infer<typeof MachineWorkSummaryV1Schema>;

export const MachineWorkSummaryGetInputV1Schema = MachineTargetV1Schema;
const machineWorkSummaryGetResultSchema = lazyDefinition(() => z.union([
  MachineWorkSummaryV1Schema, MachineAccessRefusalV1Schema,
]));

/** Neutral Action projection of the same content-free result parser. */
export const MachineWorkSummaryGetResultV1Schema = lazyDefinition(() => createProtocolComposableSchema<
  z.input<typeof machineWorkSummaryGetResultSchema>, z.output<typeof machineWorkSummaryGetResultSchema>
>(
  { ...z.toJSONSchema(machineWorkSummaryGetResultSchema, {
    target: 'draft-7', io: 'input',
    // Readonly freezes the admitted value; its JSON annotation is not an
    // admission constraint in the neutral Protocol vocabulary.
    override: ({ jsonSchema }) => { delete jsonSchema.readOnly; },
  }) },
  value => {
    const parsed = machineWorkSummaryGetResultSchema.safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : {
      success: false,
      error: new ProtocolValidationError(parsed.error.issues.map(issue => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'),
      }))),
    };
  },
));
export type MachineWorkSummaryGetInputV1 = z.infer<typeof MachineWorkSummaryGetInputV1Schema>;
export type MachineWorkSummaryGetResultV1 = z.infer<typeof machineWorkSummaryGetResultSchema>;
