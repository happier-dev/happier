import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { normalizeStrictJsonValue } from '../../json/strictJsonValue.js';
import { RegistryStarterCatalogV1Schema, type RegistryStarterCatalogV1 } from '../registryStarterV1.js';
import type { RegistryItemSummaryV1, RegistryItemV1 } from '../registryItemsV1.js';
import type { RegistryPackagedSourceDescriptorV1, RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistryListPageV1 } from '../registryListV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';

export function parseStarterCatalogV1(value: unknown): RegistryStarterCatalogV1 {
  const parsed = RegistryStarterCatalogV1Schema.safeParse(value);
  if (!parsed.success) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return parsed.data;
}

export function listHappierStarterCatalogV1(input: Readonly<{ sourceId: string; catalog: RegistryStarterCatalogV1; fetchedAt: number; query?: string }>): RegistryListPageV1 {
  const query = input.query?.trim().toLocaleLowerCase();
  const items = input.catalog.starters.map(entry => ({
    sourceId: input.sourceId, kind: 'starter' as const, itemId: entry.itemId, title: entry.starter.title,
    description: entry.starter.description, appMetadata: { tags: entry.starter.tags },
  })).filter(item => !query || `${item.itemId} ${item.title} ${item.description} ${item.appMetadata?.tags?.join(' ')}`.toLocaleLowerCase().includes(query));
  return { sourceId: input.sourceId, status: { state: 'ok', fetchedAt: input.fetchedAt }, items, total: items.length, nextCursor: null };
}

export function readHappierStarterCatalogItemV1(input: Readonly<{ sourceId: string; catalog: RegistryStarterCatalogV1; fetchedAt: number; itemId: string; packageContent?: RegistryPackagedSourceDescriptorV1['packageContent'] }>): RegistryItemV1 {
  const entry = input.catalog.starters.find(candidate => candidate.itemId === input.itemId);
  if (!entry) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const normalized = normalizeStrictJsonValue(entry.starter);
  const digest = `sha256:${bytesToHex(sha256(new TextEncoder().encode(createCanonicalJsonSigningInput(normalized))))}`;
  const ref = input.packageContent ? { kind: 'packageContent' as const, ...input.packageContent, digest } : { kind: 'content' as const, digest };
  const version = ref.kind === 'packageContent' ? ref.pluginVersion : ref.digest;
  const summary: RegistryItemSummaryV1 = { sourceId: input.sourceId, kind: 'starter', itemId: entry.itemId,
    title: entry.starter.title, description: entry.starter.description, version, appMetadata: { tags: entry.starter.tags } };
  return { summary, payload: { kind: 'starter', starter: entry.starter, ref }, fetchedAt: input.fetchedAt };
}
