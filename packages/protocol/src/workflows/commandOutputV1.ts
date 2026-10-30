import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** The existing finite command result, shared by host and service commands. */
export const WorkflowMachineCommandOutputV1Schema = lazyZodSchema(() => z.strictObject({
  exitCode: z.number().check(z.int()), stdout: z.string(), stderr: z.string(),
  stdoutTruncated: z.optional(z.boolean()), stderrTruncated: z.optional(z.boolean()),
}));
export type WorkflowMachineCommandOutputV1 = z.infer<typeof WorkflowMachineCommandOutputV1Schema>;

/** Selects finite output retention, not authority or dispatch certainty. */
export function getWorkflowActionOutputKindV1(actionId: string): 'command' | undefined {
  return actionId === 'machines.command.run' || actionId === 'machines.services.exec' ? 'command' : undefined;
}
