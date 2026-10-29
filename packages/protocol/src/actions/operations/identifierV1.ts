import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const ACTION_OPERATION_IDENTIFIER_MAX_LENGTH_V1 = 2_000;
export const ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 = ACTION_OPERATION_IDENTIFIER_MAX_LENGTH_V1;
export const ActionOperationIdentifierV1Schema = lazyZodSchema(() => z.string().check(
  z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_IDENTIFIER_MAX_LENGTH_V1),
));
