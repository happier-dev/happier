import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProviderAccountUsageRecordIdSchema, ProviderAccountUsageSnapshotV1Schema, type ProviderAccountUsageHistoryWitnessV1, type ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { ProviderAccountSubscriptionV1Schema } from './accountSubscription.js';
import { ConnectedServiceQuotaMeterV1Schema, ConnectedServiceQuotaMeterDetailsV1Schema } from './connectedServiceSchemas.js';
import type { ConnectedServiceQuotaGetResultV1 } from './providerAccountUsageHistorySchemasV1.js';
import { deriveProviderAccountUsageEarlierWindowCurves, hasProviderAccountUsageWitnessedReset,
  resolveProviderAccountUsagePaceWindow } from './deriveProviderAccountUsagePace.js';

const RangeSchema = lazyZodSchema(() => z.strictObject({ startAtMs: z.number().check(z.int(), z.nonnegative()), endAtMs: z.number().check(z.int(), z.nonnegative()) }).check(z.refine(value => value.endAtMs > value.startAtMs)));
const EntrySchema = lazyZodSchema(() => z.strictObject({ id: z.string().check(z.minLength(1)), observedAtMs: z.number().check(z.int(), z.nonnegative()), snapshot: ProviderAccountUsageSnapshotV1Schema }));
function invalidProjectionEntries(projection: Readonly<{ recordId: string; range: Readonly<{ startAtMs: number; endAtMs: number }>;
  history: Readonly<{ entries: readonly Readonly<{ id: string; observedAtMs: number; snapshot: ProviderAccountUsageSnapshotV1 }>[] }> }>) {
  const ids = new Set<string>();
  const invalid: number[] = [];
  for (const [index, entry] of projection.history.entries.entries()) {
    if (entry.snapshot.recordId !== projection.recordId || entry.observedAtMs !== entry.snapshot.fetchedAtMs
      || entry.observedAtMs < projection.range.startAtMs || entry.observedAtMs >= projection.range.endAtMs || ids.has(entry.id)) invalid.push(index);
    ids.add(entry.id);
  }
  return invalid;
}
export const ProviderAccountUsagePageProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), recordId: ProviderAccountUsageRecordIdSchema, resolution: z.literal('accepted_observations'), range: RangeSchema,
  history: z.strictObject({ entries: z.array(EntrySchema), nextCursor: z.null() }),
}).check(z.superRefine((projection, context) => {
  for (const index of invalidProjectionEntries(projection)) context.addIssue({ code: 'custom', path: ['history', 'entries', index],
    message: 'Projection must retain exact admitted range, record and witnesses' });
})));
export type ProviderAccountUsagePageProjectionV1 = z.infer<typeof ProviderAccountUsagePageProjectionV1Schema>;
const BaseSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(z.object(ProviderAccountUsageSnapshotV1Schema.shape), { observedAtMs: true, fetchedAtMs: true, meters: true, subscription: true })));
const SubscriptionMaterialSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(z.object(ProviderAccountSubscriptionV1Schema.shape), { observedAtMs: true })));
const Index = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const Time = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
export const PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING = 'meter_readings_runs_v1' as const;
const MeterDefinitionSchema = lazyZodSchema(() => z.strictObject({
  ...z.omit(z.object(ConnectedServiceQuotaMeterV1Schema.shape), { used: true, limit: true, utilizationPct: true, resetsAt: true,
    remaining: true, remainingPct: true, usedPct: true, resetAtMs: true, details: true }).shape,
  details: z.omit(ConnectedServiceQuotaMeterDetailsV1Schema, { remainingPct: true }),
}));
const MeterReadingSchema = lazyZodSchema(() => z.tuple([Index, z.nullable(z.number()), z.nullable(z.number()),
  z.nullable(z.number()), z.nullable(Time), z.strictObject({
    remaining: z.optional(z.nullable(z.number())), remainingPct: z.optional(z.nullable(z.number())),
    usedPct: z.optional(z.nullable(z.number())), resetAtMs: z.optional(z.nullable(Time)),
    detailsRemainingPct: z.optional(z.nullable(z.number())),
  })]));
// A run shares material only. Each sample retains its exact id and clock deltas;
// irregular clocks cannot be reconstructed from endpoints and a count alone.
const SampleSchema = lazyZodSchema(() => z.tuple([z.string().check(z.minLength(1)), z.number().check(z.int()),
  z.number().check(z.int()), z.nullable(z.number().check(z.int()))]));
export const PackedProviderAccountUsagePageProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), recordId: ProviderAccountUsageRecordIdSchema, resolution: z.literal('accepted_observations'), range: RangeSchema,
  encoding: z.literal(PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING),
  bases: z.array(BaseSchema), meterDefinitions: z.array(MeterDefinitionSchema), meters: z.array(MeterReadingSchema),
  subscriptions: z.array(SubscriptionMaterialSchema),
  observations: z.array(z.tuple([Index, z.array(Index), z.nullable(Index), z.array(SampleSchema).check(z.minLength(1))])),
}));
export const ProviderAccountUsagePageProjectionContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: PackedProviderAccountUsagePageProjectionV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export const ProviderAccountUsagePageProjectionDemandV1Schema = lazyZodSchema(() => z.strictObject({
  range: RangeSchema, resolution: z.literal('accepted_observations'),
}));
/** Content-free identity of the exact representation held by a B reader. */
export const ProviderAccountUsagePageProjectionCoverageV1Schema = lazyZodSchema(() => z.strictObject({
  demand: ProviderAccountUsagePageProjectionDemandV1Schema,
  frontier: z.nullable(z.strictObject({ id: z.string().check(z.minLength(1)), observedAtMs: Time })),
  observationCount: Index, contentMode: z.enum(['plain', 'encrypted']),
}));
/** HEAD admits this held prefix against accepted history, independently of another writer's body. */
export const ProviderAccountUsagePageProjectionPrefixReadV1Schema = lazyZodSchema(() => z.strictObject({
  held: ProviderAccountUsagePageProjectionCoverageV1Schema, complete: z.boolean(),
  published: ProviderAccountUsagePageProjectionCoverageV1Schema,
}));
export const StoredProviderAccountUsagePageProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  // Metadata can be rewritten by a reader which does not know this hint. The
  // authenticated packed body's encoding, not the hint, owns decodability.
  encoding: z.optional(z.literal(PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING)),
  recordId: ProviderAccountUsageRecordIdSchema, demand: ProviderAccountUsagePageProjectionDemandV1Schema,
  frontier: z.nullable(z.strictObject({ id: z.string().check(z.minLength(1)), observedAtMs: Time })),
  observationCount: Index, content: ProviderAccountUsagePageProjectionContentV1Schema,
}).check(z.superRefine((stored, context) => {
  if (stored.content.t !== 'plain') return;
  const packed = stored.content.v;
  const observationCount = packed.observations.reduce((count, run) => count + run[3].length, 0);
  const lastRun = packed.observations.at(-1);
  const last = lastRun?.[3].at(-1);
  const lastAt = lastRun?.[3].reduce((at, sample) => at + sample[1], 0);
  if (packed.recordId !== stored.recordId || packed.range.startAtMs !== stored.demand.range.startAtMs
    || packed.range.endAtMs !== stored.demand.range.endAtMs || packed.resolution !== stored.demand.resolution
    || observationCount !== stored.observationCount
    || (last ? stored.frontier?.id !== last[0] || stored.frontier.observedAtMs !== lastAt : stored.frontier !== null)) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'Projection coverage must identify its protected observations' });
  }
})));
/** @internal Shared by metadata admission and the authorized encrypted-body opener. */
export function isSupersededProjectionBody(value: unknown): value is Readonly<{ v: 1; recordId: string }> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'v' in value && value.v === 1
    && 'recordId' in value && typeof value.recordId === 'string' && !('encoding' in value);
}

/** Plain bodies can be retired here; only the authorized opener can classify opaque bodies. */
export const ProviderAccountUsagePageProjectionMetadataV1Schema = lazyZodSchema(() => z.pipe(z.transform(value =>
  value && typeof value === 'object' && !Array.isArray(value) && 'recordId' in value && 'demand' in value
    && !('encoding' in value)
    && 'content' in value && value.content && typeof value.content === 'object' && 't' in value.content
    && value.content.t === 'plain' && 'v' in value.content && isSupersededProjectionBody(value.content.v)
    && value.content.v.recordId === value.recordId ? undefined : value,
), z.optional(StoredProviderAccountUsagePageProjectionV1Schema)));
export const ProviderAccountUsagePageProjectionWriteV1Schema = lazyZodSchema(() => z.intersection(
  StoredProviderAccountUsagePageProjectionV1Schema, z.object({ encoding: z.literal(PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING) }),
));
export const ProviderAccountUsagePageProjectionReadV1Schema = lazyZodSchema(() => z.strictObject({
  projection: z.nullable(StoredProviderAccountUsagePageProjectionV1Schema),
  complete: z.boolean(),
}));

export function buildProviderAccountUsagePageProjectionV1(input: Readonly<{
  recordId: string; range: ProviderAccountUsagePageProjectionV1['range'];
  history: Readonly<{ entries: readonly z.infer<typeof EntrySchema>[]; nextCursor: unknown }>;
}>): ProviderAccountUsagePageProjectionV1 {
  // Record/page openers admitted the snapshots. Enforce the projection's
  // cross-entry invariants without cloning/revalidating their material.
  const projection: ProviderAccountUsagePageProjectionV1 = { v: 1, recordId: input.recordId, range: input.range,
    resolution: 'accepted_observations', history: { entries: [...input.history.entries], nextCursor: null } };
  if (input.history.nextCursor !== null || invalidProjectionEntries(projection).length) {
    throw new Error('provider_account_usage_identity_mismatch');
  }
  return projection;
}

/** A recognized development body needs rebuilding, never legacy decoding. */
export class ProviderAccountUsagePageProjectionSupersededError extends Error {
  readonly code = 'provider_account_usage_page_projection_superseded';
  constructor() { super('provider_account_usage_page_projection_superseded'); }
}

export function packProviderAccountUsagePageProjectionV1(input: ProviderAccountUsagePageProjectionV1): z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema> {
  const projection = input;
  const bases: z.infer<typeof BaseSchema>[] = [];
  const meterDefinitions: z.infer<typeof MeterDefinitionSchema>[] = [];
  const meters: z.infer<typeof MeterReadingSchema>[] = [];
  const subscriptions: z.infer<typeof SubscriptionMaterialSchema>[] = [];
  const baseKeys = new Map<string, number>();
  const meterKeys = new Map<string, number>();
  // Opened dictionaries share admitted meter objects across observations. Reuse
  // their index within this synchronous pack; later invocations read them anew.
  const meterIndexesByObject = new WeakMap<ProviderAccountUsageSnapshotV1['meters'][number], number>();
  const definitionKeys = new Map<string, number>();
  const subscriptionKeys = new Map<string, number>();
  const intern = <T>(value: T, values: T[], keys: Map<string, number>) => {
    const key = JSON.stringify(value);
    const existing = keys.get(key);
    if (existing !== undefined) return existing;
    const index = values.length; keys.set(key, index); values.push(value); return index;
  };
  const observations: z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema>['observations'] = [];
  let previousMaterial: string | undefined;
  let previousFetchedAt = 0;
  for (const entry of projection.history.entries) {
    // Historical request diagnostics have no Plans/Coach consumer. Keep them
    // in exact history, rather than making each fetch a unique page base.
    const { observedAtMs, fetchedAtMs, meters: snapshotMeters, subscription, diagnostics: _diagnostics, ...base } = entry.snapshot;
    const subscriptionMaterial = subscription ? (({ observedAtMs: _at, ...value }) => value)(subscription) : null;
    const baseIndex = intern(base, bases, baseKeys);
    const meterIndexes = snapshotMeters.map(meter => {
      const existing = meterIndexesByObject.get(meter);
      if (existing !== undefined) return existing;
      const { used, limit, utilizationPct, resetsAt, remaining, remainingPct, usedPct, resetAtMs, details, ...definition } = meter;
      const { remainingPct: detailsRemainingPct, ...detailDefinition } = details;
      const definitionIndex = intern({ ...definition, details: detailDefinition }, meterDefinitions, definitionKeys);
      const index = intern<z.infer<typeof MeterReadingSchema>>([definitionIndex, used, limit, utilizationPct, resetsAt, {
        ...(remaining !== undefined ? { remaining } : {}), ...(remainingPct !== undefined ? { remainingPct } : {}),
        ...(usedPct !== undefined ? { usedPct } : {}), ...(resetAtMs !== undefined ? { resetAtMs } : {}),
        ...(detailsRemainingPct !== undefined ? { detailsRemainingPct } : {}),
      }], meters, meterKeys);
      meterIndexesByObject.set(meter, index);
      return index;
    });
    const subscriptionIndex = subscriptionMaterial ? intern(subscriptionMaterial, subscriptions, subscriptionKeys) : null;
    const key = JSON.stringify([baseIndex, meterIndexes, subscriptionIndex]);
    if (key !== previousMaterial) {
      observations.push([baseIndex, meterIndexes, subscriptionIndex, []]);
      previousMaterial = key;
      previousFetchedAt = 0;
    }
    observations.at(-1)![3].push([entry.id, fetchedAtMs - previousFetchedAt, observedAtMs - fetchedAtMs,
      subscription ? subscription.observedAtMs - fetchedAtMs : null]);
    previousFetchedAt = fetchedAtMs;
  }
  return { v: 1, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING, recordId: projection.recordId,
    resolution: projection.resolution, range: projection.range, bases, meterDefinitions, meters, subscriptions, observations };
}

export function unpackProviderAccountUsagePageProjectionV1(input: z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema>): ProviderAccountUsagePageProjectionV1 {
  return unpackAdmittedProjection(PackedProviderAccountUsagePageProjectionV1Schema.parse(input));
}

/** @internal Decode only after the canonical packed-body schema has admitted the value. */
export function unpackAdmittedProjection(packed: z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema>): ProviderAccountUsagePageProjectionV1 {
  // Validate composite snapshot identity once per admitted base. Meter and
  // subscription dictionaries were already validated once by the packed schema.
  const bases = packed.bases.map(base => {
    const { observedAtMs: _observed, fetchedAtMs: _fetched, meters: _meters, subscription: _subscription, ...validated } =
      ProviderAccountUsageSnapshotV1Schema.parse({ ...base, observedAtMs: 0, fetchedAtMs: 0, meters: [] });
    return validated;
  });
  const at = <T>(values: T[], index: number): T => {
    const value = values[index];
    if (value === undefined) throw new Error('provider_account_usage_content_unavailable');
    return value;
  };
  const meters = packed.meters.map(([definition, used, limit, utilizationPct, resetsAt, reading]) => {
    const { detailsRemainingPct, ...values } = reading;
    const material = at(packed.meterDefinitions, definition);
    return ConnectedServiceQuotaMeterV1Schema.parse({ ...material, used, limit, utilizationPct, resetsAt, ...values,
      details: { ...material.details, ...(detailsRemainingPct !== undefined ? { remainingPct: detailsRemainingPct } : {}) } });
  });
  const projection: ProviderAccountUsagePageProjectionV1 = { v: packed.v, recordId: packed.recordId, resolution: packed.resolution, range: packed.range,
    history: { entries: packed.observations.flatMap(([base, meterIndexes, subscription, samples]) => {
      let fetchedAtMs = 0;
      return samples.map(([id, deltaFetchedAt, deltaObservedAt, deltaSubscriptionAt]) => {
        fetchedAtMs += deltaFetchedAt;
        const observedAtMs = fetchedAtMs + deltaObservedAt;
        const subscriptionAt = deltaSubscriptionAt === null ? null : fetchedAtMs + deltaSubscriptionAt;
        if (![fetchedAtMs, observedAtMs, ...(subscriptionAt === null ? [] : [subscriptionAt])].every(at => Number.isSafeInteger(at) && at >= 0)) {
          throw new Error('provider_account_usage_content_unavailable');
        }
        if ((subscription === null) !== (subscriptionAt === null)) throw new Error('provider_account_usage_content_unavailable');
        const subscriptionValue = subscription === null || subscriptionAt === null ? undefined
          : { ...at(packed.subscriptions, subscription), observedAtMs: subscriptionAt };
        return { id, observedAtMs: fetchedAtMs, snapshot: { ...at(bases, base), observedAtMs, fetchedAtMs,
          meters: meterIndexes.map(index => at(meters, index)),
          ...(subscriptionValue ? { subscription: subscriptionValue } : {}) } };
      });
    }), nextCursor: null } };
  if (invalidProjectionEntries(projection).length) throw new Error('provider_account_usage_identity_mismatch');
  return projection;
}

const openedQuotaPageHistory = new WeakMap<z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema>, ProviderAccountUsagePageProjectionV1['history']>();
/** Decode once for consumers of the same admitted B value; this carries no read/freshness authority. */
export function getProviderAccountUsageQuotaHistoryV1(read: Readonly<{
  history?: { entries: z.infer<typeof EntrySchema>[]; nextCursor: ProviderAccountUsageHistoryWitnessV1 | null };
  pageProjection?: z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema>;
}>) {
  if (read.history) return read.history;
  if (!read.pageProjection) return undefined;
  let history = openedQuotaPageHistory.get(read.pageProjection);
  if (!history) {
    history = unpackAdmittedProjection(read.pageProjection).history;
    openedQuotaPageHistory.set(read.pageProjection, history);
  }
  return history;
}

/** The page consumes these facts, never the observations used to derive them. */
export function getProviderAccountUsageQuotaPageFactsV1(read: ConnectedServiceQuotaGetResultV1): ConnectedServiceQuotaGetResultV1['pageFacts'] {
  if (read.pageFacts) return read.pageFacts;
  const history = getProviderAccountUsageQuotaHistoryV1(read);
  if (!history) return undefined;
  const snapshots = history.entries.map(entry => entry.snapshot);
  const current = read.current;
  const observations = [...snapshots, ...(current ? [current] : [])]
    .filter(snapshot => snapshot.state === 'loaded_data' && snapshot.recordId === current?.recordId)
    .sort((left, right) => left.observedAtMs - right.observedAtMs);
  const witnessedResets: NonNullable<ConnectedServiceQuotaGetResultV1['pageFacts']>['witnessedResets'] = [];
  for (const meter of current?.meters ?? []) {
    const resets = new Set<number>();
    for (let index = 1; index < observations.length; index++) {
      const previous = observations[index - 1]!;
      const next = observations[index]!;
      const window = resolveProviderAccountUsagePaceWindow(previous, meter.meterId);
      if (!window || resets.has(window.resetAtMs) || !hasProviderAccountUsageWitnessedReset({ previous, current: next,
        meterId: meter.meterId, nowMs: next.observedAtMs })) continue;
      resets.add(window.resetAtMs); witnessedResets.push(window);
    }
  }
  let resetWitness: NonNullable<ConnectedServiceQuotaGetResultV1['pageFacts']>['resetWitness'] = null;
  for (const entry of history.entries) if (entry.snapshot.recordId === current?.recordId
    && (!resetWitness || entry.observedAtMs > resetWitness.observedAtMs)) resetWitness = entry;
  return { historyStatus: history.nextCursor === null ? 'complete' : 'partial', resetWitness, witnessedResets,
    earlierCurves: (current?.meters ?? []).map(meter => ({ meterId: meter.meterId,
      value: deriveProviderAccountUsageEarlierWindowCurves({ current: current!, meterId: meter.meterId, history: snapshots }) })) };
}
