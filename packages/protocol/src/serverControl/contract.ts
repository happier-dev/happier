import { z } from 'zod';

import { SessionControlErrorSchema, SessionControlEnvelopeErrorSchema, SessionControlEnvelopeSuccessSchema } from '../sessionControl/contract.js';

export const ServerProfileSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  serverUrl: z.string().min(1),
  webappUrl: z.string().min(1),
  lastUsedAt: z.number().int().nonnegative().optional(),
}).passthrough();
export type ServerProfileSummary = z.infer<typeof ServerProfileSummarySchema>;

export const ServerListResultSchema = z.object({
  activeServerId: z.string().min(1),
  profiles: z.array(ServerProfileSummarySchema),
}).passthrough();
export type ServerListResult = z.infer<typeof ServerListResultSchema>;

export const ServerCurrentResultSchema = z.object({
  active: ServerProfileSummarySchema,
}).passthrough();
export type ServerCurrentResult = z.infer<typeof ServerCurrentResultSchema>;

export const ServerAddResultSchema = z.object({
  created: ServerProfileSummarySchema,
  active: ServerProfileSummarySchema,
  used: z.boolean(),
}).passthrough();
export type ServerAddResult = z.infer<typeof ServerAddResultSchema>;

export const ServerUseResultSchema = z.object({
  active: ServerProfileSummarySchema,
}).passthrough();
export type ServerUseResult = z.infer<typeof ServerUseResultSchema>;

export const ServerRemoveResultSchema = z.object({
  removed: ServerProfileSummarySchema,
  active: ServerProfileSummarySchema,
}).passthrough();
export type ServerRemoveResult = z.infer<typeof ServerRemoveResultSchema>;

export const ServerTestResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    url: z.string().min(1),
    version: z.string().nullable(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    url: z.string().min(1),
    status: z.number().int().nullable(),
    error: z.string().min(1),
  }).passthrough(),
]);
export type ServerTestResult = z.infer<typeof ServerTestResultSchema>;

export const ServerSetResultSchema = z.object({
  active: ServerProfileSummarySchema,
}).passthrough();
export type ServerSetResult = z.infer<typeof ServerSetResultSchema>;

export const ServerListEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_list'),
  data: ServerListResultSchema,
});

export const ServerCurrentEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_current'),
  data: ServerCurrentResultSchema,
});

export const ServerAddEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_add'),
  data: ServerAddResultSchema,
});

export const ServerUseEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_use'),
  data: ServerUseResultSchema,
});

export const ServerRemoveEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_remove'),
  data: ServerRemoveResultSchema,
});

export const ServerTestEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_test'),
  data: ServerTestResultSchema,
});

export const ServerSetEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_set'),
  data: ServerSetResultSchema,
});

// Re-export the shared envelope/error types so consumers can validate server outputs with the same rules.
export const ServerControlErrorSchema = SessionControlErrorSchema;
export const ServerControlEnvelopeSuccessSchema = SessionControlEnvelopeSuccessSchema;
export const ServerControlEnvelopeErrorSchema = SessionControlEnvelopeErrorSchema;
