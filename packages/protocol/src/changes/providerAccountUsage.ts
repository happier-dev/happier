import { PROVIDER_ACCOUNT_USAGE_DAY_MS, ProviderAccountUsageRecordIdSchema } from '../connect/providerAccountUsagePrimitives.js';
import { buildQualifiedPluginContributionKey } from '../plugins/contributionKey.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ACCOUNT_IDENTITIES_ACCOUNT_CHANGE_ENTITY_ID_V1, readConnectedServicesAccountChangeV1 } from './index.js';

/** Retained for clients that consume the Account-wide allowance invalidation. */
export const PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'provider-account-usage' as const;
const RECORD_PREFIX = 'provider-account-usage-record:';

export function readProviderAccountUsageChangeRecordIdV1(entityId: string): string | null {
  if (!entityId.startsWith(RECORD_PREFIX)) return null;
  const parsed = ProviderAccountUsageRecordIdSchema.safeParse(entityId.slice(RECORD_PREFIX.length));
  return parsed.success ? parsed.data : null;
}

export function isProviderAccountUsageChangeEntityIdV1(entityId: string): boolean {
  return entityId === PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1
    || readProviderAccountUsageChangeRecordIdV1(entityId) !== null;
}

const DayScopeSchema = lazyZodSchema(() => z.object({
  providerAccountUsageChangedDayStartAtMs: z.number().check(z.int(), z.nonnegative(),
    z.refine(day => day % PROVIDER_ACCOUNT_USAGE_DAY_MS === 0)),
  providerAccountUsageChangedDayAfterCursor: z.number().check(z.int(), z.nonnegative()),
  providerAccountUsageHistoryChange: z.optional(z.strictObject({
    fromAtMs: z.number().check(z.int(), z.nonnegative()),
    afterCursor: z.number().check(z.int(), z.nonnegative()),
  })),
  providerAccountUsageDayPublication: z.optional(z.strictObject({
    kind: z.enum(['observation', 'summary']),
    afterCursor: z.number().check(z.int(), z.nonnegative()),
  })),
}));

export type ProviderAccountUsageDayChangeV1 = Readonly<{
  recordId: string;
  dayStartAtMs: number;
  afterCursor: number;
  throughCursor: number;
  history?: Readonly<{ fromAtMs: number; afterCursor: number }>;
  publication?: Readonly<{ kind: 'observation' | 'summary'; afterCursor: number }>;
}>;

/** Publish both rows in the same transaction: old readers retain their existing key. */
export function buildProviderAccountUsageMaterialChangesV1(recordId: string,
  day?: Pick<ProviderAccountUsageDayChangeV1, 'dayStartAtMs' | 'afterCursor' | 'history' | 'publication'>) {
  const id = ProviderAccountUsageRecordIdSchema.parse(recordId);
  return [
    { kind: 'account', entityId: PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1,
      hint: { providerAccountUsageRecordId: id, ...(day ? {
        providerAccountUsageChangedDayStartAtMs: day.dayStartAtMs, providerAccountUsageChangedDayAfterCursor: day.afterCursor,
        ...(day.history ? { providerAccountUsageHistoryChange: day.history } : {}),
        ...(day.publication ? { providerAccountUsageDayPublication: day.publication } : {}),
      } : {}) } },
    { kind: 'account', entityId: `${RECORD_PREFIX}${id}` },
  ] as const;
}

/**
 * Account feed pages also carry projection rows unrelated to quota history.
 * The quota read admits the Account’s own credentials. Team directory and
 * shared credential publications do not change those bindings.
 */
type UsageChangeRow = Readonly<{ kind: string; entityId: string; cursor: number; hint?: unknown }>;

export function isPairedProviderAccountUsageChangeV1(global: UsageChangeRow, exact: UsageChangeRow): boolean {
  if (global.kind !== 'account' || global.entityId !== PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1
    || exact.kind !== 'account' || exact.cursor !== global.cursor + 1) return false;
  const id = readProviderAccountUsageChangeRecordIdV1(exact.entityId);
  const hint = global.hint;
  // Coalescing can retain the previous hint across a later unscoped writer.
  return id !== null && !!hint && typeof hint === 'object' && !Array.isArray(hint)
    && 'providerAccountUsageRecordId' in hint && hint.providerAccountUsageRecordId === id;
}

/** The stored hint is authoritative only together with its adjacent exact record row. */
export function readProviderAccountUsageDayChangeV1(changes: readonly UsageChangeRow[]): ProviderAccountUsageDayChangeV1 | undefined {
  const global = changes.find(row => row.kind === 'account' && row.entityId === PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1);
  const exact = global && changes.find(row => row.cursor === global.cursor + 1);
  if (!global || !exact || !isPairedProviderAccountUsageChangeV1(global, exact)) return undefined;
  const parsed = DayScopeSchema.safeParse(global.hint);
  if (!parsed.success) return undefined;
  const { providerAccountUsageChangedDayStartAtMs: dayStartAtMs, providerAccountUsageChangedDayAfterCursor: afterCursor,
    providerAccountUsageHistoryChange: history, providerAccountUsageDayPublication: publication } = parsed.data;
  if (afterCursor >= global.cursor || history && (history.afterCursor < afterCursor || history.afterCursor >= global.cursor
    || history.fromAtMs < dayStartAtMs || history.fromAtMs >= dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS)) return undefined;
  return { recordId: readProviderAccountUsageChangeRecordIdV1(exact.entityId)!, dayStartAtMs, afterCursor,
    throughCursor: exact.cursor, ...(history ? { history } : {}),
    ...(publication && publication.afterCursor >= afterCursor && publication.afterCursor < global.cursor
      ? { publication } : {}) };
}

type ProviderAccountUsageChangeScopeV1 = Readonly<{
  recordIds: readonly string[];
  bindingServiceKeys: readonly string[];
}>;

/** A consumed page can name records and qualified service bindings independently. */
export function readProviderAccountUsageChangeScopeV1(
  changes: readonly UsageChangeRow[],
): ProviderAccountUsageChangeScopeV1 | undefined {
  const records = new Set<string>();
  const bindings = new Set<string>();
  for (const change of changes) {
    if (change.kind !== 'account') continue;
    const id = readProviderAccountUsageChangeRecordIdV1(change.entityId);
    if (id !== null) {
      records.add(id);
      continue;
    }
    if (change.entityId === 'self' || change.entityId === ACCOUNT_IDENTITIES_ACCOUNT_CHANGE_ENTITY_ID_V1) return undefined;
    const bindingAddress = readConnectedServicesAccountChangeV1({ kind: 'account', entityId: change.entityId });
    if (bindingAddress === null) continue;
    // An invalid durable hint or an Account-wide binding publication still requires recovery.
    const binding = readConnectedServicesAccountChangeV1(change);
    if (binding?.scope !== 'service') return undefined;
    bindings.add(buildQualifiedPluginContributionKey(binding.ref));
  }
  for (const change of changes) {
    if (change.kind !== 'account' || change.entityId !== PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1) continue;
    const exact = changes.find(row => row.cursor === change.cursor + 1);
    if (!exact || !isPairedProviderAccountUsageChangeV1(change, exact)) return undefined;
  }
  // A split page or a predecessor key cannot prove a narrow scope.
  return records.size || bindings.size ? { recordIds: [...records], bindingServiceKeys: [...bindings] } : undefined;
}

/** Existing record-only readers still treat any binding invalidation as broad. */
export function readProviderAccountUsageChangedRecordIdsV1(
  changes: readonly UsageChangeRow[],
): readonly string[] | undefined {
  const scope = readProviderAccountUsageChangeScopeV1(changes);
  return scope && scope.bindingServiceKeys.length === 0 ? scope.recordIds : undefined;
}
