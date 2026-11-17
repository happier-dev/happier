import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionExecutionTargetV1Schema } from './sessionExecutionTargetV1.js';

/** The selected folder's origin survives acquisition replacing execution placement. */
export const SessionProjectFilesSourceV1Schema = lazyZodSchema(() => z.strictObject({
  target: SessionExecutionTargetV1Schema,
  directory: z.string().check(z.trim(), z.minLength(1)),
}));
export type SessionProjectFilesSourceV1 = z.infer<typeof SessionProjectFilesSourceV1Schema>;
