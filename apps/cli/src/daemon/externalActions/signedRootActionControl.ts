import { ExternalActionRequestIdV1Schema, PublicActionIdSchema } from '@happier-dev/protocol';
import { z } from 'zod';

export const SIGNED_ROOT_ACTION_EXECUTE_PATH = '/actions/root/execute';
export const SignedRootActionExecuteRequestSchema = z.object({
  actionId: PublicActionIdSchema,
  input: z.unknown(),
  targetMachineId: z.string().trim().min(1).optional(),
  // Request identities reuse the one Protocol-owned schema the external Action
  // envelope enforces downstream; no local grammar may trim or rewrite them.
  actionRequestId: ExternalActionRequestIdV1Schema.optional(),
}).strict();
export type SignedRootActionExecuteRequest = z.infer<
  typeof SignedRootActionExecuteRequestSchema
>;
