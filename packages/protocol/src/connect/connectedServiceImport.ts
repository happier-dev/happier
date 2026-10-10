import { z } from 'zod';

import { ConnectedServiceProfileIdSchema } from './connectedServiceBindings.js';

export const CONNECTED_SERVICE_IMPORT_TIMEOUT_MS = 120_000;

/** A machine imports a supported native login without returning credentials. */
export const ConnectedServiceImportParamsSchema = z.object({
    serviceId: z.literal('antigravity'),
    profileId: ConnectedServiceProfileIdSchema,
    source: z.enum(['acp', 'cli']),
    projectId: z.string().trim().min(1).optional(),
    deadlineAtMs: z.number().int().nonnegative().optional(),
}).strict();

export type ConnectedServiceImportParams = z.infer<typeof ConnectedServiceImportParamsSchema>;

export const ConnectedServiceImportResultSchema = z.discriminatedUnion('success', [
    z.object({
        success: z.literal(true),
        serviceId: z.literal('antigravity'),
        profileId: ConnectedServiceProfileIdSchema,
        requiresBrowserReauthorization: z.boolean(),
    }).strict(),
    z.object({
        success: z.literal(false),
        errorCode: z.string().trim().min(1),
        error: z.string().trim().min(1),
    }).strict(),
]);

export type ConnectedServiceImportResult = z.infer<typeof ConnectedServiceImportResultSchema>;
