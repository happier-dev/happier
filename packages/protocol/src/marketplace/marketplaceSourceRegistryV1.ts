import { lazyZodSchema } from '../lazyZodSchema.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { z } from 'zod';

import { NpmRegistryProfileIdV1Schema } from '../rpc/npmRegistryProfiles.js';

export const MarketplaceSourceOriginV1Schema = lazyZodSchema(() => z.enum(['user', 'curated']));
export type MarketplaceSourceOriginV1 = z.infer<typeof MarketplaceSourceOriginV1Schema>;

const MarketplaceSourceIdV1Schema = lazyZodSchema(() => z.string().trim().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u));

const MarketplaceSourceUrlV1Schema = lazyZodSchema(() => z.string().trim().min(1).transform((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) {
      context.addIssue({ code: 'custom', message: 'Expected a credential-free HTTPS marketplace source URL' });
      return z.NEVER;
    }
    return url.toString();
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected a credential-free HTTPS marketplace source URL' });
    return z.NEVER;
  }
}));

export const MarketplaceSourceV1Schema = lazyZodSchema(() => z.object({
  id: MarketplaceSourceIdV1Schema,
  title: z.string().trim().min(1),
  sourceUrl: MarketplaceSourceUrlV1Schema,
  enabled: z.boolean(),
  origin: MarketplaceSourceOriginV1Schema,
  registryProfileId: NpmRegistryProfileIdV1Schema.optional(),
  description: z.string().trim().min(1).nullable().optional(),
  addedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  updatedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict());
export type MarketplaceSourceV1 = z.infer<typeof MarketplaceSourceV1Schema>;

export const MarketplaceSourceRegistryV1Schema = lazyZodSchema(() => z.object({
  t: z.literal('happier_marketplace_source_registry_v1'),
  schemaVersion: z.literal(1),
  sources: z.array(MarketplaceSourceV1Schema),
}).strict().superRefine((registry, context) => {
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const [index, source] of registry.sources.entries()) {
    if (ids.has(source.id)) context.addIssue({ code: 'custom', path: ['sources', index, 'id'], message: 'Duplicate marketplace source id' });
    if (urls.has(source.sourceUrl)) context.addIssue({ code: 'custom', path: ['sources', index, 'sourceUrl'], message: 'Duplicate marketplace source URL' });
    ids.add(source.id);
    urls.add(source.sourceUrl);
  }
}));
export type MarketplaceSourceRegistryV1 = z.infer<typeof MarketplaceSourceRegistryV1Schema>;

const MarketplaceSourceMutationInputV1Schema = lazyZodSchema(() => z.object({
  sourceId: MarketplaceSourceIdV1Schema.nullable().optional(),
  sourceUrl: MarketplaceSourceUrlV1Schema,
  title: z.string().trim().min(1).nullable().optional(),
  description: z.string().trim().nullable().optional(),
  enabled: z.boolean().optional(),
  origin: MarketplaceSourceOriginV1Schema.nullable().optional(),
  registryProfileId: NpmRegistryProfileIdV1Schema.nullable().optional(),
}).strict());

/** One source-scoped registry change, applied against daemon-current state. */
export const MarketplaceSourceRegistryMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upsert'), input: MarketplaceSourceMutationInputV1Schema }).strict(),
  z.object({ kind: z.literal('remove'), sourceId: MarketplaceSourceIdV1Schema }).strict(),
  z.object({ kind: z.literal('setEnabled'), sourceId: MarketplaceSourceIdV1Schema, enabled: z.boolean() }).strict(),
  z.object({
    kind: z.literal('setRegistryProfile'),
    sourceId: MarketplaceSourceIdV1Schema,
    registryProfileId: NpmRegistryProfileIdV1Schema.nullable(),
  }).strict(),
]));
export type MarketplaceSourceRegistryMutationV1 = z.infer<typeof MarketplaceSourceRegistryMutationV1Schema>;

export const DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE = 'Happier curated marketplace';
export const DEFAULT_CURATED_MARKETPLACE_SOURCE_DESCRIPTION = 'Official curated source';
export const DEFAULT_CURATED_MARKETPLACE_SOURCE_URL = 'https://marketplace.happier.dev/catalog.json';

export type MarketplaceSourceRecordInputV1 = Readonly<{
  sourceUrl: string;
  title?: string | null;
  description?: string | null;
  enabled?: boolean;
  origin?: MarketplaceSourceOriginV1;
  registryProfileId?: string | null;
}>;

export function normalizeMarketplaceSourceUrlV1(sourceUrl: string): string {
  return MarketplaceSourceUrlV1Schema.parse(String(sourceUrl ?? ''));
}

export function deriveMarketplaceSourceId(sourceUrl: string): string {
  return `marketplace:${bytesToHex(sha256(utf8ToBytes(String(sourceUrl ?? '').trim()))).slice(0, 12)}`;
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
    ...(input.registryProfileId !== undefined
      ? input.registryProfileId === null ? {} : { registryProfileId: input.registryProfileId }
      : existing?.registryProfileId !== undefined
        ? { registryProfileId: existing.registryProfileId }
        : {}),
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
