import { z } from 'zod';

import { SessionControlErrorSchema, SessionControlEnvelopeErrorSchema, SessionControlEnvelopeSuccessSchema } from '../sessionControl/contract.js';
import { lazySchema } from '../lazySchema.js';

export const ServerProfileSummarySchema = lazySchema(() => z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  serverUrl: z.string().min(1),
  webappUrl: z.string().min(1),
  lastUsedAt: z.number().int().nonnegative().optional(),
}).passthrough());
export type ServerProfileSummary = z.infer<typeof ServerProfileSummarySchema>;

export const ServerListResultSchema = lazySchema(() => z.object({
  activeServerId: z.string().min(1),
  profiles: z.array(ServerProfileSummarySchema),
}).passthrough());
export type ServerListResult = z.infer<typeof ServerListResultSchema>;

export const ServerCurrentResultSchema = lazySchema(() => z.object({
  active: ServerProfileSummarySchema,
}).passthrough());
export type ServerCurrentResult = z.infer<typeof ServerCurrentResultSchema>;

export const ServerAddResultSchema = lazySchema(() => z.object({
  created: ServerProfileSummarySchema,
  active: ServerProfileSummarySchema,
  used: z.boolean(),
}).passthrough());
export type ServerAddResult = z.infer<typeof ServerAddResultSchema>;

export const ServerUseResultSchema = lazySchema(() => z.object({
  active: ServerProfileSummarySchema,
}).passthrough());
export type ServerUseResult = z.infer<typeof ServerUseResultSchema>;

export const ServerRemoveResultSchema = lazySchema(() => z.object({
  removed: ServerProfileSummarySchema,
  active: ServerProfileSummarySchema,
}).passthrough());
export type ServerRemoveResult = z.infer<typeof ServerRemoveResultSchema>;

export const ServerTestResultSchema = lazySchema(() => z.discriminatedUnion('ok', [
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
]));
export type ServerTestResult = z.infer<typeof ServerTestResultSchema>;

export const ServerSetResultSchema = lazySchema(() => z.object({
  active: ServerProfileSummarySchema,
}).passthrough());
export type ServerSetResult = z.infer<typeof ServerSetResultSchema>;

export const ServerListEnvelopeSchema = lazySchema(() => SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_list'),
  data: ServerListResultSchema,
}));

export const ServerCurrentEnvelopeSchema = lazySchema(() => SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_current'),
  data: ServerCurrentResultSchema,
}));

export const ServerAddEnvelopeSchema = lazySchema(() => SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_add'),
  data: ServerAddResultSchema,
}));

export const ServerUseEnvelopeSchema = lazySchema(() => SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_use'),
  data: ServerUseResultSchema,
}));

export const ServerRemoveEnvelopeSchema = lazySchema(() => SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_remove'),
  data: ServerRemoveResultSchema,
}));

export const ServerTestEnvelopeSchema = lazySchema(() => SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_test'),
  data: ServerTestResultSchema,
}));

export const ServerSetEnvelopeSchema = lazySchema(() => SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_set'),
  data: ServerSetResultSchema,
}));

// Re-export the shared envelope/error types so consumers can validate server outputs with the same rules.
export const ServerControlErrorSchema = SessionControlErrorSchema;
export const ServerControlEnvelopeSuccessSchema = SessionControlEnvelopeSuccessSchema;
export const ServerControlEnvelopeErrorSchema = SessionControlEnvelopeErrorSchema;
