import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/**
 * Host-authored control lifecycle for one exact Execution Run occurrence.
 *
 * `current` means a process-local controller currently owns the Run.
 * `recoverable` means the existing resume owner can reopen the Run without a
 * new prompt. `recoverable_with_input` is the bounded counterpart: recovery
 * must be coupled to the next input so it cannot create an idle bounded Run.
 */
export const ExecutionRunLifecycleV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  state: z.enum([
    'current',
    'recovering',
    'recoverable',
    'recoverable_with_input',
    'unavailable',
  ]),
}));

export type ExecutionRunLifecycleV1 = z.infer<typeof ExecutionRunLifecycleV1Schema>;
