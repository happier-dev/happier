import { z } from '../../zodRuntimePolicy.js';
import { RegistryFetchErrorV1, type RegistryListPageV1 } from '../registryListV1.js';
import { RegistryPetContentUrlV1Schema, RegistryPetMetadataV1Schema, type RegistryPetMetadataV1 } from '../registryPetV1.js';
import { PetPackageManifestV1Schema } from '../../pets/manifest.js';
import type { RegistryItemV1, RegistryItemSummaryV1 } from '../registryItemsV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';
import type { RegistryFormatAdapterV1, RegistryFetchContextV1 } from './registryFormatAdapterV1.js';

// Contract basis: codex-pet-share 27996ca and petdex 31c0aee, public APIs observed 2026-11-17.
const text = () => z.string().check(z.minLength(1));
const version = () => z.optional(z.number().check(z.int(), z.minimum(1)));
const codexPetSchema = z.object({ id: text(), displayName: text(), description: z.string(), spritesheetUrl: text(),
  spriteVersionNumber: version(), ownerName: z.optional(z.nullable(z.string())), ownerHandle: z.optional(z.nullable(z.string())) });
const dexPetSchema = z.object({ slug: text(), displayName: text(), description: z.string(), spritesheetPath: text(),
  spriteVersionNumber: version(), submittedBy: z.optional(z.nullable(z.object({ name: z.string() }))) });
const codexPageSchema = z.object({ pets: z.array(codexPetSchema), page: z.number().check(z.int(), z.minimum(1)),
  total: z.number().check(z.int(), z.nonnegative()), totalPages: z.number().check(z.int(), z.nonnegative()) });
const dexPageSchema = z.object({ pets: z.array(dexPetSchema), nextCursor: z.nullable(z.number().check(z.int(), z.nonnegative())),
  total: z.number().check(z.int(), z.nonnegative()) });
const dexManifestSchema = z.object({ pets: z.array(z.object({ slug: text(), displayName: text(), spritesheetUrl: text(),
  petJsonUrl: text(), spriteVersionNumber: version(), submittedBy: z.optional(z.nullable(z.string())) })) });

function parse<T>(schema: z.ZodMiniType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return result.data;
}
async function json(ctx: RegistryFetchContextV1, source: RegistrySourceV1, url: string) {
  const response = await ctx.http.getJson(url, { source });
  if (!response.ok) throw new RegistryFetchErrorV1(response.status);
  return response;
}
function metadata(source: RegistrySourceV1, sheet: string, spriteVersionNumber?: number): RegistryPetMetadataV1 {
  const codex = source.format === 'codex-pets';
  return parse(RegistryPetMetadataV1Schema, { spritesheetUrl: contentUrl(source, sheet),
    ...(spriteVersionNumber === undefined ? {} : { spriteVersionNumber }),
    reportUrl: codex ? 'https://github.com/portons/codex-pet-share/issues' : 'https://petdex.dev/legal/takedown',
    termsUrl: codex ? 'https://codex-pets.net/terms' : 'https://petdex.dev/legal/takedown' });
}
function contentUrl(source: RegistrySourceV1, raw: string): string {
  try { return parse(RegistryPetContentUrlV1Schema, new URL(raw, source.url).href); }
  catch { throw new RegistryFetchErrorV1({ state: 'invalid_source' }); }
}
function summary(source: RegistrySourceV1, pet: { id: string; name: string; description: string; author?: string | null;
  sheet: string; version?: number }): RegistryItemSummaryV1 {
  return { sourceId: source.id, kind: 'pet', itemId: pet.id, title: pet.name, description: pet.description,
    ...(pet.author ? { publisher: { name: pet.author } } : {}),
    petMetadata: metadata(source, pet.sheet, pet.version) };
}
function codexSummary(source: RegistrySourceV1, pet: z.infer<typeof codexPetSchema>) {
  return summary(source, { id: pet.id, name: pet.displayName, description: pet.description,
    author: pet.ownerName || pet.ownerHandle, sheet: pet.spritesheetUrl, version: pet.spriteVersionNumber });
}
function dexSummary(source: RegistrySourceV1, pet: z.infer<typeof dexPetSchema>) {
  return summary(source, { id: pet.slug, name: pet.displayName, description: pet.description,
    author: pet.submittedBy?.name, sheet: pet.spritesheetPath, version: pet.spriteVersionNumber });
}
function cursor(raw: string | null | undefined, initial: number) {
  if (raw == null) return initial;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < initial)
    throw new RegistryFetchErrorV1({ state: 'invalid_source' });
  return Number(raw);
}
function selected(summary: RegistryItemSummaryV1, fetchedAt: number, packageId = summary.itemId): RegistryItemV1 {
  const spritesheetPath = new URL(summary.petMetadata!.spritesheetUrl).pathname.toLowerCase().endsWith('.png')
    ? 'spritesheet.png' : 'spritesheet.webp';
  const manifest = parse(PetPackageManifestV1Schema, { id: packageId, displayName: summary.title,
    description: summary.description, spritesheetPath });
  return { summary, fetchedAt, payload: { kind: 'pet', pet: { ...summary.petMetadata!, manifest } } };
}
function adapter(format: 'codex-pets' | 'petdex'): RegistryFormatAdapterV1 {
  const codex = format === 'codex-pets';
  return { format, kinds: ['pet'], browserFetchable: () => false, supportsQuery: true,
    detect: async (_ctx, url) => new URL(url).hostname === (codex ? 'codex-pets.net' : 'petdex.dev')
      ? { format, kinds: ['pet'], title: codex ? 'codex-pets.net' : 'petdex.dev' } : null,
    list: async (ctx, req): Promise<RegistryListPageV1> => {
      if (req.kind !== 'pet') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const url = new URL(codex ? '/api/pets' : '/api/pets/search', req.source.url);
      if (req.query) url.searchParams.set('q', req.query);
      url.searchParams.set(codex ? 'page' : 'cursor', String(cursor(req.cursor, codex ? 1 : 0)));
      const response = await json(ctx, req.source, url.href);
      if (codex) {
        const page = parse(codexPageSchema, response.value);
        return { sourceId: req.source.id, status: { state: 'ok', fetchedAt: response.fetchedAt },
          items: page.pets.map(pet => codexSummary(req.source, pet)), total: page.total,
          nextCursor: page.page < page.totalPages ? String(page.page + 1) : null };
      }
      const page = parse(dexPageSchema, response.value);
      return { sourceId: req.source.id, status: { state: 'ok', fetchedAt: response.fetchedAt },
        items: page.pets.map(pet => dexSummary(req.source, pet)), total: page.total,
        nextCursor: page.nextCursor === null ? null : String(page.nextCursor) };
    },
    read: async (ctx, req) => {
      if (req.kind !== 'pet') throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      if (codex) {
        const response = await json(ctx, req.source, new URL(`/api/pets/${encodeURIComponent(req.itemId)}`, req.source.url).href);
        const pet = parse(z.object({ pet: codexPetSchema }), response.value).pet;
        if (pet.id !== req.itemId) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
        return selected(codexSummary(req.source, pet), response.fetchedAt);
      }
      // Petdex has no anonymous per-slug detail endpoint. Its public manifest owns exact selection.
      const response = await json(ctx, req.source, new URL('/api/manifest', req.source.url).href);
      const pet = parse(dexManifestSchema, response.value).pets.find(pet => pet.slug === req.itemId);
      if (!pet) throw new RegistryFetchErrorV1({ state: 'invalid_source' });
      const petJsonUrl = contentUrl(req.source, pet.petJsonUrl);
      const detail = await json(ctx, req.source, petJsonUrl);
      const manifest = parse(z.object({ id: text(), displayName: text(), description: z.string() }), detail.value);
      return selected(summary(req.source, { id: pet.slug, name: manifest.displayName, description: manifest.description,
        author: pet.submittedBy, sheet: pet.spritesheetUrl, version: pet.spriteVersionNumber }), detail.fetchedAt, manifest.id);
    },
    latest: async () => new Map(),
  };
}
export const codexPetsRegistryAdapterV1 = adapter('codex-pets');
export const petdexRegistryAdapterV1 = adapter('petdex');
