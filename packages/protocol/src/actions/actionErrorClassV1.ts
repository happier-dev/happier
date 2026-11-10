import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** Closed names only: arbitrary exception names can contain private input. */
export const ActionErrorClassV1Schema = lazyZodSchema(() => z.enum([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ZodError', '$ZodError',
  'AxiosError', 'HttpStatusError', 'AbortError', 'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError',
  'PrismaClientValidationError', 'PrismaClientInitializationError', 'TransactionConflictExhaustedError',
  'TransactionAcquisitionUnavailableError', 'TransactionDeadlineExceededError', 'ManagedMachineError',
  'JsonRpcApplicationError', 'ManagedMachineControllerError', 'RpcError', 'UnknownThrownValue',
]));
export type ActionErrorClassV1 = z.infer<typeof ActionErrorClassV1Schema>;

/** An Action producer's typed code is data, not a second vocabulary to maintain. */
export function readActionErrorCodeV1(error: unknown): string | null {
  try {
    if (!error || typeof error !== 'object') return null;
    const record = error as Readonly<Record<string, unknown>>;
    for (const key of ['code', 'errorCode', 'rpcErrorCode']) {
      const code = record[key];
      if (typeof code === 'string' && /^[a-z][a-z0-9_.:-]*$/iu.test(code)) return code;
    }
  } catch { /* A throwing diagnostic accessor cannot replace the Action failure. */ }
  return null;
}
