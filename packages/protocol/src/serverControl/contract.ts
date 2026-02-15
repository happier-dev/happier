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

export const ServerListEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_list'),
  data: ServerListResultSchema,
});

export const ServerCurrentEnvelopeSchema = SessionControlEnvelopeSuccessSchema.extend({
  kind: z.literal('server_current'),
  data: ServerCurrentResultSchema,
});

// Re-export the shared envelope/error types so consumers can validate server outputs with the same rules.
export const ServerControlErrorSchema = SessionControlErrorSchema;
export const ServerControlEnvelopeSuccessSchema = SessionControlEnvelopeSuccessSchema;
export const ServerControlEnvelopeErrorSchema = SessionControlEnvelopeErrorSchema;

