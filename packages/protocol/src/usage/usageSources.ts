import { USAGE_SOURCE_ACTION_IDS } from './usageSourcesActionIdsV1.js';
export { USAGE_SOURCE_ACTION_IDS } from './usageSourcesActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ExternalSessionsSourceSchema } from '../sessions/external/sourceCatalog.js';
export type UsageSourceActionId = typeof USAGE_SOURCE_ACTION_IDS[number];
export const UsageSourceActionIdSchema = lazyZodSchema(() => z.enum(USAGE_SOURCE_ACTION_IDS));
const id = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const target = lazyZodSchema(() => z.strictObject({ serverId: id, machineId: id }));
const sourceTarget = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(target, { sourceId: id })));
export const UsageSourceDateRangeV1Schema = lazyZodSchema(() => z.strictObject({
  startMs: z.optional(z.number().check(z.nonnegative())), endMs: z.optional(z.number().check(z.nonnegative())),
}).check(z.refine(range => range.startMs === undefined || range.endMs === undefined || range.startMs <= range.endMs, { message: 'Invalid date range' })));
export type UsageSourceDateRangeV1 = z.infer<typeof UsageSourceDateRangeV1Schema>;

/** Paths travel only over the admitted Machine transport, never accounting ingest/query or observations. */
export const UsageSourceV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, machineId: id, sourceId: id,
  agent: asProtocolZod(PluginContributionIdentityV1Schema),
  /** Accounting identity is independent of the opaque root and its client-only display path. */
  accountingSources: z.optional(z.array(id)),
  captureKind: z.optional(z.literal('from_logs')),
  externalSessionSource: z.optional(ExternalSessionsSourceSchema),
  root: z.strictObject({ kind: z.enum(['default', 'configured', 'materialized', 'override']), path: z.nullable(id) }),
  /** Discovery metadata only: files already enumerated by the source, never sessions or token estimates. */
  discoveredFileCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  consent: z.enum(['enabled', 'disabled']),
  status: z.enum(['found', 'reading', 'ready', 'stopped', 'unavailable', 'error', 'unsupported']),
  coverage: z.enum(['unknown', 'partial', 'complete', 'unsupported']),
  pendingCount: z.number().check(z.int(), z.nonnegative()), asOfMs: z.nullable(z.number().check(z.nonnegative())),
  errorCode: z.optional(id),
}));
export type UsageSourceV1 = z.infer<typeof UsageSourceV1Schema>;

/** Missing is an Agent inventory fact only when no other usable or retained root was discovered. */
export function isUsageSourceMissing(source: Pick<UsageSourceV1, 'root' | 'consent' | 'pendingCount' | 'asOfMs' | 'status'>): boolean {
  return source.root.path === null && source.consent === 'disabled' && source.pendingCount === 0 && source.asOfMs === null
    && (source.status === 'unavailable' || source.status === 'unsupported' || source.status === 'error');
}

/** Discovery presentation only; capture custody and per-root consent/history are never removed. */
export function selectUsageSourceDiscoveryInventory(sources: readonly UsageSourceV1[]): readonly UsageSourceV1[] {
  // An untouched host-materialized runtime home is not a user's source to add. Keep it once consented or captured.
  const visible = sources.filter(source => !(source.root.kind === 'materialized' && source.status === 'found'
    && source.consent === 'disabled' && source.pendingCount === 0 && source.asOfMs === null));
  const agentKey = (source: UsageSourceV1) => JSON.stringify([source.serverId, source.machineId, source.agent.pluginId, source.agent.localId]);
  const present = new Set(visible.filter(source => !isUsageSourceMissing(source)).map(agentKey));
  const missing = new Set<string>();
  return visible.filter(source => {
    if (!isUsageSourceMissing(source)) return true;
    const key = agentKey(source);
    if (present.has(key) || missing.has(key)) return false;
    missing.add(key);
    return true;
  });
}

/** Exact accounting selections never match an Agent, capture path, or source-root key. */
export function matchesUsageSourceAccountingScope(source: Pick<UsageSourceV1, 'accountingSources' | 'captureKind'>,
  selected: readonly string[]): boolean {
  return selected.length === 0 || source.captureKind === 'from_logs'
    && selected.some(id => source.accountingSources?.includes(id));
}
export const UsageSourcesListV1Schema = lazyZodSchema(() => z.strictObject({ sources: z.array(UsageSourceV1Schema) }));
export const UsageSourceResultV1Schema = lazyZodSchema(() => z.strictObject({ source: UsageSourceV1Schema }));
export const UsageSourceDeleteResultV1Schema = lazyZodSchema(() => z.strictObject({
  success: z.literal(true), deletedEventCount: z.number().check(z.int(), z.nonnegative()),
}));
export const UsageSourceDismissResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['dismissed', 'unavailable']),
}));

export const USAGE_SOURCE_ACTION_INPUT_SCHEMAS = {
  'usage.sources.discover': target,
  'usage.sources.get': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(target, { sourceId: z.optional(id) }))),
  'usage.sources.dismiss': sourceTarget,
  'usage.sources.consent.set': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(sourceTarget, { enabled: z.boolean() }))),
  'usage.sources.stop': sourceTarget,
  'usage.sources.root.set': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(sourceTarget, { root: z.nullable(id) }))),
  'usage.sources.history.delete': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(sourceTarget, { dateRange: z.optional(UsageSourceDateRangeV1Schema) }))),
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
export const UsageSourcesInvalidationV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal(USAGE_SOURCES_INVALIDATION_EVENT_V1),
  machineId: id,
  installationId: id,
}));
export type UsageSourcesInvalidationV1 = z.infer<typeof UsageSourcesInvalidationV1Schema>;
