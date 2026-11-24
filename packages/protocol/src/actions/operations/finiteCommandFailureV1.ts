import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineSetupOperationReferenceV1Schema } from '../../machines/setup/machineSetupOperationV1.js';
import { z } from '../../zodRuntimePolicy.js';
import { ActionOperationAddressV1Schema } from './addressV1.js';
import { ActionOperationIdentifierV1Schema } from './identifierV1.js';
import { ActionOperationProgressPhaseV1Schema } from './progressV1.js';

/** Finite process settlement and retained output references. */
export const FiniteCommandFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('finiteCommand'),
  phase: ActionOperationProgressPhaseV1Schema,
  step: z.optional(z.number().check(z.int(), z.gte(0))),
  exitCode: z.nullable(z.number().check(z.int())),
  signal: z.nullable(z.number().check(z.int())),
  failedSetupOperation: z.optional(z.extend(ActionOperationAddressV1Schema, {
    terminalId: z.optional(ActionOperationIdentifierV1Schema),
  })),
  // Combined receiver Setup already carries its parent recovery receipt here.
  setupOperation: z.optional(MachineSetupOperationReferenceV1Schema),
}));
export type FiniteCommandFailureDetailsV1 = Readonly<z.infer<typeof FiniteCommandFailureDetailsV1Schema>>;

/** The finite failure code and its closed details travel together across receivers. */
export function readFiniteCommandFailureDetailsV1(errorCode: unknown, details: unknown): FiniteCommandFailureDetailsV1 | undefined {
  if (errorCode !== 'project_setup_step_failed') return undefined;
  const parsed = FiniteCommandFailureDetailsV1Schema.safeParse(details);
  return parsed.success ? parsed.data : undefined;
}
