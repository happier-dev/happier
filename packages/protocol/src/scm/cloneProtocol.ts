import { z } from 'zod';

export const SourceControlCloneProtocolSchema = z.enum(['auto', 'ssh', 'https']);
export type SourceControlCloneProtocol =
  z.infer<typeof SourceControlCloneProtocolSchema>;
