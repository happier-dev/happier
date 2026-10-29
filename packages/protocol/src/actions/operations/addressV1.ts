import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ActionOperationIdentifierV1Schema } from './identifierV1.js';

export const ActionOperationAddressV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.string().check(z.trim(), z.minLength(1)),
  operationId: ActionOperationIdentifierV1Schema,
}));
