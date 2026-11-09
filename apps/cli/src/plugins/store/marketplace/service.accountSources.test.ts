import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { StoredPromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace/marketplaceSourceRegistryV1';
import { MarketplaceIndexSourceSnapshotV1Schema } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import { createPluginCompatibilityProjectionV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { createMarketplaceNpmDiscoveryProjectionV1 } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 } from '@happier-dev/protocol/marketplace/internal';
import { createPluginRegistrySourceDescriptorV1, listRegistrySourcesV1 } from '@happier-dev/protocol/registries';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createMarketplaceIndexService } from './service';
import { resolveExactMarketplaceListingForInstall, projectExpectedMarketplaceListing, marketplaceListingMatchesExpected } from './exactInstall';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createCliRegistryHostV1, readCliRegistrySourcesV1 } from '@/registries/createCliRegistryHost';

// DNS and HTTP are genuine system boundaries. Account hydration/read, parsing,
// source targeting, acquisition, strict output and install review stay real.
vi.mock('node:dns/promises', async (original) => ({ ...await original<typeof import('node:dns/promises')>(),
  lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('undici', async (original) => { const actual = await original<typeof import('undici')>(); return { ...actual, fetch: vi.fn(actual.fetch) }; });
// Credential-file access is an external boundary; these cases use the actual
// already-observed Account catalog and never the developer's login material.
vi.mock('@/persistence', async (original) => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => null }));
const homes: string[] = [];
const sourceUrl = 'https://catalog.example/plugins.json';
const sourceId = deriveMarketplaceSourceId(sourceUrl);
let revision = 0;
function accountSources(sources: readonly { enabled: boolean }[]) {
  const record = StoredPromptLibraryRecordV1Schema.parse({ key: 'registry-sources', value: { v: 2,
    sources: sources.map(source => ({ ...source, id: sourceId, title: 'Team', format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl, addedAt: 0 })),
    disabledSourceIds: [] } });
  setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'account-u3', settings: accountSettingsParse({}),
    settingsVersion: ++revision, loadedAtMs: 1, settingsSecretsReadKeys: [],
    promptLibraryCatalog: { status: 'ready', rows: [{ record, revision }], tombstones: [], diagnostics: [] } });
}
const catalog = () => MarketplaceIndexSourceSnapshotV1Schema.parse({ source: { id: sourceId, title: 'Team', sourceUrl, kind: 'user' },
  freshness: { state: 'fresh', fetchedAtMs: 1 }, diagnostics: [], entries: [{
    pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Plugin', description: null },
    distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: '@acme/plugin', version: '1.0.0',
      integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
    manifestDigest: `sha256:${'a'.repeat(64)}`, compatibility: { platforms: ['linux'] },
    summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
    review: { status: 'unreviewed', reviewedAt: null }, categories: [], media: [], updatePolicy: 'allowed', links: {},
  }] });

describe('Account marketplace sources and exact install seam', () => {
  beforeEach(()=>vi.stubGlobal('fetch',undici.fetch));
  afterEach(async () => { vi.unstubAllGlobals();vi.mocked(undici.fetch).mockReset(); resetActiveAccountSettingsSnapshotForTests();
    await Promise.all(homes.splice(0).map(removeTempDir)); });
  it('reads the Account source and refuses removed or disabled bindings before HTTP or install effects', async () => {
    const home = await createTempDir('happier-marketplace-account-u3-'); homes.push(home);
    accountSources([{ enabled: true }]);
    vi.mocked(undici.fetch).mockImplementation(async () => new undici.Response(JSON.stringify(catalog()), { status: 200 }));
    const service = createMarketplaceIndexService({ happyHomeDir: home });
    const exact = await service.queryExactListing({ sourceId, pluginId: 'acme.plugin' });
    expect(exact).toMatchObject({ ok: true, result: { items: [{ pluginId: 'acme.plugin', admission: { install: 'full-review' } }] } });
    accountSources([]); vi.mocked(undici.fetch).mockClear();
    expect(await resolveExactMarketplaceListingForInstall({ happyHomeDir: home, sourceId, pluginId: 'acme.plugin' })).toMatchObject({ ok: false, code: 'install_unavailable' });
    expect(vi.mocked(undici.fetch)).not.toHaveBeenCalled();
    accountSources([{ enabled: false }]);
    expect(await service.queryExactListing({ sourceId, pluginId: 'acme.plugin' })).toMatchObject({ ok: false, code: 'install_unavailable' });
  });
  it('admits a source once per lookup and observes removal on the next lookup', async () => {
    const home = await createTempDir('happier-marketplace-account-race-u3-'); homes.push(home);
    accountSources([{ enabled: true }]);
    vi.mocked(undici.fetch).mockImplementation(async () => new undici.Response(JSON.stringify(catalog()), { status: 200 }));
    const readSources = vi.fn(() => readCliRegistrySourcesV1());
    const host = createCliRegistryHostV1({ readSources });
    const service = createMarketplaceIndexService({ happyHomeDir: home, registryHost: host });
    expect(await service.queryExactListing({ sourceId, pluginId: 'acme.plugin' }))
      .toMatchObject({ ok: true, result: { items: [{ pluginId: 'acme.plugin' }] } });
    expect(readSources).toHaveBeenCalledTimes(1);
    expect(undici.fetch).toHaveBeenCalledTimes(1);
    accountSources([]);
    expect(await service.queryExactListing({ sourceId, pluginId: 'acme.plugin' }))
      .toMatchObject({ ok: false, code: 'install_unavailable' });
    expect(readSources).toHaveBeenCalledTimes(2);
    expect(undici.fetch).toHaveBeenCalledTimes(1);
  });
  it('revalidates a retained reviewed catalog version, never latest, and refuses its removal', async () => {
    const home = await createTempDir('happier-marketplace-account-pin-u3-'); homes.push(home);
    accountSources([{ enabled: true }]);
    const body = catalog();
    vi.mocked(undici.fetch).mockImplementation(async () => new undici.Response(JSON.stringify(body), { status: 200 }));
    const initial = await resolveExactMarketplaceListingForInstall({ happyHomeDir: home, sourceId, pluginId: 'acme.plugin' });
    if (!initial.ok) throw new Error('Expected initially installable listing');
    const expected = projectExpectedMarketplaceListing(initial.resolution.listing, null);
    const older = body.entries[0]!;
    const newer = { ...older, distribution: { ...older.distribution, version: '2.0.0' } };
    body.entries = [newer, older];
    const pinned = await resolveExactMarketplaceListingForInstall({ happyHomeDir: home, sourceId,
      pluginId: expected.pluginId, packageName: expected.packageName, version: expected.version });
    expect(pinned).toMatchObject({ ok: true, resolution: { listing: { distribution: { version: '1.0.0' } } } });
    if (!pinned.ok) throw new Error('Expected retained exact listing');
    expect(marketplaceListingMatchesExpected(expected, pinned.resolution.listing)).toBe(true);
    body.entries = [newer];
    expect(await resolveExactMarketplaceListingForInstall({ happyHomeDir: home, sourceId,
      pluginId: expected.pluginId, packageName: expected.packageName, version: expected.version }))
      .toMatchObject({ ok: false, code: 'install_unavailable' });
  });
  it('keeps the commitment comparison boolean when the canonical review decision refuses a listing', async () => {
    const home = await createTempDir('happier-marketplace-account-review-u3-'); homes.push(home);
    accountSources([{ enabled: true }]);
    vi.mocked(undici.fetch).mockImplementation(async () => new undici.Response(JSON.stringify(catalog()), { status: 200 }));
    const result = await resolveExactMarketplaceListingForInstall({ happyHomeDir: home, sourceId, pluginId: 'acme.plugin' });
    if (!result.ok) throw new Error('Expected admitted listing');
    const expected = projectExpectedMarketplaceListing(result.resolution.listing, null);
    expect(marketplaceListingMatchesExpected(expected, { ...result.resolution.listing,
      review: { status: 'blocked', reviewedAt: null } })).toBe(false);
  });
  it('binds a proven installed declaration to the published catalog before exact lookup and refuses its removal', async () => {
    const home = await createTempDir('happier-marketplace-declaration-u3-'); homes.push(home);
    const source = createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.sources', suppliers: ['installed-source-plugin'],
      definition: { id: 'team', title: 'Team declaration', format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl } });
    let pluginSources = [source];
    const readRegistrySources = async () => listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources });
    const body = catalog();
    vi.mocked(undici.fetch).mockImplementation(async (_url, options) => new undici.Headers(options?.headers).has('if-none-match')
      ? new undici.Response(null, { status: 304 })
      : new undici.Response(JSON.stringify(body), { status: 200, headers: { etag: 'bound-catalog' } }));
    const service = createMarketplaceIndexService({ happyHomeDir: home, readRegistrySources });
    const input = { sourceId: source.id, pluginId: 'acme.plugin', packageName: '@acme/plugin', version: '1.0.0' };
    const resolved = await resolveExactMarketplaceListingForInstall({ happyHomeDir: home, ...input }, service);
    expect(resolved).toMatchObject({ ok: true, resolution: { listing: { source: { id: source.id, sourceUrl }, distribution: { version: '1.0.0' } } } });
    if (!resolved.ok) throw new Error('Expected proven declaration');
    expect(projectExpectedMarketplaceListing(resolved.resolution.listing, null).source.id).toBe(source.id);
    // A cached bound identity cannot give a user row declaration authority.
    pluginSources = [{ ...source, origin: { kind: 'user' }, removable: true }];
    expect(await service.queryExactListing(input)).toMatchObject({ ok: false, code: 'install_unavailable' });
    expect(await resolveExactMarketplaceListingForInstall({ happyHomeDir: home, ...input }, service))
      .toMatchObject({ ok: false, code: 'install_unavailable' });
    pluginSources = [];
    expect(await resolveExactMarketplaceListingForInstall({ happyHomeDir: home, ...input }, service))
      .toMatchObject({ ok: false, code: 'install_unavailable' });
  });
  it('keeps pinned npm versions out of latest cache reuse and refuses a removed packument version', async () => {
    const home = await createTempDir('happier-marketplace-account-npm-pin-u3-'); homes.push(home);
    accountSources([]);
    const packageName = '@acme/community';
    const metadata = (version: string) => {
      const compatibility = createPluginCompatibilityProjectionV1({ manifest: normalizePluginManifestV2({ schemaVersion: 2, id: 'acme.community', version,
        displayName: 'Community', runtime: { apiVersion: 1 }, entrypoints: { daemon: './index.js' }, hostAccess: { required: [], optional: [] }, contributes: {} }),
        uiArtifacts: { version: 2, entries: [] } });
      return { name: packageName, version, _npmUser: { name: 'acme' }, dist: { integrity: catalog().entries[0]!.distribution.integrity,
        tarball: `https://registry.npmjs.org/community-${version}.tgz` }, happier: { compatibilityProjection: compatibility,
        marketplaceDiscovery: createMarketplaceNpmDiscoveryProjectionV1({ compatibility, manifestDigest: `sha256:${'a'.repeat(64)}` }) } };
    };
    const versions: Record<string, ReturnType<typeof metadata>> = { '1.0.0': metadata('1.0.0'), '2.0.0': metadata('2.0.0') };
    const searchConditions: boolean[] = [];
    vi.mocked(undici.fetch).mockImplementation(async (input, options) => {
      if (String(input).includes('/-/v1/search')) {
        const conditional = new undici.Headers(options?.headers).has('if-none-match'); searchConditions.push(conditional);
        return conditional ? new undici.Response(null, { status: 304 }) : new undici.Response(JSON.stringify({ total: 1,
          objects: [{ package: { name: packageName, version: '2.0.0', publisher: { username: 'acme' } } }] }), { status: 200, headers: { etag: 'search-page' } });
      }
      return new undici.Response(JSON.stringify({ name: packageName, versions, 'dist-tags': { latest: '2.0.0' } }), { status: 200 });
    });
    const service = createMarketplaceIndexService({ happyHomeDir: home });
    const target = { sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, pluginId: 'acme.community', packageName };
    expect(await service.queryExactListing(target)).toMatchObject({ ok: true, result: { items: [{ distribution: { version: '2.0.0' } }] } });
    expect(await resolveExactMarketplaceListingForInstall({ happyHomeDir: home, ...target, version: '1.0.0' }, service))
      .toMatchObject({ ok: true, resolution: { listing: { distribution: { version: '1.0.0' } } } });
    expect(searchConditions).toEqual([]);
    // Retained plugin-id-only callers locate the package through Registry
    // search, then select the reviewed version through its exact read.
    expect(await resolveExactMarketplaceListingForInstall({ happyHomeDir: home,
      sourceId: target.sourceId, pluginId: target.pluginId, version: '1.0.0' }, service))
      .toMatchObject({ ok: true, resolution: { listing: { distribution: { version: '1.0.0' } } } });
    expect(searchConditions).toEqual([false]);
    delete versions['1.0.0'];
    expect(await resolveExactMarketplaceListingForInstall({ happyHomeDir: home, ...target, version: '1.0.0' }, service))
      .toMatchObject({ ok: false, code: 'install_unavailable' });
  });
});
