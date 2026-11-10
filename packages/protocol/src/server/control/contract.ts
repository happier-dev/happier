import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SessionControlErrorSchema, SessionControlEnvelopeErrorSchema, SessionControlEnvelopeSuccessSchema } from '../../sessions/control/contract.js';

export const ServerProfileSummarySchema = z.looseObject({
  id: z.string().check(z.minLength(1)),
  name: z.string().check(z.minLength(1)),
  serverUrl: z.string().check(z.minLength(1)),
  webappUrl: z.string().check(z.minLength(1)),
  lastUsedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
});
export type ServerProfileSummary = z.infer<typeof ServerProfileSummarySchema>;

export const ServerListResultSchema = z.looseObject({
  activeServerId: z.string().check(z.minLength(1)),
  profiles: z.array(ServerProfileSummarySchema),
});
export type ServerListResult = z.infer<typeof ServerListResultSchema>;

export const ServerCurrentResultSchema = z.looseObject({
  active: ServerProfileSummarySchema,
});
export type ServerCurrentResult = z.infer<typeof ServerCurrentResultSchema>;

export const ServerAddResultSchema = z.looseObject({
  created: ServerProfileSummarySchema,
  active: ServerProfileSummarySchema,
  used: z.boolean(),
});
export type ServerAddResult = z.infer<typeof ServerAddResultSchema>;

export const ServerUseResultSchema = z.looseObject({
  active: ServerProfileSummarySchema,
});
export type ServerUseResult = z.infer<typeof ServerUseResultSchema>;

export const ServerRemoveResultSchema = z.looseObject({
  removed: ServerProfileSummarySchema,
  active: ServerProfileSummarySchema,
});
export type ServerRemoveResult = z.infer<typeof ServerRemoveResultSchema>;

export const ServerTestResultSchema = z.discriminatedUnion('ok', [
  z.looseObject({
    ok: z.literal(true),
    url: z.string().check(z.minLength(1)),
    version: z.nullable(z.string()),
  }),
  z.looseObject({
    ok: z.literal(false),
    url: z.string().check(z.minLength(1)),
    status: z.nullable(z.number().check(z.int())),
    error: z.string().check(z.minLength(1)),
  }),
]);
export type ServerTestResult = z.infer<typeof ServerTestResultSchema>;

export const ServerSetResultSchema = z.looseObject({
  active: ServerProfileSummarySchema,
});
export type ServerSetResult = z.infer<typeof ServerSetResultSchema>;

export const ServerListEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('server_list'),
  data: ServerListResultSchema,
}));

export const ServerCurrentEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('server_current'),
  data: ServerCurrentResultSchema,
}));

export const ServerAddEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('server_add'),
  data: ServerAddResultSchema,
}));

export const ServerUseEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('server_use'),
  data: ServerUseResultSchema,
}));

export const ServerRemoveEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('server_remove'),
  data: ServerRemoveResultSchema,
}));

export const ServerTestEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('server_test'),
  data: ServerTestResultSchema,
}));

export const ServerSetEnvelopeSchema = lazyZodSchema(() => z.extend(SessionControlEnvelopeSuccessSchema, {
  kind: z.literal('server_set'),
  data: ServerSetResultSchema,
}));

// Re-export the shared envelope/error types so consumers can validate server outputs with the same rules.
export const ServerControlErrorSchema = SessionControlErrorSchema;
export const ServerControlEnvelopeSuccessSchema = SessionControlEnvelopeSuccessSchema;
export const ServerControlEnvelopeErrorSchema = SessionControlEnvelopeErrorSchema;
