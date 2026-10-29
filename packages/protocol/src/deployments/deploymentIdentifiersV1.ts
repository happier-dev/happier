import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionOperationIdentifierV1Schema } from '../actions/operations/identifierV1.js';

/** Environment/receipt ids fit their actual Action operation domain association. */
export const DeploymentIdentifierV1Schema = ActionOperationIdentifierV1Schema;
export const DeploymentRevisionV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)));
export const DeploymentTimestampV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
