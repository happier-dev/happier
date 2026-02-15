import { z } from 'zod';

export const ApiAutomationScheduleSchema = z.object({
    kind: z.enum(['cron', 'interval']),
    scheduleExpr: z.string().nullable(),
    everyMs: z.number().int().nullable(),
    timezone: z.string().nullable(),
}).strict();

export const ApiAutomationAssignmentSchema = z.object({
    machineId: z.string(),
    enabled: z.boolean(),
    priority: z.number().int(),
    updatedAt: z.number().int().nullable(),
}).strict();

export const ApiAutomationSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    enabled: z.boolean(),
    schedule: ApiAutomationScheduleSchema,
    targetType: z.enum(['new_session', 'existing_session']),
    templateCiphertext: z.string(),
    templateVersion: z.number().int(),
    nextRunAt: z.number().int().nullable(),
    lastRunAt: z.number().int().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    assignments: z.array(ApiAutomationAssignmentSchema),
}).strict();

export const ApiAutomationRunSchema = z.object({
    id: z.string(),
    automationId: z.string(),
    state: z.enum(['queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'expired']),
    scheduledAt: z.number().int(),
    dueAt: z.number().int(),
    claimedAt: z.number().int().nullable(),
    startedAt: z.number().int().nullable(),
    finishedAt: z.number().int().nullable(),
    claimedByMachineId: z.string().nullable(),
    leaseExpiresAt: z.number().int().nullable(),
    attempt: z.number().int(),
    summaryCiphertext: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    producedSessionId: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
}).strict();

export const ApiAutomationRunsResponseSchema = z.object({
    runs: z.array(ApiAutomationRunSchema),
    nextCursor: z.string().nullable(),
}).strict();

export const ApiAutomationRunNowResponseSchema = z.object({
    run: ApiAutomationRunSchema,
}).strict();

export type ApiAutomation = z.infer<typeof ApiAutomationSchema>;
export type ApiAutomationRun = z.infer<typeof ApiAutomationRunSchema>;
