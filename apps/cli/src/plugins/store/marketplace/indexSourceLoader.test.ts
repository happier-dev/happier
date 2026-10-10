import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';

import type { MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCommunityNpmSearchUrl, loadMarketplaceIndexSource, parseCommunityNpmDiscovery } from './indexSourceLoader';
import type { NpmRegistryJsonClient } from '@/plugins/distribution/npm/resolver';
import { createNpmRegistryHttpsClient } from '@/plugins/distribution/npm/httpsClient';
import { createPluginStateStore } from '@/plugins/store/state.testkit';

const homes: string[] = [];
// DNS is the one system boundary the acquisition owner touches; every fixture
// host is a public destination unless a case supplies a different answer.
const testResolveAddresses = async (): Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]> => (
  [{ address: '93.184.216.34', family: 4 as const }]
);
const source = { id: 'marketplace:curated', title: 'Curated', kind: 'curated' as const, sourceUrl: 'https://marketplace.example.test/catalog.json' };
const communitySource = { id: 'marketplace:community-npm', title: 'Community npm', kind: 'community-npm' as const, sourceUrl: 'https://registry.npmjs.org/-/v1/search' };
const COMMUNITY_INTEGRITY = 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==';

function communityHappierMetadata(params: Readonly<{
  marketplaceDiscovery?: Record<string, unknown>;
  compatibilityProjection?: Record<string, unknown>;
  engines?: Record<string, unknown> | null;
}> = {}) {
  const compatibilityProjection = params.compatibilityProjection ?? {
    version: 1,
    manifest: {
      schemaVersion: 2,
      id: 'acme.community',
      version: '1.0.0',
      displayName: 'Community',
      ...(params.engines === null ? {} : { engines: params.engines ?? { happier: '>=0.0.0' } }),
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {},
    },
    uiArtifacts: { version: 2, entries: [] },
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

function communityNpmSearchPayload(packageNames: readonly string[] = ['@acme/community'], total = packageNames.length) {
  return {
    total,
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

function communityNpmMetadataClient(
  happier: unknown,
  packageName = '@acme/community',
): NpmRegistryJsonClient {
  const encodedName = encodeURIComponent(packageName).replaceAll('%40', '@').replaceAll('%2F', '/');
  return {
    getJson: vi.fn(async () => ({
      name: packageName,
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          name: packageName,
          version: '1.0.0',
          happier,
          dist: {
            integrity: COMMUNITY_INTEGRITY,
            tarball: `https://registry.npmjs.org/${packageName}/-/${encodedName.split('/').pop()}-1.0.0.tgz`,
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
    vi.unstubAllEnvs();
  });

  it('loads a valid configured catalog beyond the former implicit JSON ceiling', async () => {
    vi.stubEnv('HAPPIER_PLUGIN_REMOTE_CATALOG_MAX_BYTES', '');
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const body = `${' '.repeat(2 * 1024 * 1024)}${JSON.stringify(snapshot())}`;
    await expect(loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses, source, happyHomeDir: home,
      fetchImpl: async () => new Response(body), now: () => 100,
    })).resolves.toMatchObject({ freshness: { state: 'fresh', fetchedAtMs: 100 }, entries: [], diagnostics: [] });
  });

  it('acquires community metadata without converting an absent timeout into an immediate deadline', async () => {
    vi.stubEnv('HAPPIER_PLUGIN_REMOTE_FETCH_TIMEOUT_MS', '');
    vi.stubEnv('HAPPIER_PLUGIN_REMOTE_CATALOG_MAX_BYTES', '');
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const metadata = {
      name: '@acme/community',
      padding: 'x'.repeat(2 * 1024 * 1024),
      versions: { '1.0.0': {
        name: '@acme/community', version: '1.0.0', happier: communityHappierMetadata(),
        dist: { integrity: COMMUNITY_INTEGRITY, tarball: 'https://registry.npmjs.org/community.tgz' },
      } },
    };
    // HTTPS is a system boundary; the real client, resolver and projection remain in the path.
    const request = ((_: RequestOptions, callback: (message: IncomingMessage) => void) => {
      const emitter = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
      emitter.end = () => queueMicrotask(() => {
        const message = Object.assign(Readable.from([JSON.stringify(metadata)]), { statusCode: 200, headers: { 'content-type': 'application/json' } });
        callback(message as unknown as IncomingMessage);
      });
      emitter.destroy = (error?: Error) => { if (error) emitter.emit('error', error); };
      return emitter as unknown as ClientRequest;
    }) as typeof import('node:https').request;
    const client = createNpmRegistryHttpsClient({ registryOrigin: 'https://registry.npmjs.org', request, lookup: testResolveAddresses });
    const loaded = await loadMarketplaceIndexSource({
      source: communitySource, happyHomeDir: home, resolveAddresses: testResolveAddresses,
      fetchImpl: async () => new Response(JSON.stringify(communityNpmSearchPayload())), communityNpmClient: client,
    });
    expect(loaded.entries.map((entry) => entry.pluginId)).toEqual(['acme.community']);
    expect(loaded.diagnostics).toEqual([]);
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

    const afterFormerStaleCutoff = 100 + 8 * 24 * 60 * 60 * 1000;
    const offline = await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl: async () => { throw new Error('offline'); }, now: () => afterFormerStaleCutoff });
    expect(offline).toMatchObject({ freshness: { state: 'stale-offline', fetchedAtMs: 100, staleSinceMs: afterFormerStaleCutoff } });
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
    expect(parsed.entries[0]).toMatchObject({ pluginId: 'acme.community', review: { status: 'unreviewed' }, updatePolicy: 'allowed' });
    expect(client.getJson).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://registry.npmjs.org/%40acme%2Fcommunity',
      headers: { accept: 'application/json' },
    }));
  });

  it('lists community packages whose discovery projection carries unknown additive fields', async () => {
    const client = communityNpmMetadataClient(communityHappierMetadata({
      marketplaceDiscovery: {
        version: 1,
        pluginId: 'acme.community',
        manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        futureListingFact: { addedIn: 2, notes: ['ignored'] },
        display: { title: 'Community', description: null, badgeUrl: 'https://cdn.example/badge.png' },
        summary: {
          contributions: [],
          requiredHostAccess: [],
          optionalHostAccess: [],
          executableRealms: ['daemon'],
          installFootprint: { bytes: 1_024 },
        },
      },
    }));

    const parsed = await parseCommunityNpmDiscovery(communityNpmSearchPayload(), communitySource, { client });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({
      pluginId: 'acme.community',
      display: { title: 'Community', description: null },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
    });
    expect(parsed.diagnostics).toEqual([]);
  });

  it.each([null, {}])('lists packed community packages without an author engine floor (%j)', async (engines) => {
    const parsed = await parseCommunityNpmDiscovery(communityNpmSearchPayload(), communitySource, {
      client: communityNpmMetadataClient(communityHappierMetadata({ engines })),
    });
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.compatibility).toEqual({ platforms: [] });
    expect(parsed.diagnostics).toEqual([]);
  });

  it.each(['', '*', 'not-a-range'])('rejects a malformed declared community engine floor (%s)', async (happier) => {
    const parsed = await parseCommunityNpmDiscovery(communityNpmSearchPayload(), communitySource, {
      client: communityNpmMetadataClient(communityHappierMetadata({ engines: { happier } })),
    });
    expect(parsed.entries).toEqual([]);
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ code: 'community_npm_metadata_skipped' })]);
  });

  it.each(['curated', 'user'] as const)('normalizes additive catalog presentation before caching a %s source', async (kind) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const community = await parseCommunityNpmDiscovery(communityNpmSearchPayload(), communitySource, {
      client: communityNpmMetadataClient(communityHappierMetadata()),
    });
    const entry = community.entries[0]!;
    const catalogSource = { ...source, kind };
    const review = kind === 'curated'
      ? { status: 'approved', reviewedAt: '2026-09-05T00:00:00.000Z' }
      : { status: 'unreviewed', reviewedAt: null };
    const entries = [
      {
        ...entry, review,
        display: { ...entry.display, badge: { label: 'New' } },
        summary: { ...entry.summary, installFootprint: { bytes: 1_024 } },
        links: { ...entry.links, documentation: 'https://example.test/docs' },
      },
      { ...entry, pluginId: 'acme.neighbor', review },
    ];
    const result = await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source: catalogSource,
      happyHomeDir: home,
      fetchImpl: async () => new Response(JSON.stringify({ ...snapshot(), source: catalogSource, entries }), { status: 200 }),
      now: () => 100,
    });
    const expectedEntries = [{ ...entry, review }, { ...entry, pluginId: 'acme.neighbor', review }];
    expect(result.freshness.state).toBe('fresh');
    expect(result.entries).toEqual(expectedEntries);
    const offline = await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source: catalogSource,
      happyHomeDir: home,
      fetchImpl: async () => { throw new Error('offline'); },
      now: () => 200,
    });
    expect(offline.freshness.state).toBe('stale-offline');
    expect(offline.entries).toEqual(expectedEntries);
  });

  it('skips community packages whose discovery projection malformed a known field', async () => {
    const client = communityNpmMetadataClient(communityHappierMetadata({
      marketplaceDiscovery: {
        version: 1,
        pluginId: 'acme.community',
        manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        display: { title: 42, description: null },
        summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      },
    }));

    const parsed = await parseCommunityNpmDiscovery(communityNpmSearchPayload(), communitySource, { client });
    expect(parsed.entries).toEqual([]);
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ code: 'community_npm_metadata_skipped' })]);
  });

  it('skips community packages whose discovery projection omits a compatibility-critical field', async () => {
    const client = communityNpmMetadataClient(communityHappierMetadata({
      marketplaceDiscovery: {
        version: 1,
        pluginId: 'acme.community',
        display: { title: 'Community', description: null },
        summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      },
    }));

    const parsed = await parseCommunityNpmDiscovery(communityNpmSearchPayload(), communitySource, { client });
    expect(parsed.entries).toEqual([]);
    expect(parsed.diagnostics).toEqual([expect.objectContaining({ code: 'community_npm_metadata_skipped' })]);
  });

  it('skips packages publishing an unsupported marketplaceDiscovery version with their own diagnostic', async () => {
    const healthyClient = communityNpmMetadataClient(communityHappierMetadata());
    const futureClient = communityNpmMetadataClient(communityHappierMetadata({
      marketplaceDiscovery: {
        version: 2,
        pluginId: 'acme.community',
        manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        display: { title: 'Community', description: null },
        summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      },
    }), '@acme/future');
    const client: NpmRegistryJsonClient = {
      getJson: vi.fn(async (input) => {
        if (input.url.endsWith('%40acme%2Ffuture')) return await futureClient.getJson(input);
        return await healthyClient.getJson(input);
      }),
    };

    const parsed = await parseCommunityNpmDiscovery(
      communityNpmSearchPayload(['@acme/future', '@acme/community']),
      communitySource,
      { client },
    );

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ pluginId: 'acme.community' });
    expect(parsed.diagnostics).toEqual([{
      code: 'community_npm_discovery_version_unsupported',
      message: 'Skipped 1 community npm package publishing an unsupported marketplaceDiscovery version.',
    }]);
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

  it('composes the ecosystem keyword with the caller search text and requests one bounded discovery snapshot', () => {
    const url = new URL(buildCommunityNpmSearchUrl(communitySource.sourceUrl, { text: 'terminal themes', from: 40, size: 20 }));
    expect(url.searchParams.get('text'))
      .toBe('keywords:happier-plugin terminal themes');
    expect(url.searchParams.get('from')).toBe('40');
    expect(url.searchParams.get('size')).toBe('20');
    expect(new URL(buildCommunityNpmSearchUrl(communitySource.sourceUrl, { text: '' })).searchParams.get('text'))
      .toBe('keywords:happier-plugin');
    expect(new URL(buildCommunityNpmSearchUrl(communitySource.sourceUrl, { text: '' })).searchParams.get('size')).toBe('100');
  });

  it('preserves full community npm search text beyond the former projection cutoff', () => {
    const text = 'terminal theme '.repeat(100).trim();
    const url = new URL(buildCommunityNpmSearchUrl(communitySource.sourceUrl, { text }));
    expect(url.searchParams.get('text')).toBe(`keywords:happier-plugin ${text}`);
  });

  it('starts the complete admitted metadata page without a competing four-request budget', async () => {
    const names = Array.from({ length: 5 }, (_, index) => `@acme/community-${index}`);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let startedFour!: () => void;
    const fourStarted = new Promise<void>((resolve) => { startedFour = resolve; });
    const started: string[] = [];
    const client: NpmRegistryJsonClient = { getJson: async (request) => {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
      started.push(name);
      if (started.length === 4) startedFour();
      await held;
      return communityNpmMetadataClient(communityHappierMetadata(), name).getJson(request);
    } };
    const pending = parseCommunityNpmDiscovery(communityNpmSearchPayload(names), communitySource, { client });
    try {
      await fourStarted;
      expect(started).toEqual(names);
    } finally { release(); await pending; }
    expect((await pending).entries).toHaveLength(5);
  });

  it('projects npm total and returned search-hit count for honest service paging', async () => {
    const parsed = await parseCommunityNpmDiscovery(
      communityNpmSearchPayload(['@acme/community'], 240),
      communitySource,
      { client: communityNpmMetadataClient(communityHappierMetadata()), from: 40, size: 20 },
    );
    expect(parsed.communityNpmPage).toEqual({ from: 40, size: 20, returned: 1, total: 240 });
  });

  it('targets one package instead of a discovery page when the query names an exact package', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify(communityNpmSearchPayload(['@acme/neighbour', '@acme/community'])),
      { status: 200 },
    ));
    const client = communityNpmMetadataClient(communityHappierMetadata());

    const result = await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source: communitySource,
      query: { text: '', exactPackageName: '@acme/community' },
      fetchImpl,
      communityNpmClient: client,
    });

    const requestedUrl = new URL(String((fetchImpl.mock.calls as readonly (readonly unknown[])[])[0]?.[0]));
    expect(requestedUrl.searchParams.get('text')).toBe('keywords:happier-plugin @acme/community');
    expect(requestedUrl.searchParams.get('size')).toBe('100');
    expect(result.entries).toMatchObject([{ pluginId: 'acme.community' }]);
    // Neighbouring search hits are never acquired: targeting happens before
    // any package metadata request, not after a full-page scan.
    expect(client.getJson).toHaveBeenCalledTimes(1);
    expect(client.getJson).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://registry.npmjs.org/%40acme%2Fcommunity',
    }));
  });

  it('keeps the last known good bounded community snapshot when its refresh fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const client = communityNpmMetadataClient(communityHappierMetadata());
    await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source: communitySource,
      query: { text: 'themes' },
      happyHomeDir: home,
      fetchImpl: async () => new Response(JSON.stringify(communityNpmSearchPayload()), { status: 200 }),
      communityNpmClient: client,
      now: () => 100,
    });

    const continued = await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source: communitySource,
      query: { text: 'themes' },
      happyHomeDir: home,
      fetchImpl: async () => { throw new Error('offline'); },
      communityNpmClient: client,
      now: () => 200,
    });

    expect(continued).toMatchObject({ freshness: { state: 'stale-offline', fetchedAtMs: 100 } });
    expect(continued.entries).toMatchObject([{ pluginId: 'acme.community' }]);
  });

  it('keeps one replaceable discovery slot per community npm source across different searches', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const client = communityNpmMetadataClient(communityHappierMetadata());
    const onlineFetch = async () => new Response(JSON.stringify(communityNpmSearchPayload()), { status: 200 });

    await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: communitySource, query: { text: 'first search' }, happyHomeDir: home, fetchImpl: onlineFetch, communityNpmClient: client, now: () => 100 });
    const cacheDir = join(createPluginStateStore({ happyHomeDir: home }).paths.cacheDir, 'marketplace-index');
    expect(await readdir(cacheDir)).toHaveLength(1);

    await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: communitySource, query: { text: 'a completely different search' }, happyHomeDir: home, fetchImpl: onlineFetch, communityNpmClient: client, now: () => 200 });
    const slots = await readdir(cacheDir);
    // The second search replaces the same slot instead of growing one file per unique query.
    expect(slots).toHaveLength(1);
    const [slotName] = slots;
    const record = JSON.parse(await readFile(join(cacheDir, slotName ?? ''), 'utf8')) as { t?: unknown; sourceUrl?: unknown; requestUrl?: unknown };
    expect(record.t).toBe('happier_marketplace_index_source_cache_v1');
    expect(record.sourceUrl).toBe(communitySource.sourceUrl);
    // The slot carries the exact request identity of the query that last filled it.
    expect(record.requestUrl).toBe(buildCommunityNpmSearchUrl(communitySource.sourceUrl, { text: 'a completely different search' }));
  });

  it('never serves one search snapshot for a different discovery query', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const client = communityNpmMetadataClient(communityHappierMetadata());
    await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: communitySource, query: { text: 'first search' }, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(communityNpmSearchPayload()), { status: 200 }), communityNpmClient: client, now: () => 100 });

    const otherQuery = await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: communitySource, query: { text: 'a completely different search' }, happyHomeDir: home, fetchImpl: async () => { throw new Error('offline'); }, communityNpmClient: client, now: () => 200 });
    // Queries share one slot per source, so the identity gate is what keeps
    // the first search's bytes from answering the second search offline.
    expect(otherQuery.freshness.state).toBe('unavailable');
    expect(otherQuery.entries).toEqual([]);
  });

  it('keeps the exact package lookup in its own slot so discovery and exact revalidation stay independent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const client = communityNpmMetadataClient(communityHappierMetadata());
    await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: communitySource, query: { text: '', exactPackageName: '@acme/community' }, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(communityNpmSearchPayload()), { status: 200, headers: { etag: '"exact-1"' } }), communityNpmClient: client, now: () => 100 });
    await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: communitySource, query: { text: 'themes' }, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(communityNpmSearchPayload()), { status: 200, headers: { etag: '"discovery-1"' } }), communityNpmClient: client, now: () => 150 });
    const cacheDir = join(createPluginStateStore({ happyHomeDir: home }).paths.cacheDir, 'marketplace-index');
    // Two bounded slots for the source: discovery and exact lookup.
    expect(await readdir(cacheDir)).toHaveLength(2);

    const exactRevalidation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"exact-1"');
      return new Response(null, { status: 304 });
    });
    await expect(loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: communitySource, query: { text: '', exactPackageName: '@acme/community' }, happyHomeDir: home, fetchImpl: exactRevalidation, communityNpmClient: client, now: () => 200 })).resolves.toMatchObject({ freshness: { state: 'fresh', fetchedAtMs: 200 } });

    const discoveryRevalidation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"discovery-1"');
      return new Response(null, { status: 304 });
    });
    await expect(loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: communitySource, query: { text: 'themes' }, happyHomeDir: home, fetchImpl: discoveryRevalidation, communityNpmClient: client, now: () => 250 })).resolves.toMatchObject({ freshness: { state: 'fresh', fetchedAtMs: 250 } });
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

  it('matches a remote catalog on immutable identity and overlays the configured source title', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const remoteCatalog = { ...snapshot(), source: { ...source, title: 'Remotely published title' } };
    const result = await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source: { ...source, title: 'Locally renamed' },
      happyHomeDir: home,
      fetchImpl: async () => new Response(JSON.stringify(remoteCatalog), { status: 200 }),
      now: () => 100,
    });
    expect(result.freshness.state).toBe('fresh');
    expect(result.source).toEqual({ ...source, title: 'Locally renamed' });
  });

  it('keeps cached catalog authority when only the editable local source title changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(snapshot()), { status: 200, headers: { etag: '"v1"' } }), now: () => 100 });
    const rebound = { ...source, title: 'Renamed locally' };

    const offline = await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: rebound, happyHomeDir: home, fetchImpl: async () => { throw new Error('offline'); }, now: () => 200 });
    expect(offline.freshness).toMatchObject({ state: 'stale-offline', fetchedAtMs: 100, staleSinceMs: 200 });
    expect(offline.source.title).toBe('Renamed locally');

    const revalidated = await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses,
      source: rebound,
      happyHomeDir: home,
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('if-none-match')).toBe('"v1"');
        return new Response(null, { status: 304 });
      },
      now: () => 300,
    });
    expect(revalidated.freshness).toMatchObject({ state: 'fresh', fetchedAtMs: 300 });
    expect(revalidated.source.title).toBe('Renamed locally');
  });

  it('does not reuse cached curation authority after the configured source identity changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(snapshot()), { status: 200 }), now: () => 100 });
    const rebound = { ...source, id: 'marketplace:other' };
    const result = await loadMarketplaceIndexSource({ resolveAddresses: testResolveAddresses, source: rebound, happyHomeDir: home, fetchImpl: async () => { throw new Error('offline'); }, now: () => 200 });
    expect(result.entries).toEqual([]);
    expect(result.freshness.state).toBe('corrupt');
  });

  it('retains every cached diagnostic and the current refresh failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const diagnostics = Array.from({ length: 128 }, (_, index) => ({ code: `diagnostic_${index}`, message: `Diagnostic ${index}` }));
    await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses, source, happyHomeDir: home,
      fetchImpl: async () => new Response(JSON.stringify({ ...snapshot(), diagnostics }), { status: 200 }),
      now: () => 100,
    });
    const result = await loadMarketplaceIndexSource({
      resolveAddresses: testResolveAddresses, source, happyHomeDir: home,
      fetchImpl: async () => { throw new Error('offline'); }, now: () => 200,
    });
    expect(result.diagnostics.slice(0, 128)).toEqual(diagnostics);
    expect(result.diagnostics).toHaveLength(129);
    expect(result.diagnostics.at(-1)).toMatchObject({ code: 'marketplace_source_refresh_failed' });
  });

  it('rejects cache timestamps from the future', async () => {
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
