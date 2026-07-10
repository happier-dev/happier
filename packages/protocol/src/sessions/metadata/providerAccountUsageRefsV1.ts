import { z } from 'zod';

import {
  ProviderAccountUsageRecordIdSchema,
  type ProviderAccountUsageRecordId,
} from '../../connect/accountUsage.js';

export const PROVIDER_ACCOUNT_USAGE_REFS_METADATA_KEY = 'providerAccountUsageRefsV1' as const;
export const PROVIDER_ACCOUNT_USAGE_REFS_MAX_RECORD_IDS = 32;

export const ProviderAccountUsageRefsV1Schema = z
  .object({
    v: z.literal(1),
    recordIds: z.array(ProviderAccountUsageRecordIdSchema).max(PROVIDER_ACCOUNT_USAGE_REFS_MAX_RECORD_IDS),
    updatedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type ProviderAccountUsageRefsV1 = z.infer<typeof ProviderAccountUsageRefsV1Schema>;

function toMetadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

function normalizeTimestampMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function readRawRecordIds(metadata: unknown): unknown[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>)[PROVIDER_ACCOUNT_USAGE_REFS_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const rawRecordIds = (raw as { recordIds?: unknown }).recordIds;
  return Array.isArray(rawRecordIds) ? rawRecordIds : [];
}

export function normalizeProviderAccountUsageMetadataRecordIds(
  recordIds: ReadonlyArray<unknown>,
): ProviderAccountUsageRecordId[] {
  const normalized: ProviderAccountUsageRecordId[] = [];
  const seen = new Set<string>();
  for (const rawRecordId of recordIds) {
    const parsed = ProviderAccountUsageRecordIdSchema.safeParse(rawRecordId);
    if (!parsed.success || seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    normalized.push(parsed.data);
  }
  return normalized.slice(-PROVIDER_ACCOUNT_USAGE_REFS_MAX_RECORD_IDS);
}

export function readProviderAccountUsageRecordIdsFromMetadata(
  metadata: unknown,
): ProviderAccountUsageRecordId[] {
  return normalizeProviderAccountUsageMetadataRecordIds(readRawRecordIds(metadata));
}

export function writeProviderAccountUsageRecordIdToMetadata(
  metadata: unknown,
  input: Readonly<{
    recordId: ProviderAccountUsageRecordId | string;
    updatedAtMs: number;
  }>,
): Record<string, unknown> {
  const base = toMetadataRecord(metadata);
  const parsedRecordId = ProviderAccountUsageRecordIdSchema.safeParse(input.recordId);
  if (!parsedRecordId.success) return base;

  const recordIds = normalizeProviderAccountUsageMetadataRecordIds([
    ...readRawRecordIds(metadata),
    parsedRecordId.data,
  ]);

  base[PROVIDER_ACCOUNT_USAGE_REFS_METADATA_KEY] = {
    v: 1,
    recordIds,
    updatedAtMs: normalizeTimestampMs(input.updatedAtMs),
  } satisfies ProviderAccountUsageRefsV1;
  return base;
}
