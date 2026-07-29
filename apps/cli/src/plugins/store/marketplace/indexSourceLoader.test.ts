import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadMarketplaceIndexSource, parseCommunityNpmDiscovery } from './indexSourceLoader';
import { createPluginStateStore } from '@/plugins/store/state.testkit';

const homes: string[] = [];
const source = { id: 'marketplace:curated', title: 'Curated', kind: 'curated' as const, sourceUrl: 'https://marketplace.example.test/catalog.json' };

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

    const first = loadMarketplaceIndexSource({ source, happyHomeDir: home, fetchImpl, now: () => 100 });
    const joined = loadMarketplaceIndexSource({ source, happyHomeDir: home, fetchImpl, now: () => 100 });
    release();
    await expect(Promise.all([first, joined])).resolves.toEqual([expect.objectContaining({ freshness: { state: 'fresh', fetchedAtMs: 100 } }), expect.objectContaining({ freshness: { state: 'fresh', fetchedAtMs: 100 } })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const conditionalFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"v1"');
      return new Response(null, { status: 304 });
    });
    await expect(loadMarketplaceIndexSource({ source, happyHomeDir: home, fetchImpl: conditionalFetch, now: () => 200 })).resolves.toMatchObject({ freshness: { state: 'fresh', fetchedAtMs: 200 } });
  });

  it('keeps bounded cached truth visible offline without converting it to trust authority', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    await loadMarketplaceIndexSource({ source, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(snapshot()), { status: 200 }), now: () => 100 });

    const offline = await loadMarketplaceIndexSource({ source, happyHomeDir: home, fetchImpl: async () => { throw new Error('offline'); }, now: () => 200 });
    expect(offline).toMatchObject({ freshness: { state: 'stale-offline', fetchedAtMs: 100, staleSinceMs: 200 } });
    expect(offline.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'marketplace_source_refresh_failed' })]));
  });

  it('labels a rejected online refresh as stale rather than offline', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    await loadMarketplaceIndexSource({ source, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(snapshot()), { status: 200 }), now: () => 100 });

    const rejected = await loadMarketplaceIndexSource({ source, happyHomeDir: home, fetchImpl: async () => new Response('rejected', { status: 500 }), now: () => 200 });
    expect(rejected.freshness).toMatchObject({ state: 'stale', fetchedAtMs: 100, staleSinceMs: 200 });
  });

  it('rejects credential-bearing, non-HTTPS source URLs before network access', async () => {
    const fetchImpl = vi.fn();
    await expect(loadMarketplaceIndexSource({ source: { ...source, sourceUrl: 'http://token@example.test/catalog.json' }, fetchImpl })).rejects.toThrow('credential-free HTTPS');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps only bounded happier-plugin npm metadata and labels it unreviewed', () => {
    const communitySource = { id: 'marketplace:community-npm', title: 'Community npm', kind: 'community-npm' as const, sourceUrl: 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin&size=100' };
    const happierPlugin = {
      pluginId: 'acme.community', publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Community', description: null },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: '@acme/community', version: '1.0.0', integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', compatibility: { happier: '>=1', platforms: ['linux'] },
      summary: { contributions: ['agents'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] }, categories: ['agents'], media: [], links: {},
    };
    const parsed = parseCommunityNpmDiscovery({ objects: [
      { package: { name: '@acme/community', version: '1.0.0', happierPlugin } },
      { package: { name: '@attacker/other', version: '1.0.0', happierPlugin } },
      { package: { name: 'not-a-plugin' } },
    ] }, communitySource);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ pluginId: 'acme.community', review: { status: 'unreviewed' }, updatePolicy: 'manual' });
  });

  it('reports corrupt cache truth when refresh is unavailable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const cacheDir = join(createPluginStateStore({ happyHomeDir: home }).paths.cacheDir, 'marketplace-index');
    await mkdir(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, `${createHash('sha256').update(source.sourceUrl).digest('hex')}.json`);
    await writeFile(cachePath, '{not-json', 'utf8');
    const result = await loadMarketplaceIndexSource({ source, happyHomeDir: home, fetchImpl: async () => { throw new Error('offline'); } });
    expect(result.freshness.state).toBe('corrupt');
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'marketplace_cache_corrupt' })]);
  });

  it('does not reuse cached curation authority after the configured source binding changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    await loadMarketplaceIndexSource({ source, happyHomeDir: home, fetchImpl: async () => new Response(JSON.stringify(snapshot()), { status: 200 }), now: () => 100 });
    const rebound = { ...source, title: 'Rebound title' };
    const result = await loadMarketplaceIndexSource({ source: rebound, happyHomeDir: home, fetchImpl: async () => { throw new Error('offline'); }, now: () => 200 });
    expect(result.entries).toEqual([]);
    expect(result.freshness.state).toBe('corrupt');
  });

  it('rejects cache timestamps from the future and keeps fallback diagnostics bounded', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-index-'));
    homes.push(home);
    const diagnostics = Array.from({ length: 128 }, (_, index) => ({ code: `diagnostic_${index}`, message: `Diagnostic ${index}` }));
    await loadMarketplaceIndexSource({
      source,
      happyHomeDir: home,
      fetchImpl: async () => new Response(JSON.stringify({ ...snapshot(), diagnostics }), { status: 200 }),
      now: () => 200,
    });

    const result = await loadMarketplaceIndexSource({
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
    await expect(loadMarketplaceIndexSource({ source: privateSource, fetchImpl })).rejects.toThrow(/private|local|public/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('handles redirects manually and refuses a cross-origin location before fetching it', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example/catalog.json' } });
    });
    const result = await loadMarketplaceIndexSource({ source, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ freshness: { state: 'unavailable' }, entries: [] });
    expect(result.diagnostics[0]?.message).toMatch(/redirect.*origin/i);
  });
});
