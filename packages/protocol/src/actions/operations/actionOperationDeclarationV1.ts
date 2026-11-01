import { z } from 'zod';
import { lazySchema } from '../../lazySchema.js';

export const ActionOperationDeclarationV1Schema = lazySchema(() => z
  .object({
    version: z.literal(1),
    visibility: z.literal('activity'),
    progress: z.enum(['indeterminate', 'reported']),
  })
  .strict());

export type ActionOperationDeclarationV1 = z.infer<typeof ActionOperationDeclarationV1Schema>;
