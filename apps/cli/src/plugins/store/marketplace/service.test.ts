import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as undici from 'undici';

import type { MarketplaceIndexQueryResultV1, MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveExactMarketplaceListingForInstall } from './exactInstall';
import {
  COMMUNITY_NPM_MARKETPLACE_SOURCE,
  createMarketplaceIndexService,
  projectMarketplaceArtifactAccess,
} from './service';
import { createMarketplaceSourceRegistryStore } from './sources/store';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';

// Network boundaries only; acquisition policy, loading and persistence stay real.
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:dns/promises')>(),
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});

const homes: string[] = [];

function snapshot(sourceUrl: string, pluginId: string): MarketplaceIndexSourceSnapshotV1 {
  return {
    source: { id: `marketplace:${pluginId}`, title: pluginId, kind: 'curated', sourceUrl },
    freshness: { state: 'fresh', fetchedAtMs: 1 },
    entries: [{
      pluginId,
      publisher: { id: 'acme', displayName: 'Acme' },
      display: { title: pluginId, description: null },
      distribution: {
        kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: `@acme/${pluginId.split('.')[1]}`, version: '1.0.0',
        integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==',
      },
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      compatibility: { happier: '>=1', platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' },
      categories: [], media: [], updatePolicy: 'allowed', links: {},
    }],
    diagnostics: [],
  };
}

function communityEntries(count: number): MarketplaceIndexSourceSnapshotV1['entries'] {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(2, '0');
    const entry = snapshot(COMMUNITY_NPM_MARKETPLACE_SOURCE.sourceUrl, `acme.community-${suffix}`).entries[0]!;
    return {
      ...entry,
      distribution: { ...entry.distribution, packageName: `@acme/community-${suffix}` },
      review: { status: 'unreviewed' as const, reviewedAt: null },
      updatePolicy: 'allowed' as const,
    };
  });
}

describe('createMarketplaceIndexService', () => {
  it('starts every selected source through real acquisition without a four-source cutoff', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-source-admission-'));
    homes.push(home);
    const sources = Array.from({ length: 5 }, (_, index) => ({
      id: `source-${index}`, title: `Source ${index}`, sourceUrl: `https://catalog.example/${index}.json`, enabled: true, origin: 'user' as const,
    }));
    // DNS and HTTP are system boundaries; the source loader, acquisition policy,
    // cache parser and index service beneath them remain real.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let startedFour!: () => void;
    const fourStarted = new Promise<void>((resolve) => { startedFour = resolve; });
    const started: string[] = [];
    vi.mocked(undici.fetch).mockImplementation(async (input) => {
      const sourceUrl = String(input);
      started.push(sourceUrl);
      if (started.length === 4) startedFour();
      await held;
      const source = sources.find((candidate) => candidate.sourceUrl === sourceUrl)!;
      return new undici.Response(JSON.stringify({
        source: { id: source.id, title: source.title, kind: source.origin, sourceUrl },
        freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [],
      }), { status: 200 });
    });
    const pending = createMarketplaceIndexService({ happyHomeDir: home }).querySources({}, sources);
    try {
      await fourStarted;
      await vi.waitFor(() => expect(started).toEqual(sources.map((source) => source.sourceUrl)));
    } finally { release(); await pending; }
    expect((await pending).sources).toHaveLength(5);
  });
  it('queries and pages every configured source beyond 65 active sources', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-many-sources-'));
    homes.push(home);
    const sources = Array.from({ length: 70 }, (_, index) => ({
      id: `marketplace:source-${index}`, title: `Source ${index}`, sourceUrl: `https://catalog.example/${index}.json`,
      enabled: true, origin: 'user' as const,
    }));
    vi.mocked(undici.fetch).mockImplementation(async (input) => {
      const sourceUrl = String(input);
      const source = sources.find((candidate) => candidate.sourceUrl === sourceUrl)!;
      const document = snapshot(sourceUrl, `acme.plugin-${source.id.split('-').at(-1)}`);
      document.source = { id: source.id, title: source.title, sourceUrl, kind: source.origin };
      document.entries[0]!.review = { status: 'unreviewed', reviewedAt: null };
      return new undici.Response(JSON.stringify(document), { status: 200 });
    });
    const service = createMarketplaceIndexService({ happyHomeDir: home });
    const first = await service.querySources({ filters: {}, limit: 50 }, sources);
    const last = await service.querySources({ filters: {}, limit: 50, cursor: first.nextCursor }, sources);
    expect(first.sources).toHaveLength(70);
    expect([...first.items, ...last.items]).toHaveLength(70);
    expect(last.nextCursor).toBeNull();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(undici.fetch).mockReset();
    vi.unstubAllGlobals();
    await Promise.all(homes.splice(0).map(async (home) => await rm(home, { recursive: true, force: true })));
  });

  it('derives revision from projected authority so different content cannot reuse revision 1 after restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    vi.mocked(undici.fetch).mockImplementation(async (input) => {
      const sourceUrl = String(input);
      const pluginId = sourceUrl.includes('one') ? 'acme.one' : 'acme.two';
      return new undici.Response(JSON.stringify(snapshot(sourceUrl, pluginId)), { status: 200 });
    });

    const first = await createMarketplaceIndexService({ happyHomeDir: home }).querySources(
      { filters: {} },
      [{ id: 'marketplace:acme.one', title: 'One', sourceUrl: 'https://catalog.example/one.json', enabled: true, origin: 'curated' }],
    );
    const restarted = await createMarketplaceIndexService({ happyHomeDir: home }).querySources(
      { filters: {} },
      [{ id: 'marketplace:acme.two', title: 'Two', sourceUrl: 'https://catalog.example/two.json', enabled: true, origin: 'curated' }],
    );

    expect(restarted.revision).not.toBe(first.revision);
  });

  it('changes revision when the persisted source-to-profile binding changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    vi.mocked(undici.fetch).mockImplementation(async (input) => {
      const sourceUrl = String(input);
      return new undici.Response(JSON.stringify(snapshot(sourceUrl, 'acme.private')), { status: 200 });
    });
    const service = createMarketplaceIndexService({ happyHomeDir: home });
    const source = {
      id: 'marketplace:private', title: 'Private', sourceUrl: 'https://catalog.example/private.json',
      enabled: true, origin: 'curated' as const,
    };
    const first = await service.querySources({ filters: {} }, [{ ...source, registryProfileId: 'registry_one' }]);
    const rebound = await service.querySources({ filters: {} }, [{ ...source, registryProfileId: 'registry_two' }]);
    expect(rebound.revision).not.toBe(first.revision);
  });

  it('selects source ids and kinds before acquisition and keeps the selected duplicate distribution visible', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    const store = createMarketplaceSourceRegistryStore({ happyHomeDir: home });
    const curated = (await store.read()).sources[0]!;
    const user = await store.upsertSource({
      sourceUrl: 'https://catalog.example/user.json',
      title: 'Selected user source',
      origin: 'user',
    });
    const loadedSourceIds: string[] = [];
    const service = createMarketplaceIndexService({
      happyHomeDir: home,
      loadSource: async ({ source }) => {
        loadedSourceIds.push(source.id);
        const document = snapshot(source.sourceUrl, 'acme.shared');
        document.source = {
          id: source.id,
          title: source.title,
          kind: source.kind,
          sourceUrl: source.sourceUrl,
        };
        if (source.kind !== 'curated') {
          document.entries[0]!.review = { status: 'unreviewed', reviewedAt: null };
          document.entries[0]!.updatePolicy = 'allowed';
        }
        return document;
      },
    });

    const selected = await service.query({
      text: '',
      cursor: null,
      limit: 50,
      filters: { sourceIds: [user.id], includeUnavailable: true },
    });

    expect(loadedSourceIds).toEqual([user.id]);
    expect(loadedSourceIds).not.toContain(curated.id);
    expect(loadedSourceIds).not.toContain(COMMUNITY_NPM_MARKETPLACE_SOURCE.id);
    expect(selected.items).toMatchObject([{
      pluginId: 'acme.shared',
      source: { id: user.id, kind: 'user' },
    }]);
    expect(selected.sources).toMatchObject([{
      source: { id: user.id, kind: 'user' },
    }]);
    expect(selected.diagnostics).toEqual([]);

    loadedSourceIds.length = 0;
    const selectedKind = await service.querySources(
      { text: '', cursor: null, limit: 50, filters: { sourceKinds: ['user'], includeUnavailable: true } },
      [curated, user, COMMUNITY_NPM_MARKETPLACE_SOURCE],
    );
    expect(loadedSourceIds).toEqual([user.id]);
    expect(selectedKind.items).toMatchObject([{
      pluginId: 'acme.shared',
      source: { id: user.id, kind: 'user' },
    }]);
    expect(selectedKind.sources).toMatchObject([{
      source: { id: user.id, kind: 'user' },
    }]);
    expect(selectedKind.diagnostics).toEqual([]);
  });

  it('keeps one Community npm query revision across pages and changes it for a different query', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    const queries: unknown[] = [];
    const entries = communityEntries(60);
    const service = createMarketplaceIndexService({
      happyHomeDir: home,
      loadSource: async ({ source, query }) => {
        queries.push(query);
        const from = query?.from ?? 0;
        const size = query?.size ?? 100;
        return {
          source,
          freshness: { state: 'fresh', fetchedAtMs: 1 },
          entries: entries.slice(from, from + size),
          diagnostics: [],
          communityNpmPage: { from, size, returned: Math.min(size, entries.length - from), total: entries.length },
        };
      },
    });

    const first = await service.querySources(
      { text: '', cursor: null, limit: 50, filters: {} },
      [COMMUNITY_NPM_MARKETPLACE_SOURCE],
    );
    const second = await service.querySources(
      { text: '', cursor: first.nextCursor, limit: 50, filters: {} },
      [COMMUNITY_NPM_MARKETPLACE_SOURCE],
    );
    const differentQuery = await service.querySources(
      { text: 'different', cursor: null, limit: 50, filters: {} },
      [COMMUNITY_NPM_MARKETPLACE_SOURCE],
    );

    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    expect(second.items).toHaveLength(10);
    expect(second.nextCursor).toBeNull();
    expect(second.revision).toBe(first.revision);
    expect(differentQuery.revision).not.toBe(first.revision);
    expect(new Set([...first.items, ...second.items].map((item) => item.pluginId)).size).toBe(60);
    expect(queries).toEqual([
      { text: '', from: 0, size: 50 },
      { text: '', from: 50, size: 50 },
      { text: 'different', from: 0, size: 50 },
    ]);
  });

  it('returns a changed-revision continuation after the selected source profile binding changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    const store = createMarketplaceSourceRegistryStore({ happyHomeDir: home });
    const privateSource = await store.upsertSource({
      sourceUrl: 'https://catalog.example/private.json',
      title: 'Private',
      origin: 'user',
      registryProfileId: 'registry_one',
    });
    const entries = communityEntries(60);
    const service = createMarketplaceIndexService({
      happyHomeDir: home,
      loadSource: async ({ source, query }) => {
        if (source.kind !== 'community-npm') {
          return {
            source,
            freshness: { state: 'fresh', fetchedAtMs: 1 },
            entries: [],
            diagnostics: [],
          };
        }
        const from = query?.from ?? 0;
        const size = query?.size ?? 100;
        const pageEntries = entries.slice(from, from + size);
        return {
          source,
          freshness: { state: 'fresh', fetchedAtMs: 1 },
          entries: pageEntries,
          diagnostics: [],
          communityNpmPage: { from, size, returned: pageEntries.length, total: entries.length },
        };
      },
    });

    const first = await service.query({ text: '', cursor: null, limit: 50, filters: {} });
    expect(first.nextCursor).not.toBeNull();
    await store.setSourceRegistryProfile(privateSource.id, 'registry_two');

    const rebound = await service.query({ text: '', cursor: first.nextCursor, limit: 50, filters: {} });

    // This is the daemon response shape consumed by Discover's existing
    // revision guard: it can discard the page and clear its cursor instead of
    // turning an authority change into an invalid-request failure.
    expect(rebound.revision).not.toBe(first.revision);
  });

  it('keeps a Community continuation revision stable when an unbound registry profile changes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    const entries = communityEntries(60);
    const service = createMarketplaceIndexService({
      happyHomeDir: home,
      loadSource: async ({ source, query }) => {
        const from = query?.from ?? 0;
        const size = query?.size ?? 100;
        const pageEntries = entries.slice(from, from + size);
        return {
          source,
          freshness: { state: 'fresh', fetchedAtMs: 1 },
          entries: pageEntries,
          diagnostics: [],
          communityNpmPage: { from, size, returned: pageEntries.length, total: entries.length },
        };
      },
    });

    const first = await service.querySources(
      { text: '', cursor: null, limit: 50, filters: {} },
      [COMMUNITY_NPM_MARKETPLACE_SOURCE],
    );
    expect(first.nextCursor).not.toBeNull();

    const profileMutation = await createNpmRegistryProfileService({ happyHomeDir: home }).mutate({
      action: 'add',
      machineId: 'machine-1',
      expectedRevision: 0,
      mutationId: 'mutation-unrelated-profile',
      profileId: 'unrelated',
      profile: {
        displayName: 'Unrelated registry',
        origin: 'https://registry.unrelated.example',
        scopes: ['@unrelated'],
        useAsDefault: false,
        allowPrivateNetwork: false,
      },
    });
    expect(profileMutation.status).toBe('success');

    const second = await service.querySources(
      { text: '', cursor: first.nextCursor, limit: 50, filters: {} },
      [COMMUNITY_NPM_MARKETPLACE_SOURCE],
    );

    expect(second.revision).toBe(first.revision);
  });

  it('targets one source and one plugin instead of walking every discovery page', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    const store = createMarketplaceSourceRegistryStore({ happyHomeDir: home });
    const source = await store.upsertSource({ sourceUrl: 'https://catalog.example/user.json', origin: 'user' });
    const queries: unknown[] = [];
    const service = createMarketplaceIndexService({
      happyHomeDir: home,
      loadSource: async (params) => {
        queries.push(params.query);
        return {
          source: { id: source.id, title: source.title, kind: 'user', sourceUrl: source.sourceUrl },
          freshness: { state: 'fresh', fetchedAtMs: 1 },
          entries: [
            ...snapshot(source.sourceUrl, 'acme.other').entries.map((entry) => ({ ...entry, pluginId: 'acme.other', review: { status: 'unreviewed' as const, reviewedAt: null }, updatePolicy: 'allowed' as const })),
            ...snapshot(source.sourceUrl, 'acme.wanted').entries.map((entry) => ({ ...entry, pluginId: 'acme.wanted', review: { status: 'unreviewed' as const, reviewedAt: null }, updatePolicy: 'allowed' as const })),
          ],
          diagnostics: [],
        };
      },
    });

    const exact = await service.queryExactListing({ sourceId: source.id, pluginId: 'acme.wanted', packageName: '@acme/wanted' });

    expect(exact).toMatchObject({ ok: true, source: { id: source.id, origin: 'user' } });
    // One source load, one item — never a cursor walk over the whole source.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ exactPackageName: '@acme/wanted' });
    expect(exact.ok && exact.result.items.map((item) => item.pluginId)).toEqual(['acme.wanted']);
  });

  it('keeps the persisted private-registry binding on an exact user-source listing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    const store = createMarketplaceSourceRegistryStore({ happyHomeDir: home });
    const source = await store.upsertSource({ sourceUrl: 'https://catalog.example/private.json', origin: 'user', registryProfileId: 'registry_private' });
    const service = createMarketplaceIndexService({
      happyHomeDir: home,
      loadSource: async () => ({
        source: { id: source.id, title: source.title, kind: 'user', sourceUrl: source.sourceUrl },
        freshness: { state: 'fresh', fetchedAtMs: 1 },
        entries: snapshot(source.sourceUrl, 'acme.private').entries.map((entry) => ({
          ...entry, pluginId: 'acme.private', review: { status: 'unreviewed' as const, reviewedAt: null }, updatePolicy: 'allowed' as const,
        })),
        diagnostics: [],
      }),
    });

    const exact = await service.queryExactListing({ sourceId: source.id, pluginId: 'acme.private' });
    expect(exact).toMatchObject({ ok: true, source: { registryProfileId: 'registry_private' } });
  });

  it('reports a source that no longer exists as install-unavailable rather than resolving another source', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    await expect(createMarketplaceIndexService({ happyHomeDir: home })
      .queryExactListing({ sourceId: 'marketplace:missing', pluginId: 'acme.wanted' }))
      .resolves.toMatchObject({ ok: false, code: 'install_unavailable' });
  });

  it('projects loader failures before returning the outward marketplace query schema', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    const service = createMarketplaceIndexService({
      happyHomeDir: home,
      loadSource: async () => {
        throw new Error(
          `client_secret=marketplace-service-secret at C:\\Users\\alice\\private\\catalog.json ${'🙂'.repeat(1_200)}`,
        );
      },
    });
    const result = await service.querySources({ filters: {} }, [{
      id: 'marketplace:review',
      title: 'Review',
      sourceUrl: 'https://catalog.example/review.json',
      enabled: true,
      origin: 'user',
    }]);
    const message = result.diagnostics[0]?.message ?? '';

    expect(message).toContain('[REDACTED]');
    expect(message).toContain('[REDACTED_PATH]');
    expect(message).not.toContain('marketplace-service-secret');
    expect(message).not.toContain('C:\\Users\\alice\\private');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(2_048);
  });

  it('keeps concurrent source diagnostics and the revision deterministic across opposite failure settlement orders', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    const pending = new Map<string, (reason: Error) => void>();
    const service = createMarketplaceIndexService({
      happyHomeDir: home,
      loadSource: async ({ source }) => await new Promise<never>((_resolve, reject) => {
        pending.set(source.id, reject);
      }),
    });
    const sources = [
      { id: 'marketplace:first', title: 'First', sourceUrl: 'https://catalog.example/first.json', enabled: true, origin: 'user' as const },
      { id: 'marketplace:second', title: 'Second', sourceUrl: 'https://catalog.example/second.json', enabled: true, origin: 'user' as const },
    ];

    const queryWithSettlementOrder = async (order: readonly string[]) => {
      const query = service.querySources({ filters: {} }, sources);
      await vi.waitFor(() => expect(pending.size).toBe(2));
      for (const sourceId of order) {
        pending.get(sourceId)?.(new Error(`${sourceId} unavailable`));
      }
      const result = await query;
      pending.clear();
      return result;
    };

    const reverse = await queryWithSettlementOrder(['marketplace:second', 'marketplace:first']);
    const forward = await queryWithSettlementOrder(['marketplace:first', 'marketplace:second']);

    expect(reverse.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'marketplace:first unavailable',
      'marketplace:second unavailable',
    ]);
    expect(forward.diagnostics).toEqual(reverse.diagnostics);
    expect(forward.revision).toBe(reverse.revision);
  });

  it('does not let a remote catalog select a host-owned private registry profile', () => {
    const entry = snapshot('https://catalog.example/private.json', 'acme.private').entries[0]!;
    const item: MarketplaceIndexQueryResultV1['items'][number] = {
      ...entry,
      distribution: { ...entry.distribution, registryProfileId: 'profile-private' },
      source: { id: 'marketplace:user', title: 'User', kind: 'user', sourceUrl: 'https://catalog.example/private.json' },
      freshness: { state: 'fresh', fetchedAtMs: 1 },
      admission: { install: 'full-review', mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
      artifactAccess: { state: 'unverified-profile', registryProfileId: 'profile-private' },
    };

    expect(projectMarketplaceArtifactAccess(item, [{
      profileId: 'profile-private', origin: 'https://registry.npmjs.org', availability: 'available',
    }]).artifactAccess).toEqual({ state: 'unverified-profile', registryProfileId: 'profile-private' });
  });

  it('treats an unbound non-public registry origin as unavailable even when the catalog omits a profile id', () => {
    const entry = snapshot('https://catalog.example/private.json', 'acme.private').entries[0]!;
    const item: MarketplaceIndexQueryResultV1['items'][number] = {
      ...entry,
      distribution: { ...entry.distribution, registryOrigin: 'https://registry.acme.test' },
      source: { id: 'marketplace:user', title: 'User', kind: 'user', sourceUrl: 'https://catalog.example/private.json' },
      freshness: { state: 'fresh', fetchedAtMs: 1 },
      admission: { install: 'full-review', mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
      artifactAccess: { state: 'public', registryProfileId: null },
    };
    expect(projectMarketplaceArtifactAccess(item, []).artifactAccess)
      .toEqual({ state: 'unverified-profile', registryProfileId: null });
  });

  it('uses only the persisted source binding and rejects wrong-origin, wrong-scope, and unavailable profiles', () => {
    const entry = snapshot('https://catalog.example/private.json', 'acme.private').entries[0]!;
    const item: MarketplaceIndexQueryResultV1['items'][number] = {
      ...entry,
      distribution: {
        ...entry.distribution,
        registryOrigin: 'https://registry.acme.test',
        registryProfileId: 'catalog-controlled',
      },
      source: { id: 'marketplace:private', title: 'Private', kind: 'curated', sourceUrl: 'https://catalog.example/private.json' },
      freshness: { state: 'fresh', fetchedAtMs: 1 },
      admission: { install: 'full-review', mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
      artifactAccess: { state: 'unverified-profile', registryProfileId: 'catalog-controlled' },
    };
    const source = { ...item.source, enabled: true, origin: 'curated' as const, registryProfileId: 'host-bound' };
    const profile = {
      profileId: 'host-bound',
      origin: 'https://registry.acme.test',
      scopes: ['@acme'],
      useAsDefault: false,
      hasCredentials: true,
      availability: 'available' as const,
    };

    expect(projectMarketplaceArtifactAccess(item, [profile], source).artifactAccess)
      .toEqual({ state: 'available', registryProfileId: 'host-bound' });
    expect(projectMarketplaceArtifactAccess(item, [{ ...profile, origin: 'https://wrong.test' }], source).artifactAccess.state)
      .toBe('unverified-profile');
    expect(projectMarketplaceArtifactAccess(item, [{ ...profile, scopes: ['@other'] }], source).artifactAccess.state)
      .toBe('unverified-profile');
    expect(projectMarketplaceArtifactAccess(item, [{ ...profile, availability: 'sign_in_required' }], source).artifactAccess.state)
      .toBe('auth-unavailable');
    expect(projectMarketplaceArtifactAccess(item, [], source).artifactAccess.state).toBe('source-removed');
  });

  it('keeps a tested credential-free bound profile installable instead of demanding a sign-in', () => {
    const entry = snapshot('https://catalog.example/private.json', 'acme.private').entries[0]!;
    const item: MarketplaceIndexQueryResultV1['items'][number] = {
      ...entry,
      distribution: { ...entry.distribution, registryOrigin: 'https://registry.acme.test' },
      source: { id: 'marketplace:private', title: 'Private', kind: 'curated', sourceUrl: 'https://catalog.example/private.json' },
      freshness: { state: 'fresh', fetchedAtMs: 1 },
      admission: { install: 'full-review', mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
      artifactAccess: { state: 'public', registryProfileId: null },
    };
    const source = { ...item.source, enabled: true, origin: 'curated' as const, registryProfileId: 'host-bound' };
    // An anonymous internal registry is a supported profile: it references no
    // credential at all, so the canonical profile projection reports it
    // `available` rather than `sign_in_required`.
    const credentialFreeProfile = {
      profileId: 'host-bound',
      origin: 'https://registry.acme.test',
      scopes: ['@acme'],
      useAsDefault: false,
      hasCredentials: false,
      availability: 'available' as const,
    };

    expect(projectMarketplaceArtifactAccess(item, [credentialFreeProfile], source).artifactAccess)
      .toEqual({ state: 'available', registryProfileId: 'host-bound' });
    expect(projectMarketplaceArtifactAccess(
      item,
      [{ ...credentialFreeProfile, availability: 'sign_in_required' as const }],
      source,
    ).artifactAccess).toEqual({ state: 'auth-unavailable', registryProfileId: 'host-bound' });
  });

  it('resolves an exact install against a bound registry profile that never stored a credential', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-credential-free-'));
    homes.push(home);
    const sourceStore = createMarketplaceSourceRegistryStore({ happyHomeDir: home });
    const seeded = (await sourceStore.read()).sources[0]!;
    const source = await sourceStore.upsertSource({
      sourceUrl: seeded.sourceUrl,
      registryProfileId: 'registry_anonymous',
    });
    const profiles = createNpmRegistryProfileService({
      happyHomeDir: home,
      probe: async () => ({ status: 'available' }),
    });
    await profiles.mutate({
      action: 'add', machineId: 'machine-1', expectedRevision: 0, mutationId: 'mutation-add-anonymous',
      profileId: 'registry_anonymous',
      profile: {
        displayName: 'Anonymous internal', origin: 'https://registry.acme.test', scopes: ['@acme'],
        useAsDefault: false, allowPrivateNetwork: false,
      },
    });
    // No `login`: the profile intentionally carries no credential reference.
    await profiles.mutate({
      action: 'test', machineId: 'machine-1', expectedRevision: 1, mutationId: 'mutation-test-anonymous',
      profileId: 'registry_anonymous',
    });
    const document = snapshot(source.sourceUrl, 'acme.private');
    document.source = { id: source.id, title: source.title, kind: 'curated', sourceUrl: source.sourceUrl };
    document.entries[0]!.distribution.registryOrigin = 'https://registry.acme.test';
    const service = createMarketplaceIndexService({ happyHomeDir: home, loadSource: async () => document });

    const queried = await service.querySources({ filters: { includeUnavailable: true } }, [source]);
    expect(queried.items[0]?.artifactAccess)
      .toEqual({ state: 'available', registryProfileId: 'registry_anonymous' });

    const resolved = await resolveExactMarketplaceListingForInstall({
      happyHomeDir: home,
      sourceId: source.id,
      pluginId: 'acme.private',
    }, service);
    expect(resolved).toMatchObject({ ok: true, resolution: { registryProfileId: 'registry_anonymous' } });
  });

  it('re-reads the current bound profile and revokes marketplace availability after logout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    const sourceStore = createMarketplaceSourceRegistryStore({ happyHomeDir: home });
    const seeded = (await sourceStore.read()).sources[0]!;
    const source = await sourceStore.upsertSource({
      sourceUrl: seeded.sourceUrl,
      registryProfileId: 'registry_private',
    });
    const profiles = createNpmRegistryProfileService({
      happyHomeDir: home,
      probe: async () => ({ status: 'available' }),
    });
    await profiles.mutate({
      action: 'add', machineId: 'machine-1', expectedRevision: 0, mutationId: 'mutation-add-private',
      profileId: 'registry_private',
      profile: {
        displayName: 'Private', origin: 'https://registry.acme.test', scopes: ['@acme'],
        useAsDefault: false, allowPrivateNetwork: false,
      },
    });
    await profiles.mutate({
      action: 'login', machineId: 'machine-1', expectedRevision: 1, mutationId: 'mutation-login-private',
      profileId: 'registry_private', credential: { kind: 'bearer_token', secret: 'boundary-secret' },
    });
    await profiles.mutate({
      action: 'test', machineId: 'machine-1', expectedRevision: 2, mutationId: 'mutation-test-private',
      profileId: 'registry_private',
    });
    const document = snapshot(source.sourceUrl, 'acme.private');
    document.source = {
      id: source.id,
      title: source.title,
      kind: 'curated',
      sourceUrl: source.sourceUrl,
    };
    document.entries[0]!.distribution.registryOrigin = 'https://registry.acme.test';
    const service = createMarketplaceIndexService({ happyHomeDir: home, loadSource: async () => document });
    const available = await service.querySources({ filters: { includeUnavailable: true } }, [source]);
    expect(available.items, JSON.stringify(available)).toHaveLength(1);
    expect(available.items[0]?.artifactAccess).toEqual({ state: 'available', registryProfileId: 'registry_private' });

    await profiles.mutate({
      action: 'logout', machineId: 'machine-1', expectedRevision: 3, mutationId: 'mutation-logout-private',
      profileId: 'registry_private',
    });
    const revoked = await service.querySources({ filters: { includeUnavailable: true } }, [source]);
    expect(revoked.items[0]?.artifactAccess).toEqual({ state: 'auth-unavailable', registryProfileId: 'registry_private' });
  });
});
