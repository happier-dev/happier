import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ExternalSessionsSourceSchema } from '../sessions/external/sourceCatalog.js';

/** V1 source operations are closed at every boundary; package SemVer is independent. */
export const USAGE_SOURCE_ACTION_IDS = [
  'usage.sources.discover', 'usage.sources.get', 'usage.sources.dismiss',
  'usage.sources.consent.set', 'usage.sources.stop', 'usage.sources.root.set', 'usage.sources.history.delete',
] as const;
export type UsageSourceActionId = typeof USAGE_SOURCE_ACTION_IDS[number];
export const UsageSourceActionIdSchema = lazyZodSchema(() => z.enum(USAGE_SOURCE_ACTION_IDS));
const id = lazyZodSchema(() => z.string().trim().min(1));
const target = lazyZodSchema(() => z.object({ serverId: id, machineId: id }).strict());
const sourceTarget = lazyZodSchema(() => target.extend({ sourceId: id }).strict());
export const UsageSourceDateRangeV1Schema = lazyZodSchema(() => z.object({
  startMs: z.number().finite().nonnegative().optional(), endMs: z.number().finite().nonnegative().optional(),
}).strict().refine(range => range.startMs === undefined || range.endMs === undefined || range.startMs <= range.endMs,
  { message: 'Invalid date range' }));
export type UsageSourceDateRangeV1 = z.infer<typeof UsageSourceDateRangeV1Schema>;

/** Paths travel only over the admitted Machine transport, never accounting ingest/query or observations. */
export const UsageSourceV1Schema = lazyZodSchema(() => z.object({
  serverId: id, machineId: id, sourceId: id,
  agent: asProtocolZod(PluginContributionIdentityV1Schema),
  externalSessionSource: ExternalSessionsSourceSchema.optional(),
  root: z.object({ kind: z.enum(['default', 'configured', 'materialized', 'override']), path: id.nullable() }).strict(),
  consent: z.enum(['enabled', 'disabled']),
  status: z.enum(['found', 'reading', 'ready', 'stopped', 'unavailable', 'error', 'unsupported']),
  coverage: z.enum(['unknown', 'partial', 'complete', 'unsupported']),
  pendingCount: z.number().int().nonnegative(), asOfMs: z.number().finite().nonnegative().nullable(),
  errorCode: id.optional(),
}).strict());
export type UsageSourceV1 = z.infer<typeof UsageSourceV1Schema>;
export const UsageSourcesListV1Schema = lazyZodSchema(() => z.object({ sources: z.array(UsageSourceV1Schema) }).strict());
export const UsageSourceResultV1Schema = lazyZodSchema(() => z.object({ source: UsageSourceV1Schema }).strict());
export const UsageSourceDeleteResultV1Schema = lazyZodSchema(() => z.object({
  success: z.literal(true), deletedEventCount: z.number().int().nonnegative(),
}).strict());
export const UsageSourceDismissResultV1Schema = lazyZodSchema(() => z.object({
  status: z.enum(['dismissed', 'unavailable']),
}).strict());

export const USAGE_SOURCE_ACTION_INPUT_SCHEMAS = {
  'usage.sources.discover': target,
  'usage.sources.get': lazyZodSchema(() => target.extend({ sourceId: id.optional() }).strict()),
  'usage.sources.dismiss': sourceTarget,
  'usage.sources.consent.set': lazyZodSchema(() => sourceTarget.extend({ enabled: z.boolean() }).strict()),
  'usage.sources.stop': sourceTarget,
  'usage.sources.root.set': lazyZodSchema(() => sourceTarget.extend({ root: id.nullable() }).strict()),
  'usage.sources.history.delete': lazyZodSchema(() => sourceTarget.extend({ dateRange: UsageSourceDateRangeV1Schema.optional() }).strict()),
} as const;
export const USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS = {
  'usage.sources.discover': UsageSourcesListV1Schema,
  'usage.sources.get': UsageSourcesListV1Schema,
  'usage.sources.dismiss': UsageSourceDismissResultV1Schema,
  'usage.sources.consent.set': UsageSourceResultV1Schema,
  'usage.sources.stop': UsageSourceResultV1Schema,
  'usage.sources.root.set': UsageSourceResultV1Schema,
  'usage.sources.history.delete': UsageSourceDeleteResultV1Schema,
} as const;
export type UsageSourceActionInputById = { readonly [K in UsageSourceActionId]: z.infer<(typeof USAGE_SOURCE_ACTION_INPUT_SCHEMAS)[K]> };
export type UsageSourceActionOutputById = { readonly [K in UsageSourceActionId]: z.infer<(typeof USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS)[K]> };

/** Source identity is part of the admitted response, not merely the transport address. */
export function parseUsageSourceActionResult(actionId: UsageSourceActionId,
  target: Readonly<{ serverId: string; machineId: string; sourceId?: string }>,
  raw: unknown,
): UsageSourceActionOutputById[UsageSourceActionId] | null {
  const parsed = USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS[actionId].safeParse(raw);
  if (!parsed.success) return null;
  const result = parsed.data;
  const sources = 'sources' in result ? result.sources : 'source' in result ? [result.source] : [];
  if (sources.some(source => source.serverId !== target.serverId || source.machineId !== target.machineId
    || actionId !== 'usage.sources.root.set' && target.sourceId !== undefined && source.sourceId !== target.sourceId)) return null;
  return result;
}

export const USAGE_SOURCE_CONSENT_DISCLOSURE = 'Usage numbers, models, Agents and times are stored on the Happier server like Happier-session usage. Prompts, replies, file paths and file contents are never sent. Stop retains captured history. Delete history removes this source’s selected captured rows and stops collection until consent is enabled again.';

/** V1 is a skippable, content-free read invalidation, never a source-state projection. */
export const USAGE_SOURCES_INVALIDATION_EVENT_V1 = 'usage-sources-invalidated' as const;
export const UsageSourcesInvalidationV1Schema = lazyZodSchema(() => z.object({
  type: z.literal(USAGE_SOURCES_INVALIDATION_EVENT_V1),
  machineId: id,
  installationId: id,
}).strict());
export type UsageSourcesInvalidationV1 = z.infer<typeof UsageSourcesInvalidationV1Schema>;
