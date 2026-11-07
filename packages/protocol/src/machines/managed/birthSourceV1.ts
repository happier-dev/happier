import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
export const ManagedMachineBirthSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: id() }),
  z.strictObject({ kind: z.literal('run'), source: z.strictObject({ kind: z.literal('workflow_run'), runId: id() }) }),
]));
export type ManagedMachineBirthSourceV1 = z.infer<typeof ManagedMachineBirthSourceV1Schema>;
export const ManagedMachineBirthResultV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.nullable(ManagedMachineBirthSourceV1Schema),
}));

