import { createHash } from 'node:crypto';

import { z } from 'zod';

export const MarketplaceSourceOriginV1Schema = z.enum(['user', 'curated']);
export type MarketplaceSourceOriginV1 = z.infer<typeof MarketplaceSourceOriginV1Schema>;

export const MarketplaceSourceV1Schema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  sourceUrl: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  origin: MarketplaceSourceOriginV1Schema.default('user'),
  description: z.string().trim().min(1).nullable().optional(),
  addedAtMs: z.number().int().nonnegative().optional(),
  updatedAtMs: z.number().int().nonnegative().optional(),
}).passthrough();
export type MarketplaceSourceV1 = z.infer<typeof MarketplaceSourceV1Schema>;

export const MarketplaceSourceRegistryV1Schema = z.object({
  t: z.literal('happier_marketplace_source_registry_v1').default('happier_marketplace_source_registry_v1'),
  schemaVersion: z.literal(1).default(1),
  sources: z.array(MarketplaceSourceV1Schema).default([]),
}).passthrough();
export type MarketplaceSourceRegistryV1 = z.infer<typeof MarketplaceSourceRegistryV1Schema>;

export const DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE = 'Happier curated marketplace';
export const DEFAULT_CURATED_MARKETPLACE_SOURCE_DESCRIPTION = 'Official curated source';

export type MarketplaceSourceRecordInputV1 = Readonly<{
  sourceUrl: string;
  title?: string | null;
  description?: string | null;
  enabled?: boolean;
  origin?: MarketplaceSourceOriginV1;
}>;

export function normalizeMarketplaceSourceUrlV1(sourceUrl: string): string {
  const normalized = String(sourceUrl ?? '').trim();
  if (!normalized) {
    throw new Error('Marketplace source URL is required');
  }
  return normalized;
}

export function deriveMarketplaceSourceId(sourceUrl: string): string {
  return `marketplace:${createHash('sha256').update(String(sourceUrl ?? '').trim()).digest('hex').slice(0, 12)}`;
}

export function deriveMarketplaceSourceTitle(sourceUrl: string): string {
  const normalized = String(sourceUrl ?? '').trim();
  try {
    const parsed = new URL(normalized);
    return parsed.hostname || parsed.href;
  } catch {
    return normalized;
  }
}

export function createMarketplaceSourceV1(
  input: MarketplaceSourceRecordInputV1,
  existing?: MarketplaceSourceV1 | null,
): MarketplaceSourceV1 {
  const sourceUrl = normalizeMarketplaceSourceUrlV1(input.sourceUrl);

  const title = String(input.title ?? existing?.title ?? deriveMarketplaceSourceTitle(sourceUrl)).trim();
  if (!title) {
    throw new Error('Marketplace source title is required');
  }

  const normalizedDescription = normalizeMarketplaceSourceDescriptionV1(input.description, existing?.description);

  return {
    id: existing?.id ?? deriveMarketplaceSourceId(sourceUrl),
    title,
    sourceUrl,
    enabled: input.enabled ?? existing?.enabled ?? true,
    origin: input.origin ?? existing?.origin ?? 'user',
    ...(normalizedDescription !== undefined ? { description: normalizedDescription } : {}),
    addedAtMs: existing?.addedAtMs ?? Date.now(),
    updatedAtMs: Date.now(),
  };
}

function normalizeMarketplaceSourceDescriptionV1(
  description: string | null | undefined,
  existingDescription?: string | null,
): string | null | undefined {
  if (description === undefined) {
    return existingDescription;
  }
  if (description === null) {
    return null;
  }
  const normalized = description.trim();
  return normalized.length > 0 ? normalized : null;
}

export function createCuratedMarketplaceSourceV1(
  sourceUrl: string,
  input?: Readonly<{
    title?: string | null;
    description?: string | null;
    enabled?: boolean;
  }>,
): MarketplaceSourceV1 {
  return createMarketplaceSourceV1({
    sourceUrl,
    title: input?.title ?? DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE,
    description: input?.description ?? DEFAULT_CURATED_MARKETPLACE_SOURCE_DESCRIPTION,
    enabled: input?.enabled ?? true,
    origin: 'curated',
  });
}

export function createDefaultCuratedMarketplaceSourceRegistryV1(sourceUrl: string): MarketplaceSourceRegistryV1 {
  return seedCuratedMarketplaceSourceRegistryV1(
    {
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [],
    },
    createCuratedMarketplaceSourceV1(sourceUrl),
  );
}

export function seedCuratedMarketplaceSourceRegistryV1(
  registry: MarketplaceSourceRegistryV1,
  curatedSource: MarketplaceSourceV1,
): MarketplaceSourceRegistryV1 {
  const existing = registry.sources.some((entry) => entry.id === curatedSource.id || entry.sourceUrl === curatedSource.sourceUrl);
  if (existing) {
    return registry;
  }

  return {
    ...registry,
    sources: [curatedSource, ...registry.sources],
  };
}

export function resolvePreferredMarketplaceSource(sources: readonly MarketplaceSourceV1[]): MarketplaceSourceV1 | null {
  const enabledCurated = sources.find((entry) => entry.enabled && entry.origin === 'curated') ?? null;
  if (enabledCurated) return enabledCurated;
  const enabledSource = sources.find((entry) => entry.enabled) ?? null;
  if (enabledSource) return enabledSource;
  return null;
}
