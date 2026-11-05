import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

/** Closed names only: arbitrary exception names can contain private input. */
export const ActionErrorClassV1Schema = lazyZodSchema(() => z.enum([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ZodError', '$ZodError',
  'AxiosError', 'HttpStatusError', 'AbortError', 'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError',
  'PrismaClientValidationError', 'PrismaClientInitializationError', 'TransactionConflictExhaustedError',
  'TransactionAcquisitionUnavailableError', 'TransactionDeadlineExceededError', 'ManagedMachineError',
  'JsonRpcApplicationError', 'ManagedMachineControllerError', 'RpcError', 'UnknownThrownValue',
]));
export type ActionErrorClassV1 = z.infer<typeof ActionErrorClassV1Schema>;
