import { ProviderAccountUsageRecordIdSchema } from '../connect/providerAccountUsagePrimitives.js';

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

/** Publish both rows in the same transaction: old readers retain their existing key. */
export function buildProviderAccountUsageMaterialChangesV1(recordId: string) {
  const id = ProviderAccountUsageRecordIdSchema.parse(recordId);
  return [
    { kind: 'account', entityId: PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1,
      hint: { providerAccountUsageRecordId: id } },
    { kind: 'account', entityId: `${RECORD_PREFIX}${id}` },
  ] as const;
}

/** Undefined is unknown/full. A split page or a predecessor key cannot prove a narrow scope. */
export function readProviderAccountUsageChangedRecordIdsV1(
  changes: readonly Readonly<{ kind: string; entityId: string; cursor: number; hint?: unknown }>[],
): readonly string[] | undefined {
  const records = new Map<string, number>();
  for (const change of changes) {
    if (change.kind !== 'account') continue;
    const id = readProviderAccountUsageChangeRecordIdV1(change.entityId);
    if (id !== null) records.set(id, change.cursor);
    else if (change.entityId !== PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1) return undefined;
  }
  for (const change of changes) {
    if (change.kind !== 'account' || change.entityId !== PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1) continue;
    const hint = change.hint;
    const id = hint !== null && typeof hint === 'object' && !Array.isArray(hint)
      && 'providerAccountUsageRecordId' in hint ? hint.providerAccountUsageRecordId : undefined;
    // Coalescing may retain an old hint across an unscoped writer. The paired
    // publication must follow this global row, not precede its current cursor.
    if (typeof id !== 'string' || records.get(id) !== change.cursor + 1) return undefined;
  }
  return records.size ? [...records.keys()] : undefined;
}
