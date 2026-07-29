import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MarketplaceIndexQueryResultV1, MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMarketplaceIndexService, projectMarketplaceArtifactAccess } from './service';
import { createMarketplaceSourceRegistryStore } from './sources/store';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';

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
      categories: [], media: [], updatePolicy: 'curated-auto', links: {},
    }],
    diagnostics: [],
  };
}

describe('createMarketplaceIndexService', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(homes.splice(0).map(async (home) => await rm(home, { recursive: true, force: true })));
  });

  it('derives revision from projected authority so different content cannot reuse revision 1 after restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const sourceUrl = String(input);
      const pluginId = sourceUrl.includes('one') ? 'acme.one' : 'acme.two';
      return new Response(JSON.stringify(snapshot(sourceUrl, pluginId)), { status: 200 });
    }));

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
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const sourceUrl = String(input);
      return new Response(JSON.stringify(snapshot(sourceUrl, 'acme.private')), { status: 200 });
    }));
    const service = createMarketplaceIndexService({ happyHomeDir: home });
    const source = {
      id: 'marketplace:private', title: 'Private', sourceUrl: 'https://catalog.example/private.json',
      enabled: true, origin: 'curated' as const,
    };
    const first = await service.querySources({ filters: {} }, [{ ...source, registryProfileId: 'registry_one' }]);
    const rebound = await service.querySources({ filters: {} }, [{ ...source, registryProfileId: 'registry_two' }]);
    expect(rebound.revision).not.toBe(first.revision);
  });

  it('rejects more than 65 active sources including the built-in community source allowance', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-marketplace-service-'));
    homes.push(home);
    const sources = Array.from({ length: 66 }, (_, index) => ({
      id: `marketplace:source-${index}`,
      title: `Source ${index}`,
      sourceUrl: `http://source-${index}.example/index.json`,
      enabled: true,
      origin: 'user' as const,
    }));
    await expect(createMarketplaceIndexService({ happyHomeDir: home }).querySources({ filters: {} }, sources)).rejects.toThrow(/source.*limit|65/i);
  });

  it('does not let a remote catalog select a host-owned private registry profile', () => {
    const entry = snapshot('https://catalog.example/private.json', 'acme.private').entries[0]!;
    const item: MarketplaceIndexQueryResultV1['items'][number] = {
      ...entry,
      distribution: { ...entry.distribution, registryProfileId: 'profile-private' },
      source: { id: 'marketplace:user', title: 'User', kind: 'user', sourceUrl: 'https://catalog.example/private.json' },
      freshness: { state: 'fresh', fetchedAtMs: 1 },
      admission: { curatedInstall: 'full-review', curatedUpdate: 'not-applicable', warning: true, mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
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
      admission: { curatedInstall: 'full-review', curatedUpdate: 'not-applicable', warning: true, mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
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
      admission: { curatedInstall: 'allowed', curatedUpdate: 'allowed', warning: false, mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
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
