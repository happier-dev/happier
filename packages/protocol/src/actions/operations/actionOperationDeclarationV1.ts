import { z } from 'zod';

export const ActionOperationDeclarationV1Schema = z
  .object({
    version: z.literal(1),
    visibility: z.literal('activity'),
    progress: z.enum(['indeterminate', 'reported']),
  })
  .strict();

export type ActionOperationDeclarationV1 = z.infer<typeof ActionOperationDeclarationV1Schema>;
