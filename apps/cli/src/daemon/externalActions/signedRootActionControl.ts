import { PublicActionIdSchema } from '@happier-dev/protocol';
import { z } from 'zod';

export const SIGNED_ROOT_ACTION_EXECUTE_PATH = '/actions/root/execute';
export const SignedRootActionExecuteRequestSchema = z.object({
  actionId: PublicActionIdSchema,
  input: z.unknown(),
  targetMachineId: z.string().trim().min(1).optional(),
  actionRequestId: z.string().trim().min(1).optional(),
}).strict();
export type SignedRootActionExecuteRequest = z.infer<
  typeof SignedRootActionExecuteRequestSchema
>;
