import { describe, expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { checkRegistryUpstreamV1 } from '../registryUpdatesV1.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '../registryActionsV1.js';
import { RegistryFetchRequestV1Schema } from '../registryRpcV1.js';
import type { RegistrySourceDescriptorV1 } from '../registrySourcesV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';

const source: RegistrySourceDescriptorV1 = { id: 'builtin:open-vsx', title: 'Open VSX', format: 'open-vsx',
  kinds: ['theme'], url: 'https://open-vsx.org/api', enabled: true, addedAt: 0, origin: { kind: 'built_in' }, removable: false };
const manifest = { publisher: 'sample', name: 'palette', version: '1.0.0', contributes: { themes: [
  { label: 'Night', uiTheme: 'vs-dark', path: './themes/night.json' },
  { label: 'Day', uiTheme: 'vs', path: './themes/day.json' },
] } };
async function fixture(options: Readonly<{ badHash?: boolean; badIdentity?: boolean; absentLicense?: boolean; cycle?: boolean; missing?: boolean; caseMismatch?: boolean }> = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [path, text] of Object.entries({
    'extension/package.json': JSON.stringify(options.badIdentity ? { ...manifest, version: '2.0.0' } : manifest),
    [options.caseMismatch ? 'extension/themes/Base.json' : 'extension/themes/base.json']: JSON.stringify({ colors: { 'editor.foreground': '#eeeeee' } }),
    [options.caseMismatch ? 'extension/themes/Night.json' : 'extension/themes/night.json']: JSON.stringify({ include: options.cycle ? './night.json' : options.missing ? './missing.json' : './base.json', colors: { 'editor.background': '#111111' } }),
    'extension/themes/day.json': JSON.stringify({ include: './base.json', colors: { 'editor.background': '#ffffff' } }),
    'extension/unrelated.bin': 'x'.repeat(500000),
  })) await writer.add(path, new Uint8ArrayReader(new TextEncoder().encode(text)), { useWebWorkers: false });
  const bytes = await writer.close();
  const calls: string[] = [];
  let latest = '1.0.0';
  const detail = () => ({ namespace: 'sample', name: 'palette', version: latest, displayName: 'Sample palette', ...(options.absentLicense ? {} : { license: 'Custom licence' }),
    files: { manifest: 'https://open-vsx.org/manifest.json', download: 'https://open-vsx.org/package.vsix', sha256: 'https://open-vsx.org/package.sha256' } });
  const http: RegistryHttpV1 = {
    async getJson(url) { calls.push(url); return { ok: true, fetchedAt: 1, value: url.includes('/-/search') ? {
      offset: 0, totalSize: 100, extensions: Array.from({ length: 100 }, (_, i) => ({ namespace: 'sample', name: `palette${i}`, version: '1.0.0', displayName: `Palette ${i}` })),
    } : url.endsWith('/manifest.json') ? manifest : detail() }; },
    async getText(url) { calls.push(url); return { ok: true, fetchedAt: 1, value: options.badHash ? '0'.repeat(64) : bytesToHex(sha256(bytes)) }; },
    async getBytes(url) { calls.push(url); return { ok: true, fetchedAt: 1, value: bytes }; },
  };
  return { calls, http, setLatest: (version: string) => { latest = version; }, host: createRegistryHostV1({ host: 'web', http, readSources: async () => [source] }) };
}
describe('Open VSX theme acquisition through the registry host', () => {
  it('admits the content intent only for theme reads', () => {
    const request = { op: 'read', sourceId: source.id, itemId: 'sample/palette', themeContent: true };
    expect(RegistryFetchRequestV1Schema.safeParse({ ...request, kind: 'theme' }).success).toBe(true);
    expect(RegistryFetchRequestV1Schema.safeParse({ ...request, kind: 'skill' }).success).toBe(false);
  });
  it('browses N summaries with one request and no detail, manifest or package reads', async () => {
    const f = await fixture();
    const result = await f.host.fetchRequest({ op: 'list', sourceId: source.id, kind: 'theme', query: 'palette' });
    expect(result.op).toBe('list');
    if (result.op !== 'list') return;
    expect(result.page.items).toHaveLength(100);
    expect(result.page.items.every(item => item.themeMetadata === undefined)).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(new URL(f.calls[0]!).searchParams.get('category')).toBe('Themes');
  });
  it('reads metadata without package bytes, then acquires all faces with the shared include mapper', async () => {
    const f = await fixture();
    const metadata = await f.host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample/palette', version: '1.0.0' });
    expect(metadata.op === 'read' && metadata.item.payload).toMatchObject({ kind: 'theme', state: 'listing', listing: { license: 'Custom licence', includes: [{ label: 'Night', mode: 'dark' }, { label: 'Day', mode: 'light' }] } });
    expect(f.calls).toHaveLength(2);
    f.calls.length = 0;
    const acquired = await f.host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample/palette', version: '1.0.0', themeContent: true });
    expect(acquired.op).toBe('read');
    if (acquired.op !== 'read' || acquired.item.payload.kind !== 'theme' || acquired.item.payload.state !== 'ready') return;
    expect(acquired.item.payload.themes.map(face => face.mode)).toEqual(['dark', 'light']);
    expect(acquired.item.payload.themes[0]!.document.profile.overrides.dark).toMatchObject({ 'background.canvas': '#111111', 'text.primary': '#eeeeee' });
    expect(f.calls).toHaveLength(4);
  });
  it('acquires a unique case-mismatched theme and its include without another fetch', async () => {
    const f = await fixture({ caseMismatch: true });
    const acquired = await f.host.readRegistryTheme({ sourceId: source.id, itemId: 'sample/palette', version: '1.0.0' });
    expect(acquired.item.payload.themes).toHaveLength(2);
    expect(acquired.item.payload.themes[0]!.document.profile.overrides.dark).toMatchObject({ 'background.canvas': '#111111', 'text.primary': '#eeeeee' });
    expect(f.calls).toHaveLength(4);
  });
  it.each([{ iconThemes: [{ id: 'icons', path: './icons.json' }] }, { productIconThemes: [{ id: 'products', path: './products.json' }] }, { themes: [] }])('settles a non-colour manifest without downloading an archive: %j', async contributes => {
    const f = await fixture();
    const boundary = f.http.getJson;
    f.http.getJson = async (url, options) => url.endsWith('/manifest.json')
      ? (f.calls.push(url), { ok: true, fetchedAt: 1, value: { ...manifest, contributes } })
      : boundary(url, options);
    const result = await f.host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample/palette', version: '1.0.0', themeContent: true });
    expect(result).toMatchObject({ op: 'read', item: { payload: { state: 'ready', themes: [], listing: { includes: [] } } } });
    expect(f.calls).toHaveLength(2);
  });
  it.each([{ badHash: true, issue: 'checksum_mismatch' }, { badIdentity: true, issue: 'manifest_mismatch' },
    { cycle: true, issue: 'include_cycle' }, { missing: true, issue: 'include_unavailable' }])('refuses invalid selected package %j without returning ready content', async options => {
    const f = await fixture(options);
    await expect(f.host.fetchRequest({ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample/palette', version: '1.0.0', themeContent: true }))
      .resolves.toMatchObject({ op: 'error', status: { state: 'invalid_source', themeIssue: options.issue } });
  });
  it('acquires data-only theme content without requiring a licence allowlist', async () => {
    const f = await fixture({ absentLicense: true });
    const acquired = await f.host.readRegistryTheme({ sourceId: source.id, itemId: 'sample/palette' });
    expect(acquired.item.payload.themes).toHaveLength(2);
    expect(acquired.item.payload.listing.license).toBeUndefined();
  });
  it('forwards only native content acquisition to the daemon and retains the request flag', async () => {
    const f = await fixture();
    const requests: unknown[] = [];
    const daemon = createRegistryHostV1({ host: 'node', http: f.http, readSources: async () => [source] });
    const native = createRegistryHostV1({ host: 'native', http: f.http, readSources: async () => [source], daemonFetch: async request => {
      requests.push(request); return daemon.fetchRequest(request);
    } });
    await native.fetchRequest({ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample/palette', version: '1.0.0' });
    expect(requests).toEqual([]);
    const result = await native.fetchRequest({ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample/palette', version: '1.0.0', themeContent: true });
    expect(result.op === 'read' && result.item.payload).toMatchObject({ kind: 'theme', state: 'ready' });
    expect(requests).toEqual([{ op: 'read', sourceId: source.id, kind: 'theme', itemId: 'sample/palette', version: '1.0.0', themeContent: true }]);
  });
  it('returns canonical acquisition provenance after one source read and one admission', async () => {
    const f = await fixture();
    let reads = 0; let admissions = 0;
    const host = createRegistryHostV1({ host: 'web', http: f.http, readSources: async () => { reads++; return [source]; },
      admitSource: async () => { admissions++; return { http: f.http }; } });
    const result = await host.readRegistryTheme({ sourceId: source.id, itemId: 'sample/palette', version: '1.0.0' });
    expect(result.item.payload).toMatchObject({ kind: 'theme', state: 'ready' });
    expect(result.provenance).toMatchObject({ sourceId: source.id, sourceUrl: source.url, format: 'open-vsx', itemId: 'sample/palette', ref: { kind: 'version', version: '1.0.0' } });
    expect(reads).toBe(1); expect(admissions).toBe(1);
  });
  it('acquires selected content for each request without retaining an acquired-content memo', async () => {
    const f = await fixture();
    await f.host.readRegistryTheme({ sourceId: source.id, itemId: 'sample/palette' });
    await f.host.readRegistryTheme({ sourceId: source.id, itemId: 'sample/palette' });
    expect(f.calls.filter(url => url.endsWith('/package.vsix'))).toHaveLength(2);
  });
  it('refuses a metadata-only daemon result when the caller requested installable content', async () => {
    const f = await fixture();
    const native = createRegistryHostV1({ host: 'native', http: f.http, readSources: async () => [source], daemonFetch: async request =>
      f.host.fetchRequest(request.op === 'read' ? { ...request, themeContent: undefined } : request) });
    await expect(native.readRegistryTheme({ sourceId: source.id, itemId: 'sample/palette' }))
      .rejects.toMatchObject({ status: { state: 'invalid_source' } });
  });
  it('checks one listing once across two installed faces', async () => {
    const f = await fixture(); f.setLatest('2.0.0');
    const provenance = { sourceId: source.id, sourceUrl: source.url, format: 'open-vsx' as const, itemId: 'sample/palette', ref: { kind: 'version' as const, version: '1.0.0' }, importedAt: 1 };
    const result = await checkRegistryUpstreamV1({ http: f.http }, { sources: [source], items: [{ key: 'night', provenance }, { key: 'day', provenance }] });
    expect([...result.values()].map(value => value.state)).toEqual(['update_available', 'update_available']);
    expect(f.calls).toHaveLength(1);
  });
  it('routes theme updates through client-owned installed provenance', async () => {
    const f = await fixture(); f.setLatest('2.0.0');
    const provenance = { sourceId: source.id, sourceUrl: source.url, format: 'open-vsx' as const, itemId: 'sample/palette', ref: { kind: 'version' as const, version: '1.0.0' }, importedAt: 1 };
    const host = createRegistryHostV1({ host: 'web', http: f.http, readSources: async () => [source],
      readThemeUpdateItems: async () => [{ key: 'night', provenance }, { key: 'day', provenance }] });
    const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(
      await host.execute('registries.updates.check', { kind: 'theme', keys: ['night', 'day'] }));
    expect(result.results.map(item => ({ kind: item.kind, key: item.key, state: item.upstream.state })))
      .toEqual([{ kind: 'theme', key: 'night', state: 'update_available' }, { kind: 'theme', key: 'day', state: 'update_available' }]);
    expect(f.calls).toHaveLength(1);
  });
  it('includes Account theme observations in the ordinary all-kind update check', async () => {
    const f = await fixture(); f.setLatest('2.0.0');
    const provenance = { sourceId: source.id, sourceUrl: source.url, format: 'open-vsx' as const, itemId: 'sample/palette', ref: { kind: 'version' as const, version: '1.0.0' }, importedAt: 1 };
    const host = createRegistryHostV1({ host: 'web', http: f.http, readSources: async () => [source],
      readThemeUpdateItems: async () => [{ key: 'night', provenance }, { key: 'day', provenance }],
      // The remaining kinds are supplied by the existing daemon transport boundary.
      updates: async () => ({ checkedAt: 1, results: [] }) });
    const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(
      await host.execute('registries.updates.check', {}));
    expect(result.results.map(item => ({ kind: item.kind, key: item.key, state: item.upstream.state })))
      .toEqual([{ kind: 'theme', key: 'night', state: 'update_available' }, { kind: 'theme', key: 'day', state: 'update_available' }]);
    expect(f.calls).toHaveLength(1);
  });
});

describe('Open VSX theme summaries', () => {
  it('drops a description that only repeats the title and keeps a real one', async () => {
    const http: RegistryHttpV1 = {
      async getJson() { return { ok: true, fetchedAt: 1, value: { offset: 0, totalSize: 2, extensions: [
        { namespace: 'jdinhlife', name: 'gruvbox', version: '1.29.2', displayName: 'Gruvbox Theme', description: ' gruvbox theme ' },
        { namespace: 'sample', name: 'harbor', version: '1.0.0', displayName: 'Harbor', description: 'A calm blue theme.' },
      ] } }; },
      async getText() { throw new Error('unexpected text read'); },
      async getBytes() { throw new Error('unexpected byte read'); },
    };
    const host = createRegistryHostV1({ host: 'web', http, readSources: async () => [source] });
    const result = await host.fetchRequest({ op: 'list', sourceId: source.id, kind: 'theme', query: '' });
    if (result.op !== 'list') throw new Error('expected a list');
    expect(result.page.items.map(item => [item.title, item.description])).toEqual([['Gruvbox Theme', undefined], ['Harbor', 'A calm blue theme.']]);
  });
});
