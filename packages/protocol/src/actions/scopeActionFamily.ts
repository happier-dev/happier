import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { SessionListFilterFieldsV1Schema } from '../sessions/listFilter/sessionListFilterV1.js';

/** Client view controls; these never change a Session's access or ownership. */
export const SCOPE_ACTION_IDS = [
  'session.list.view.get', 'session.list.view.set', 'session.list.view.reset',
  'shell.column.get', 'shell.column.set',
] as const;
export type ScopeActionId = typeof SCOPE_ACTION_IDS[number];
export const ScopeActionIdSchema = lazyZodSchema(() => z.enum(SCOPE_ACTION_IDS));

export const SessionListActionViewSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('team'), serverId: z.string().trim().min(1), teamId: z.string().trim().min(1) }).strict(),
]));
const SessionListViewTargetSchema = lazyZodSchema(() => z.object({
  view: SessionListActionViewSchema.optional(),
  storage: z.enum(['active', 'archived']).optional(),
}).strict());
export const SessionListActionFiltersSchema = lazyZodSchema(() => SessionListFilterFieldsV1Schema.extend({ searchQuery: z.string() }));
const MutationResultSchema = lazyZodSchema(() => z.object({ ok: z.literal(true) }).strict());

export const ScopeActionInputSchemas = {
  'session.list.view.get': SessionListViewTargetSchema,
  'session.list.view.set': SessionListViewTargetSchema.extend({
    filters: SessionListActionFiltersSchema.partial().optional(),
    includeInactive: z.boolean().optional(),
  }).strict(),
  'session.list.view.reset': SessionListViewTargetSchema,
  'shell.column.get': z.object({}).strict(),
  'shell.column.set': z.object({ visible: z.boolean() }).strict(),
} as const;

export const ScopeActionOutputSchemas = {
  'session.list.view.get': z.object({
    view: SessionListActionViewSchema,
    storage: z.enum(['active', 'archived']),
    filters: SessionListActionFiltersSchema,
    includeInactive: z.boolean(),
    queryEnabled: z.boolean(),
    followingAvailable: z.boolean(),
    sourceAvailable: z.boolean(),
    homes: z.array(z.object({ serverId: z.string(), label: z.string() }).strict()),
  }).strict(),
  'session.list.view.set': MutationResultSchema,
  'session.list.view.reset': MutationResultSchema,
  'shell.column.get': z.object({ present: z.boolean(), visible: z.boolean(), available: z.boolean() }).strict(),
  'shell.column.set': MutationResultSchema,
} as const;

export type ScopeActionInputById = { [Id in ScopeActionId]: z.infer<typeof ScopeActionInputSchemas[Id]> };
