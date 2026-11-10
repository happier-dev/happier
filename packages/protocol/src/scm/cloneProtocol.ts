import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const SourceControlCloneProtocolSchema = lazyZodSchema(() => z.enum(['auto', 'ssh', 'https']));
export type SourceControlCloneProtocol =
  z.infer<typeof SourceControlCloneProtocolSchema>;
