import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/** Exact creator-authored workspace policy for a Temporary Computer endpoint. */
export const TemporaryComputerWorkspaceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choose_on_endpoint') }).strict(),
  z.object({ kind: z.literal('endpoint_home') }).strict(),
]));
export type TemporaryComputerWorkspaceV1 = z.infer<typeof TemporaryComputerWorkspaceV1Schema>;
