import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as undici from 'undici';

import type { MarketplaceIndexQueryResultV1, MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveExactMarketplaceListingForInstall } from './exactInstall';
import {
  createMarketplaceIndexService,
  projectMarketplaceArtifactAccess,
} from './service';
import {accountMarketplaceUserSourceFixture,publishAccountRegistrySourcesFixture} from '@/plugins/testkit/accountRegistrySources';
import {resetActiveAccountSettingsSnapshotForTests} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
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
    picks: [],
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


describe('createMarketplaceIndexService', () => {
  beforeEach(()=>vi.stubGlobal('fetch',undici.fetch));
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(undici.fetch).mockReset();
    resetActiveAccountSettingsSnapshotForTests();
    await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));
  });
  it('reads an Agent-only listing through Registry and preserves the plugin install handoff',async()=>{
    const home=await mkdtemp(join(tmpdir(),'happier-marketplace-agent-'));homes.push(home);
    const source={...accountMarketplaceUserSourceFixture({sourceUrl:'https://catalog.example/agents.json'}),kinds:['agent' as const]};
    publishAccountRegistrySourcesFixture([source]);
    const document=snapshot(source.url,'acme.agent');
    document.source={id:source.id,title:source.title,kind:'user',sourceUrl:source.url};
    document.entries[0]!.review={status:'unreviewed',reviewedAt:null};
    document.entries[0]!.summary.contributions=['agents'];
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(document),{status:200}));
    expect(await resolveExactMarketplaceListingForInstall({happyHomeDir:home,sourceId:source.id,pluginId:'acme.agent',version:'1.0.0'}))
      .toMatchObject({ok:true,resolution:{listing:{pluginId:'acme.agent',distribution:{packageName:'@acme/agent'}}}});
    expect(undici.fetch).toHaveBeenCalledTimes(1);
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
    const persisted=accountMarketplaceUserSourceFixture({sourceUrl:'https://catalog.example/anonymous.json',registryProfileId:'registry_anonymous'});
    publishAccountRegistrySourcesFixture([persisted]);
    const source={...persisted,sourceUrl:persisted.url};
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
    document.source = { id: source.id, title: source.title, kind: 'user', sourceUrl: source.sourceUrl };
    document.entries[0]!.review = { status: 'unreviewed', reviewedAt: null };
    document.entries[0]!.distribution.registryOrigin = 'https://registry.acme.test';
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(document),{status:200}));
    const service = createMarketplaceIndexService({ happyHomeDir: home });
    const queried = await service.queryExactListing({sourceId:source.id,pluginId:'acme.private'});
    if(!queried.ok)throw new Error(queried.message);
    expect(queried.result.items[0]?.artifactAccess)
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
    const persisted=accountMarketplaceUserSourceFixture({sourceUrl:'https://catalog.example/private.json',registryProfileId:'registry_private'});
    publishAccountRegistrySourcesFixture([persisted]);
    const source={...persisted,sourceUrl:persisted.url};
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
      kind: 'user',
      sourceUrl: source.sourceUrl,
    };
    document.entries[0]!.review = { status: 'unreviewed', reviewedAt: null };
    document.entries[0]!.distribution.registryOrigin = 'https://registry.acme.test';
    vi.mocked(undici.fetch).mockImplementation(async()=>new undici.Response(JSON.stringify(document),{status:200}));
    const service = createMarketplaceIndexService({ happyHomeDir: home });
    const available = await service.queryExactListing({sourceId:source.id,pluginId:'acme.private'});
    if(!available.ok)throw new Error(available.message);
    expect(available.result.items).toHaveLength(1);
    expect(available.result.items[0]?.artifactAccess).toEqual({ state: 'available', registryProfileId: 'registry_private' });

    await profiles.mutate({
      action: 'logout', machineId: 'machine-1', expectedRevision: 3, mutationId: 'mutation-logout-private',
      profileId: 'registry_private',
    });
    const revoked = await service.queryExactListing({sourceId:source.id,pluginId:'acme.private'});
    if(!revoked.ok)throw new Error(revoked.message);
    expect(revoked.result.items[0]?.artifactAccess).toEqual({ state: 'auth-unavailable', registryProfileId: 'registry_private' });
  });
});
