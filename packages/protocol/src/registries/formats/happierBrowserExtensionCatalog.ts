import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { normalizeStrictJsonValue } from '../../json/strictJsonValue.js';
import type { RegistryBrowserExtensionCatalogEntryV1 } from '../registryBrowserExtensionV1.js';
import type { RegistryItemSummaryV1, RegistryItemV1 } from '../registryItemsV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';

export function registryBrowserExtensionSummaryV1(sourceId: string, entry: RegistryBrowserExtensionCatalogEntryV1): RegistryItemSummaryV1 {
  return { sourceId, kind: 'browserExtension', itemId: entry.itemId, title: entry.title,
    ...(entry.description === undefined ? {} : { description: entry.description }) };
}

export function readHappierBrowserExtensionCatalogItemV1(input: Readonly<{
  sourceId: string; entries: readonly RegistryBrowserExtensionCatalogEntryV1[]; itemId: string; version?: string; fetchedAt: number;
}>): RegistryItemV1 {
  const matching = input.entries.filter(entry => entry.itemId === input.itemId);
  if (matching.length !== 1) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const entry = matching[0]!;
  // This pins the selected catalog descriptor. The browser acquisition owner resolves and verifies package versions.
  const digest = `sha256:${bytesToHex(sha256(new TextEncoder().encode(createCanonicalJsonSigningInput(normalizeStrictJsonValue(entry)))))}`;
  if (input.version !== undefined && input.version !== digest) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return { summary: { ...registryBrowserExtensionSummaryV1(input.sourceId, entry), version: digest },
    payload: { kind: 'browserExtension', extension: entry.extension, ref: { kind: 'content', digest } }, fetchedAt: input.fetchedAt };
}
