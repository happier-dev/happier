import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/** Exact creator-authored workspace policy for a Temporary Computer endpoint. */
export const TemporaryComputerWorkspaceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('choose_on_endpoint') }),
  z.strictObject({ kind: z.literal('endpoint_home') }),
]));
export type TemporaryComputerWorkspaceV1 = z.infer<typeof TemporaryComputerWorkspaceV1Schema>;
