import { z } from 'zod';

import { ExternalSessionsRpcErrorCodeSchema } from './rpcErrorCodes.js';

export const ExternalSessionTakeoverRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    forceStop: z.boolean().optional(),
  })
  .passthrough();
export type ExternalSessionTakeoverRequest = z.infer<typeof ExternalSessionTakeoverRequestSchema>;

export const ExternalSessionTakeoverResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionTakeoverResponse = z.infer<typeof ExternalSessionTakeoverResponseSchema>;

export const ExternalSessionTakeoverPersistRequestSchema = z
  .object({
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    forceStop: z.boolean().optional(),
  })
  .passthrough();
export type ExternalSessionTakeoverPersistRequest = z.infer<typeof ExternalSessionTakeoverPersistRequestSchema>;

export const ExternalSessionTakeoverPersistResponseSchema = z.union([
  z.object({ ok: z.literal(true), converted: z.boolean().optional() }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      errorCode: ExternalSessionsRpcErrorCodeSchema,
      error: z.string().min(1),
    })
    .passthrough(),
]);
export type ExternalSessionTakeoverPersistResponse = z.infer<typeof ExternalSessionTakeoverPersistResponseSchema>;
