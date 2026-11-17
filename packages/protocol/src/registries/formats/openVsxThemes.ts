import { z } from '../../zodRuntimePolicy.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { parseThemeProfileDocument } from '../../account/settings/themeProfiles.js';
import { VS_CODE_THEME_IMPORT_ADAPTER, resolveVsCodeThemeIncludes, ThemeImportIssueError } from '../../account/settings/themeProfileExternalThemeImportVsCode.js';
import { RegistryFetchErrorV1 } from '../registryListV1.js';
import type { RegistryItemSummaryV1, RegistryItemV1, RegistryContentRefV1 } from '../registryItemsV1.js';
import type { RegistryThemeListingV1, RegistryThemeFaceV1 } from '../registryThemeV1.js';
import { OpenVsxThemePackageV1Schema, RegistryThemeContentUrlV1Schema } from '../registryThemeV1.js';
import type { RegistryFormatAdapterV1, RegistryFetchContextV1 } from './registryFormatAdapterV1.js';
import type { RegistrySourceV1 } from '../registrySourcesV1.js';

const nonempty = () => z.string().check(z.minLength(1));
const summarySchema = z.object({ namespace: nonempty(), name: nonempty(), version: nonempty(), displayName: z.optional(z.string()),
  description: z.optional(z.string()), files: z.optional(z.object({ icon: z.optional(RegistryThemeContentUrlV1Schema) })) });
const detailSchema = z.object({ ...summarySchema.shape, license: z.optional(z.string()), files: z.object({ manifest: RegistryThemeContentUrlV1Schema,
  download: RegistryThemeContentUrlV1Schema, sha256: RegistryThemeContentUrlV1Schema, icon: z.optional(RegistryThemeContentUrlV1Schema) }) });
const manifestSchema = z.object({ publisher: nonempty(), name: nonempty(), version: nonempty(), contributes: z.object({ themes: z.array(z.object({
  path: nonempty(), label: z.optional(z.string()), id: z.optional(z.string()), uiTheme: z.optional(z.string()),
})) }) });
const invalid = (themeIssue?: import('../registryThemeV1.js').RegistryThemeIssueV1) => new RegistryFetchErrorV1({ state: 'invalid_source', ...(themeIssue ? { themeIssue } : {}) });
function parse<T>(schema: z.ZodMiniType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data;
}
function api(source: RegistrySourceV1, suffix: string): string { return `${source.url.replace(/\/$/, '')}/${suffix}`; }
function selectedPath(itemId: string): string {
  const parts = itemId.split('/'); if (parts.length !== 2 || parts.some(part => !part || part === '.' || part === '..')) throw invalid();
  return parts.map(encodeURIComponent).join('/');
}
function summary(source: RegistrySourceV1, value: z.infer<typeof summarySchema>): RegistryItemSummaryV1 {
  const title = value.displayName || value.name;
  // Many theme packages describe themselves with their own name ("Gruvbox Theme"): that says nothing the title
  // does not, so it is no description.
  const description = value.description?.trim();
  return { sourceId: source.id, kind: 'theme', itemId: `${value.namespace}/${value.name}`, title,
    version: value.version, publisher: { name: value.namespace },
    ...(!description || description.toLowerCase() === title.trim().toLowerCase() ? {} : { description }),
    ...(value.files?.icon === undefined ? {} : { iconUrl: value.files.icon }) };
}
async function json(ctx: RegistryFetchContextV1, source: RegistrySourceV1, url: string) {
  const response = await ctx.http.getJson(url, { source }); if (!response.ok) throw new RegistryFetchErrorV1(response.status); return response;
}
function packagePath(path: string, from = 'extension/package.json'): string {
  if (/^(?:[\\/]|[A-Za-z][A-Za-z\d+.-]*:)/.test(path) || path.includes('\0')) throw invalid();
  const resolved = from.split('/').slice(0, -1);
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (resolved.length <= 1) throw invalid(); resolved.pop(); }
    else resolved.push(part);
  }
  if (resolved[0] !== 'extension' || resolved.length <= 1) throw invalid();
  return resolved.join('/');
}
function describe(manifest: z.infer<typeof manifestSchema>, license?: string): RegistryThemeListingV1 {
  const counts = new Map<string, number>();
  const paths = manifest.contributes.themes.map(theme => packagePath(theme.path));
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  return { includes: manifest.contributes.themes.map((theme, index) => ({ key: counts.get(paths[index]!) === 1 ? paths[index]! : `${paths[index]}#${index}`,
    label: theme.label || theme.id || paths[index]!.split('/').at(-1)!,
    ...(theme.uiTheme === 'vs' || theme.uiTheme === 'hc-light' ? { mode: 'light' as const }
      : theme.uiTheme === 'vs-dark' || theme.uiTheme === 'hc-black' ? { mode: 'dark' as const } : {}) })),
    ...(license === undefined ? {} : { license }) };
}
function sameManifest(actual: z.infer<typeof manifestSchema>, expected: z.infer<typeof manifestSchema>) {
  return actual.publisher === expected.publisher && actual.name === expected.name && actual.version === expected.version
    && JSON.stringify(actual.contributes.themes) === JSON.stringify(expected.contributes.themes);
}

export const openVsxThemesRegistryAdapterV1: RegistryFormatAdapterV1 = {
  format: 'open-vsx', kinds: ['theme'], browserFetchable: () => true, supportsQuery: true,
  async list(ctx, req) {
    try {
      if (req.kind !== 'theme') throw invalid();
      const url = new URL(api(req.source, '-/search')); url.searchParams.set('category', 'Themes');
      if (req.query) url.searchParams.set('query', req.query);
      if (req.cursor !== undefined && req.cursor !== null) { if (!/^\d+$/.test(req.cursor)) throw invalid(); url.searchParams.set('offset', req.cursor); }
      const response = await json(ctx, req.source, url.toString());
      const search = parse(z.object({ extensions: z.array(summarySchema), offset: z.number().check(z.int(), z.nonnegative()), totalSize: z.number().check(z.int(), z.nonnegative()) }), response.value);
      const offset = search.offset + search.extensions.length;
      return { sourceId: req.source.id, status: { state: 'ok', fetchedAt: response.fetchedAt }, items: search.extensions.map(item => summary(req.source, item)),
        total: search.totalSize, nextCursor: search.extensions.length > 0 && offset < search.totalSize ? String(offset) : null };
    } catch (error) { if (error instanceof RegistryFetchErrorV1) return { sourceId: req.source.id, status: error.status, items: [], nextCursor: null }; throw error; }
  },
  async read(ctx, req) {
    if (req.kind !== 'theme') throw invalid();
    const response = await json(ctx, req.source, api(req.source, `${selectedPath(req.itemId)}/${encodeURIComponent(req.version ?? 'latest')}`));
    const detail = parse(detailSchema, response.value);
    if (`${detail.namespace}/${detail.name}` !== req.itemId || req.version !== undefined && detail.version !== req.version) throw invalid();
    const metadata = await json(ctx, req.source, detail.files.manifest);
    const manifest = parse(manifestSchema, metadata.value);
    if (manifest.publisher !== detail.namespace || manifest.name !== detail.name || manifest.version !== detail.version) throw invalid('manifest_mismatch');
    const listing = describe(manifest, detail.license);
    const acquisition = OpenVsxThemePackageV1Schema.parse({ namespace: detail.namespace, name: detail.name, version: detail.version,
      downloadUrl: detail.files.download, checksumUrl: detail.files.sha256, ...(detail.license === undefined ? {} : { license: detail.license }) });
    const itemSummary = { ...summary(req.source, detail), ...(detail.license === undefined ? {} : { license: detail.license }), themeMetadata: listing };
    if (!req.themeContent) return { summary: itemSummary, fetchedAt: response.fetchedAt,
      payload: { kind: 'theme', state: 'listing', version: detail.version, listing, acquisition } };
    const [download, checksum] = await Promise.all([ctx.http.getBytes(acquisition.downloadUrl, { source: req.source }), ctx.http.getText(acquisition.checksumUrl, { source: req.source })]);
    if (!download.ok) throw new RegistryFetchErrorV1(download.status);
    if (!checksum.ok) throw new RegistryFetchErrorV1(checksum.status);
    ctx.signal?.throwIfAborted();
    const expected = /^([a-f\d]{64})(?:\s+.*)?$/i.exec(checksum.value.trim())?.[1]?.toLowerCase();
    if (!expected || bytesToHex(sha256(download.value)) !== expected) throw invalid('checksum_mismatch');
    const { openZipEntriesV1 } = await import('../../archives/zipEntriesV1.js');
    const archive = await openZipEntriesV1(download.value, ctx.signal).catch(() => { ctx.signal?.throwIfAborted(); throw invalid('invalid_package'); });
    try {
      const textByPath = new Map<string, string>();
      const read = async (path: string) => {
        ctx.signal?.throwIfAborted();
        const held = textByPath.get(path);
        if (held !== undefined) return held;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await archive.read(path));
        textByPath.set(path, text);
        return text;
      };
      const actual = parse(manifestSchema, JSON.parse(await read('extension/package.json')));
      if (!sameManifest(actual, manifest)) throw invalid('manifest_mismatch');
      const themes: RegistryThemeFaceV1[] = [];
      for (const [index, theme] of actual.contributes.themes.entries()) {
        const path = packagePath(theme.path);
        const resolved = await resolveVsCodeThemeIncludes({ root: { id: path, text: await read(path) }, signal: ctx.signal,
          read: async (relative, from) => { const id = packagePath(relative, from); return { id, text: await read(id) }; } });
        const face = listing.includes[index]!;
        const profile = VS_CODE_THEME_IMPORT_ADAPTER.parse({ ...resolved, name: face.label,
          ...(face.mode === undefined ? {} : { type: face.mode }), id: `theme_${bytesToHex(sha256(new TextEncoder().encode(`${req.source.id}/${req.itemId}/${face.key}`)))}` }, { now: new Date(response.fetchedAt).toISOString() });
        const parsed = profile && parseThemeProfileDocument(profile);
        if (!parsed || !parsed.ok) throw invalid();
        themes.push({ key: face.key, label: face.label, mode: face.mode ?? profile.assetAppearance ?? 'dark', document: parsed.document });
      }
      return { summary: itemSummary, fetchedAt: response.fetchedAt, payload: { kind: 'theme', state: 'ready', version: detail.version,
        listing, themes, ref: { kind: 'version', version: detail.version } } } satisfies RegistryItemV1;
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (error instanceof RegistryFetchErrorV1) throw error;
      if (error instanceof ThemeImportIssueError) throw invalid(error.code);
      if (error instanceof Error) throw invalid('invalid_package');
      throw error;
    } finally { await archive.close(); }
  },
  async latest(ctx, items, options) {
    if (!options?.source) throw invalid();
    const source = options.source;
    const result = new Map<string, RegistryContentRefV1 | 'removed'>();
    await Promise.all([...new Set(items.map(item => item.itemId))].map(async itemId => {
      const response = await json(ctx, source, api(source, `${selectedPath(itemId)}/latest`));
      const detail = parse(detailSchema, response.value);
      if (`${detail.namespace}/${detail.name}` !== itemId) throw invalid();
      result.set(itemId, { kind: 'version', version: detail.version });
    }));
    return result;
  },
};
