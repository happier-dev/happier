import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { ActionOperationProgressPhaseV1Schema } from './progressV1.js';

/** Finite process settlement facts only; command bodies, environment and output never enter this carrier. */
export const FiniteCommandFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('finiteCommand'),
  phase: ActionOperationProgressPhaseV1Schema,
  step: z.optional(z.number().check(z.int(), z.gte(0))),
  exitCode: z.nullable(z.number().check(z.int())),
  signal: z.nullable(z.number().check(z.int())),
}));
export type FiniteCommandFailureDetailsV1 = Readonly<z.infer<typeof FiniteCommandFailureDetailsV1Schema>>;

/** The finite failure code and its closed scalar DTO travel together across receivers. */
export function readFiniteCommandFailureDetailsV1(errorCode: unknown, details: unknown): FiniteCommandFailureDetailsV1 | undefined {
  if (errorCode !== 'project_setup_step_failed') return undefined;
  const parsed = FiniteCommandFailureDetailsV1Schema.safeParse(details);
  return parsed.success ? parsed.data : undefined;
}
