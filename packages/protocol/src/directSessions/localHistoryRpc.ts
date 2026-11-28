import { z } from 'zod';

import { lazySchema } from '../lazySchema.js';
import {
  DirectSessionRetentionDaysSchema,
  DirectSessionRetentionStateSchema,
  DirectSessionsProviderIdSchema,
  DirectSessionsSourceSchema,
} from './daemonRpcV1.js';

const LocalHistoryIdSchema = lazySchema(() => z.string().trim().min(1).refine(
  (id) => id !== '.' && id !== '..' && !/[\\/:\u0000]/u.test(id),
));

export const LocalHistorySourceSchema = lazySchema(() => z.object({
  providerId: DirectSessionsProviderIdSchema,
  source: DirectSessionsSourceSchema,
}));

export const LocalHistoryItemsSchema = lazySchema(() => z.array(z.object({
  remoteSessionId: LocalHistoryIdSchema,
  projectId: LocalHistoryIdSchema.optional(),
}).strict()).min(1));

export const LocalHistoryRpcRequestSchema = lazySchema(() => {
  const source = LocalHistorySourceSchema.shape;
  const days = DirectSessionRetentionDaysSchema;
  return z.discriminatedUnion('operation', [
    z.object({ ...source, operation: z.literal('status.get') }).strict(),
    z.object({ ...source, operation: z.literal('due.list') }).strict(),
    z.object({ ...source, operation: z.literal('retention.preview'), days }).strict(),
    z.object({ ...source, operation: z.literal('retention.set'), days, expectedCurrentDays: z.number().int().positive().nullable() }).strict(),
    z.object({ ...source, operation: z.literal('keep'), items: LocalHistoryItemsSchema }).strict(),
    z.object({ ...source, operation: z.literal('letGo'), items: LocalHistoryItemsSchema }).strict(),
  ]);
});
export type LocalHistoryRpcRequest = z.infer<typeof LocalHistoryRpcRequestSchema>;

export const LocalHistoryRpcResponseSchema = lazySchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    retention: DirectSessionRetentionStateSchema.optional(),
    preview: z.object({
      currentDays: z.number().int().positive().nullable(),
      affectedCount: z.number().int().nonnegative(),
      shortening: z.boolean(),
    }).optional(),
    due: z.array(z.object({ remoteSessionId: LocalHistoryIdSchema, projectId: LocalHistoryIdSchema, activityMs: z.number().optional(), leavesAt: z.number() })).optional(),
    changed: z.number().int().nonnegative().optional(),
    keptDueAtMs: z.number().nullable().optional(),
    retentionDays: z.number().int().positive().nullable().optional(),
  }),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum(['invalid_request', 'provider_unavailable', 'internal_error', 'retention_changed', 'retention_unwritable', 'session_not_found']),
  }),
]));
export type LocalHistoryRpcResponse = z.infer<typeof LocalHistoryRpcResponseSchema>;
