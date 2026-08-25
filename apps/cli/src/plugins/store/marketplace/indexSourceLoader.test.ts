import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadMarketplaceIndexSource, parseCommunityNpmDiscovery } from './indexSourceLoader';
import type { NpmRegistryJsonClient } from '@/plugins/distribution/npm/resolver';
import { createPluginStateStore } from '@/plugins/store/state.testkit';

const homes: string[] = [];
// DNS is the one system boundary the acquisition owner touches; every fixture
// host is a public destination unless a case supplies a different answer.
const testResolveAddresses = async (): Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]> => (
  [{ address: '93.184.216.34', family: 4 as const }]
);
const source = { id: 'marketplace:curated', title: 'Curated', kind: 'curated' as const, sourceUrl: 'https://marketplace.example.test/catalog.json' };
const communitySource = { id: 'marketplace:community-npm', title: 'Community npm', kind: 'community-npm' as const, sourceUrl: 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin&size=100' };
const COMMUNITY_INTEGRITY = 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==';

function communityHappierMetadata(params: Readonly<{
  marketplaceDiscovery?: Record<string, unknown>;
  compatibilityProjection?: Record<string, unknown>;
}> = {}) {
  const compatibilityProjection = params.compatibilityProjection ?? {
    version: 1,
    manifest: {
      schemaVersion: 2,
      id: 'acme.community',
      version: '1.0.0',
      displayName: 'Community',
      engines: { happier: '>=0.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {},
    },
    uiArtifacts: { version: 1, entries: [] },
  };
  return {
    manifest: '.happier-plugin/plugin.json',
    compatibilityProjection,
    marketplaceDiscovery: params.marketplaceDiscovery ?? {
      version: 1,
      pluginId: 'acme.community',
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      display: { title: 'Community', description: null },
      summary: {
        contributions: [],
        requiredHostAccess: [],
        optionalHostAccess: [],
        executableRealms: ['daemon'],
      },
    },
  };
}

function communityNpmSearchPayload(packageNames: readonly string[] = ['@acme/community']) {
  return {
    objects: packageNames.map((packageName) => ({
      package: {
        name: packageName,
        version: '1.0.0',
        description: 'Community plugin',
        keywords: ['happier-plugin'],
        date: '2026-08-17T00:00:00.000Z',
        links: { npm: `https://www.npmjs.com/package/${packageName}` },
        publisher: { username: 'acme' },
        maintainers: [{ username: 'acme' }],
      },
    })),
  };
}

function communityNpmMetadataClient(happier: unknown): NpmRegistryJsonClient {
  return {
    getJson: vi.fn(async () => ({
      name: '@acme/community',
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          name: '@acme/community',
          version: '1.0.0',
          happier,
          dist: {
            integrity: COMMUNITY_INTEGRITY,
            tarball: 'https://registry.npmjs.org/@acme/community/-/community-1.0.0.tgz',
          },
        },
      },
    })),
  };
}

function snapshot(): MarketplaceIndexSourceSnapshotV1 {
  return {
    source,
    freshness: { state: 'fresh', fetchedAtMs: 1 },
    entries: [],
    diagnostics: [],
  };
}

describe('loadMarketplaceIndexSource', () => {
  afterEach(async () => {
    await Promise.all(homes.splice(0).map(async (home) => await rm(home, { recursive: true, force: true })));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('joins concurrent refresh and performs conditional refresh against an atomic cache', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(snapshot()), { status: 200, headers: { etag: '"v1"' } });
    });

    const first = loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl, now: () => 100 });
    const joined = loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl, now: () => 100 });
    release();
    await expect(Promise.all([first, joined])).resolves.toEqual([expect.objectContaining({ freshness: { state: 'fresh', fetchedAtMs: 100 } }), expect.objectContaining({ freshness: { state: 'fresh', fetchedAtMs: 100 } })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const conditionalFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"v1"');
      return new Response(null, { status: 304 });
    });
    await expect(loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl: conditionalFetch, now: () => 200 })).resolves.toMatchObject({ freshness: { state: 'fresh', fetchedAtMs: 200 } });
  });

  it('keeps bounded cached truth visible offline without converting it to trust authority', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(snapshot()), { status: 200 }), now: () => 100 });

    const offline = await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl: async () => { throw new Error('offline'); }, now: () => 200 });
    expect(offline).toMatchObject({ freshness: { state: 'stale-offline', fetchedAtMs: 100, staleSinceMs: 200 } });
    expect(offline.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'marketplace_source_refresh_failed' })]));
  });

  it('projects source failures before publishing marketplace diagnostics', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const result = await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source,
      happyHomeDir: home,
      fetchImpl: async () => {
        throw new Error(
          `client_secret=marketplace-loader-secret at /Users/alice/private/catalog.json ${'🙂'.repeat(1_200)}`,
        );
      },
    });
    const message = result.diagnostics[0]?.message ?? '';

    expect(message).toContain('[REDACTED]');
    expect(message).toContain('[REDACTED_PATH]');
    expect(message).not.toContain('marketplace-loader-secret');
    expect(message).not.toContain('/Users/alice/private');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(2_048);
  });

  it('labels a rejected online refresh as stale rather than offline', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(snapshot()), { status: 200 }), now: () => 100 });

    const rejected = await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl: async () => new Response('rejected', { status: 500 }), now: () => 200 });
    expect(rejected.freshness).toMatchObject({ state: 'stale', fetchedAtMs: 100, staleSinceMs: 200 });
  });

  it('rejects credential-bearing, non-HTTPS source URLs before network access', async () => {
    const fetchImpl = vi.fn();
    await expect(loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: { ...source, sourceUrl: 'http://token@example.test/catalog.json' }, fetchImpl })).rejects.toThrow('credential-free HTTPS');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('loads bounded exact package metadata for npm search candidates before mapping community listings', async () => {
    const client = communityNpmMetadataClient(communityHappierMetadata());
    const parsed = await parseCommunityNpmDiscovery(communityNpmSearchPayload(), communitySource, { client });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ pluginId: 'acme.community', review: { status: 'unreviewed' }, updatePolicy: 'manual' });
    expect(client.getJson).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://registry.npmjs.org/%40acme%2Fcommunity',
      headers: { accept: 'application/json' },
    }));
  });

  it('rejects community metadata whose discovery projection contradicts its generated compatibility manifest', async () => {
    const client = communityNpmMetadataClient(communityHappierMetadata({
      marketplaceDiscovery: {
        version: 1,
        pluginId: 'acme.attacker',
        manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        display: { title: 'Community', description: null },
        summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      },
    }));

    await expect(parseCommunityNpmDiscovery(communityNpmSearchPayload(), communitySource, { client })).resolves.toMatchObject({ entries: [] });
  });

  it('rejects community metadata whose discovery display contradicts its generated compatibility manifest', async () => {
    const client = communityNpmMetadataClient(communityHappierMetadata({
      marketplaceDiscovery: {
        version: 1,
        pluginId: 'acme.community',
        manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        display: { title: 'Spoofed community', description: null },
        summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      },
    }));

    await expect(parseCommunityNpmDiscovery(communityNpmSearchPayload(), communitySource, { client })).resolves.toMatchObject({ entries: [] });
  });

  it('keeps healthy community listings visible when another package metadata request fails', async () => {
    const healthyClient = communityNpmMetadataClient(communityHappierMetadata());
    const client: NpmRegistryJsonClient = {
      getJson: vi.fn(async (input) => {
        if (input.url.endsWith('%40acme%2Funavailable')) {
          throw new Error('Npm registry request timed out with token=community-discovery-secret at /Users/alice/private');
        }
        return await healthyClient.getJson(input);
      }),
    };

    const parsed = await parseCommunityNpmDiscovery(
      communityNpmSearchPayload(['@acme/unavailable', '@acme/community']),
      communitySource,
      { client },
    );

    expect(parsed.entries).toMatchObject([{ pluginId: 'acme.community' }]);
    expect(parsed.diagnostics).toEqual([{
      code: 'community_npm_metadata_skipped',
      message: 'Skipped metadata for 1 community npm package.',
    }]);
    expect(parsed.diagnostics[0]?.message).not.toContain('community-discovery-secret');
    expect(parsed.diagnostics[0]?.message).not.toContain('/Users/alice/private');
  });

  it('reports a community metadata timeout as a skipped candidate instead of taking the source unavailable', async () => {
    const client: NpmRegistryJsonClient = {
      getJson: vi.fn(async () => { throw new Error('Npm registry request timed out'); }),
    };

    const result = await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source: communitySource,
      fetchImpl: async () => new Response(JSON.stringify(communityNpmSearchPayload()), { status: 200 }),
      communityNpmClient: client,
    });

    expect(result).toMatchObject({ freshness: { state: 'fresh' }, entries: [] });
    expect(result.diagnostics).toEqual([{
      code: 'community_npm_metadata_skipped',
      message: 'Skipped metadata for 1 community npm package.',
    }]);
  });

  it('reports corrupt cache truth when refresh is unavailable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const cacheDir = join(createPluginStateStore({ happyHomeDir: home }).paths.cacheDir, 'marketplace-index');
    await mkdir(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, `${createHash('sha256').update(source.sourceUrl).digest('hex')}.json`);
    await writeFile(cachePath, '{not-json', 'utf8');
    const result = await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl: async () => { throw new Error('offline'); } });
    expect(result.freshness.state).toBe('corrupt');
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'marketplace_cache_corrupt' })]);
  });

  it('does not reuse cached curation authority after the configured source binding changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(snapshot()), { status: 200 }), now: () => 100 });
    const rebound = { ...source, title: 'Rebound title' };
    const result = await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: rebound, happyHomeDir: home, fetchImpl: async () => { throw new Error('offline'); }, now: () => 200 });
    expect(result.entries).toEqual([]);
    expect(result.freshness.state).toBe('corrupt');
  });

  it('rejects cache timestamps from the future and keeps fallback diagnostics bounded', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const diagnostics = Array.from({ length: 128 }, (_, index) => ({ code: `diagnostic_${index}`, message: `Diagnostic ${index}` }));
    await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source,
      happyHomeDir: home,
      fetchImpl: async () => new Response(JSON.stringify({ ...snapshot(), diagnostics }), { status: 200 }),
      now: () => 200,
    });

    const result = await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source,
      happyHomeDir: home,
      fetchImpl: async () => { throw new Error('offline'); },
      now: () => 100,
    });
    expect(result.freshness.state).toBe('corrupt');
    expect(result.diagnostics.length).toBeLessThanOrEqual(128);
  });

  it.each([
    'https://127.0.0.1/catalog.json',
    'https://[::1]/catalog.json',
  ])('rejects literal private-network source %s before invoking the network boundary', async (sourceUrl) => {
    const privateSource = { ...source, sourceUrl };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ...snapshot(), source: privateSource }), { status: 200 }));
    await expect(loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: privateSource, fetchImpl })).rejects.toThrow(/private|local|public/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('handles redirects manually and refuses a cross-origin location before fetching it', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example/catalog.json' } });
    });
    const result = await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ freshness: { state: 'unavailable' }, entries: [] });
    expect(result.diagnostics[0]?.message).toMatch(/redirect.*origin/i);
  });
});
