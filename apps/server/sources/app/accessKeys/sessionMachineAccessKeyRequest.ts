import { z } from 'zod/mini';

/** Ordinary requester-owned Session/Machine control-binding HTTP codec. */
export const SessionMachineAccessKeyParamsSchema = z.object({
    sessionId: z.string(),
    machineId: z.string(),
});

export const SessionMachineAccessKeyCreateBodySchema = z.object({
    data: z.string(),
});
