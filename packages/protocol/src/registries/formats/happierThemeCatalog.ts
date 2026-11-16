import { z } from '../../zodRuntimePolicy.js';
import { parseThemeProfileDocument } from '../../account/settings/themeProfiles.js';
import { RegistryThemeFaceV1Schema, type RegistryThemeCatalogEntryV1, type RegistryThemeFaceV1 } from '../registryThemeV1.js';
import type { RegistryItemSummaryV1, RegistryItemV1 } from '../registryItemsV1.js';
import type { RegistryFetchContextV1 } from './registryFormatAdapterV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';

const rawFace = z.strictObject({ ...RegistryThemeFaceV1Schema.shape, document: z.unknown() });
export function registryThemeCatalogSummaryV1(sourceId: string, entry: RegistryThemeCatalogEntryV1): RegistryItemSummaryV1 {
  return { sourceId, kind: 'theme', itemId: entry.itemId, title: entry.title, version: entry.version, themeMetadata: entry.listing,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.listing.license === undefined ? {} : { license: entry.listing.license }) };
}
export async function readHappierThemeCatalogItemV1(ctx: RegistryFetchContextV1, input: Readonly<{
  source: RegistrySourceV1; entries: readonly RegistryThemeCatalogEntryV1[]; itemId: string; version?: string; fetchedAt: number; themeContent?: true;
}>): Promise<RegistryItemV1> {
  const matches = input.entries.filter(entry => entry.itemId === input.itemId && (input.version === undefined || entry.version === input.version));
  if (matches.length !== 1) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const entry = matches[0]!;
  if (!input.themeContent) return { summary: registryThemeCatalogSummaryV1(input.source.id, entry), fetchedAt: input.fetchedAt,
    payload: { kind: 'theme', state: 'listing', version: entry.version, listing: entry.listing } };
  let raw: unknown = entry.themes;
  if (entry.contentUrl) {
    const response = await ctx.http.getJson(entry.contentUrl, { source: input.source });
    if (!response.ok) throw new RegistryFetchErrorV1(response.status);
    const parsed = z.strictObject({ themes: z.array(z.unknown()) }).safeParse(response.value);
    if (!parsed.success) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    raw = parsed.data.themes;
  }
  const parsed = z.array(rawFace).safeParse(raw);
  if (!parsed.success) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  const themes: RegistryThemeFaceV1[] = parsed.data.map(face => {
    const document = parseThemeProfileDocument(face.document);
    if (!document.ok) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
    return { ...face, document: document.document };
  });
  return { summary: registryThemeCatalogSummaryV1(input.source.id, entry), fetchedAt: input.fetchedAt,
    payload: { kind: 'theme', state: 'ready', version: entry.version, listing: entry.listing, themes, ref: { kind: 'version', version: entry.version } } };
}
