import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { ExternalSessionsRpcErrorCodeSchema } from './rpcErrorCodes.js';

export const ExternalSessionTakeoverRequestSchema = lazyZodSchema(() => z.looseObject({
    machineId: z.string().check(z.minLength(1)),
    sessionId: z.string().check(z.minLength(1)),
    forceStop: z.optional(z.boolean()),
  }));
export type ExternalSessionTakeoverRequest = z.infer<typeof ExternalSessionTakeoverRequestSchema>;

export const ExternalSessionTakeoverResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true) }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().check(z.minLength(1)),
    }),
]));
export type ExternalSessionTakeoverResponse = z.infer<typeof ExternalSessionTakeoverResponseSchema>;

export const ExternalSessionTakeoverPersistRequestSchema = lazyZodSchema(() => z.looseObject({
    machineId: z.string().check(z.minLength(1)),
    sessionId: z.string().check(z.minLength(1)),
    forceStop: z.optional(z.boolean()),
  }));
export type ExternalSessionTakeoverPersistRequest = z.infer<typeof ExternalSessionTakeoverPersistRequestSchema>;

export const ExternalSessionTakeoverPersistResponseSchema = lazyZodSchema(() => z.union([
  z.looseObject({ ok: z.literal(true), converted: z.optional(z.boolean()) }),
  z.looseObject({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().check(z.minLength(1)),
    }),
]));
export type ExternalSessionTakeoverPersistResponse = z.infer<typeof ExternalSessionTakeoverPersistResponseSchema>;
