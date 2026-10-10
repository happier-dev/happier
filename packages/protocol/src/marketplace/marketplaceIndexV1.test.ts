import { describe, expect, it } from 'vitest';

import {
  createMarketplaceNpmDiscoveryProjectionV1,
  decideMarketplaceListingInstallV1,
  deriveMarketplaceNpmCompatibilityPlatformsV1,
  draftMarketplaceRegistryProfileV1,
  MarketplaceIndexQueryResultV1Schema,
  MarketplaceIndexQueryV1Schema,
  MarketplaceIndexEntryV1Schema,
  MarketplaceNpmDiscoveryProjectionV1Schema,
  MarketplaceIndexSourceSnapshotV1Schema,
  marketplaceNpmDiscoveryProjectionEqualV1,
  parseMarketplaceIndexSourceSnapshotV1,
  readMarketplaceListingRegistryProfileRequirementV1,
  readMarketplaceNpmDiscoveryProjectionV1,
  type MarketplaceIndexItemV1,
  type MarketplaceListingInstallDecisionV1,
} from './marketplaceIndexV1.js';
import { PluginCompatibilityProjectionV1Schema } from '../plugins/availability/v1.js';

describe('MarketplaceIndexV1', () => {
  it('preserves large listing facts and filters through canonical projections', () => {
    const ids = Array.from({ length: 140 }, (_, index) => `entry-${index}`);
    const categories = Array.from({ length: 40 }, (_, index) => `category-${index}-${'a'.repeat(140)}`);
    const entry = {
      pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' },
      display: { title: 'Title'.repeat(200), description: 'Description'.repeat(500) },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.example', packageName: '@acme/plugin', version: `1.0.0-${'a'.repeat(150)}`, integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
      manifestDigest: `sha256:${'a'.repeat(64)}`, compatibility: { happier: `>=0.0.0${' '.repeat(300)}<10000.0.0`, platforms: Array.from({ length: 8 }, () => 'linux') },
      summary: { contributions: ids, requiredHostAccess: ids, optionalHostAccess: ids, executableRealms: Array.from({ length: 5 }, () => 'daemon') },
      review: { status: 'unreviewed', reviewedAt: null, reason: 'Reason'.repeat(300) },
      categories, media: Array.from({ length: 20 }, (_, index) => `https://media.example/${index}`), updatePolicy: 'allowed', links: {},
    };
    expect(MarketplaceIndexEntryV1Schema.parse(entry)).toEqual(entry);
    expect(MarketplaceNpmDiscoveryProjectionV1Schema.parse({
      version: 1, pluginId: entry.pluginId, manifestDigest: entry.manifestDigest, display: entry.display, summary: entry.summary,
    }).summary).toEqual(entry.summary);
  });
  it('preserves large query filter collections without competing count cutoffs', () => {
    const filters = {
      categories: Array.from({ length: 40 }, (_, index) => `category-${index}`),
      pluginIds: Array.from({ length: 12 }, (_, index) => `acme.plugin-${index}`),
      platforms: Array.from({ length: 8 }, () => 'linux'),
      sourceKinds: Array.from({ length: 5 }, () => 'user'),
    };
    expect(MarketplaceIndexQueryV1Schema.parse({ filters }).filters).toEqual(filters);
  });
  it('preserves full query text beyond the former cutoff', () => {
    const text = 'terminal theme '.repeat(100).trim();
    expect(MarketplaceIndexQueryV1Schema.parse({ text }).text).toBe(text);
  });

  it('preserves valid catalogs beyond the former entry cutoff', () => {
    const entry = {
      pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Acme', description: null },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.example', packageName: '@acme/plugin', version: '1.0.0', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
      manifestDigest: `sha256:${'a'.repeat(64)}`, compatibility: { platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      review: { status: 'unreviewed', reviewedAt: null }, categories: [], media: [], updatePolicy: 'allowed', links: {},
    };
    const catalog = {
      source: { id: `source-${'a'.repeat(300)}`, title: 'title'.repeat(200), kind: 'user', sourceUrl: `https://catalog.example/index.json?key=${'x'.repeat(3_000)}` },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: Array.from({ length: 5_001 }, () => entry), diagnostics: [],
    };
    expect(MarketplaceIndexSourceSnapshotV1Schema.parse(catalog)).toEqual(catalog);
    expect(parseMarketplaceIndexSourceSnapshotV1(catalog)).toEqual(catalog);
  });
  it('preserves every queried source and diagnostic beyond the former count limits', () => {
    const diagnostics = Array.from({ length: 140 }, (_, index) => ({ code: `reason_${index}`, message: `Reason ${index}` }));
    const sources = Array.from({ length: 70 }, (_, index) => ({
      source: { id: `source-${index}`, title: `Source ${index}`, kind: 'user' as const, sourceUrl: `https://catalog.example/${index}.json` },
      freshness: { state: 'fresh' as const, fetchedAtMs: 1 },
      diagnostics,
    }));
    const query = MarketplaceIndexQueryV1Schema.parse({ filters: { sourceIds: sources.map(({ source }) => source.id) } });
    expect(query.filters.sourceIds).toHaveLength(70);
    expect(MarketplaceIndexSourceSnapshotV1Schema.parse({ ...sources[0], entries: [] }).diagnostics).toEqual(diagnostics);
    expect(MarketplaceIndexQueryResultV1Schema.parse({ revision: 1, items: [], nextCursor: null, sources, diagnostics }))
      .toEqual({ revision: 1, items: [], nextCursor: null, sources, diagnostics });
  });
  it('derives a closed npm discovery projection from generated compatibility facts', () => {
    const compatibility = PluginCompatibilityProjectionV1Schema.parse({
      version: 1,
      manifest: {
        schemaVersion: 2,
        id: 'acme.discovery',
        version: '1.0.0',
        displayName: { key: 'plugin.title', fallback: 'Acme Discovery' },
        description: { key: 'plugin.description', fallback: 'Derived from the manifest' },
        engines: { happier: '>=1.0.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/index.js' },
        hostAccess: {
          required: [{
            id: 'network',
            reason: 'Connect to Acme',
            capability: 'network',
            scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }] },
          }],
          optional: [],
        },
        contributes: {},
      },
      uiArtifacts: { version: 2, entries: [] },
    });

    const projection = createMarketplaceNpmDiscoveryProjectionV1({
      compatibility,
      manifestDigest: `sha256:${'a'.repeat(64)}`,
    });

    expect(projection).toEqual({
      version: 1,
      pluginId: 'acme.discovery',
      manifestDigest: `sha256:${'a'.repeat(64)}`,
      display: { title: 'Acme Discovery', description: 'Derived from the manifest' },
      summary: {
        contributions: [],
        requiredHostAccess: ['network'],
        optionalHostAccess: [],
        executableRealms: ['daemon'],
      },
    });
    expect(deriveMarketplaceNpmCompatibilityPlatformsV1(compatibility)).toEqual([]);
    expect(MarketplaceNpmDiscoveryProjectionV1Schema.safeParse({
      ...projection,
      compatibility: compatibility.manifest.engines,
    }).success).toBe(false);
  });

  it('keeps the canonical pack projection closed while the reader admits additive fields', () => {
    const projection = {
      version: 1,
      pluginId: 'acme.community',
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      display: { title: 'Community', description: null },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
    };
    expect(MarketplaceNpmDiscoveryProjectionV1Schema.safeParse({ ...projection, futureListingFact: { addedIn: 2 } }).success).toBe(false);
    expect(MarketplaceNpmDiscoveryProjectionV1Schema.safeParse(projection).success).toBe(true);
  });

  it('bounds query page size and rejects malformed source entries', () => {
    expect(MarketplaceIndexQueryV1Schema.safeParse({ text: 'x'.repeat(257), limit: 101, cursor: null, filters: {} }).success).toBe(false);
    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({
      source: { id: 'user', title: 'User', kind: 'user', sourceUrl: 'https://catalog.example/index.json' },
      freshness: { state: 'fresh', fetchedAtMs: 1 },
      entries: Array.from({ length: 5_001 }, () => ({})),
      diagnostics: [],
    }).success).toBe(false);
  });

  it('preserves diagnostic text through source and query projections without a separate byte cutoff', () => {
    const source = { id: 'user', title: 'User', kind: 'user' as const, sourceUrl: 'https://catalog.example/index.json' };
    const freshness = { state: 'fresh' as const, fetchedAtMs: 1 };
    const exact = { code: 'source_failed', message: 'é'.repeat(1_024) };
    const oversized = { code: 'source_failed', message: 'é'.repeat(1_025) };

    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({
      source, freshness, entries: [], diagnostics: [exact],
    }).success).toBe(true);
    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({
      source, freshness, entries: [], diagnostics: [oversized],
    }).success).toBe(true);

    expect(MarketplaceIndexQueryResultV1Schema.safeParse({
      revision: 1,
      items: [],
      nextCursor: null,
      sources: [{ source, freshness, diagnostics: [exact] }],
      diagnostics: [exact],
    }).success).toBe(true);
    expect(MarketplaceIndexQueryResultV1Schema.safeParse({
      revision: 1,
      items: [],
      nextCursor: null,
      sources: [{ source, freshness, diagnostics: [oversized] }],
      diagnostics: [oversized],
    }).success).toBe(true);
  });

  it.each(['http://catalog.example/index.json', 'javascript:alert(1)', 'https://token@catalog.example/index.json'])(
    'rejects unsafe source URL %s',
    (sourceUrl) => {
      expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({
        source: { id: 'user', title: 'User', kind: 'user', sourceUrl },
        freshness: { state: 'fresh', fetchedAtMs: 1 },
        entries: [], diagnostics: [],
      }).success).toBe(false);
    },
  );

  it('admits only the explicit update policy vocabulary with no unpublished aliases', () => {
    const entryBase = {
      pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Acme', description: null },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.example', packageName: '@acme/plugin', version: '1.0.0', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', compatibility: { happier: '>=1', platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] }, review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' },
      categories: [], media: [], updatePolicy: 'allowed', links: {},
    };
    const source = { id: 'curated', title: 'Curated', kind: 'curated', sourceUrl: 'https://catalog.example/index.json' };
    for (const updatePolicy of ['pinned', 'allowed'] as const) {
      expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({
        source, freshness: { state: 'fresh', fetchedAtMs: 1 },
        entries: [{ ...entryBase, updatePolicy }], diagnostics: [],
      }).success).toBe(true);
    }
    for (const retiredPolicy of ['curated-auto', 'manual', 'automatic']) {
      expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({
        source, freshness: { state: 'fresh', fetchedAtMs: 1 },
        entries: [{ ...entryBase, updatePolicy: retiredPolicy }], diagnostics: [],
      }).success).toBe(false);
    }
  });

  it('never projects curation as hidden install authorization', () => {
    const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
    const entry = {
      pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Acme', description: null },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.example', packageName: '@acme/plugin', version: '1.0.0', integrity },
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', compatibility: { happier: '>=1', platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] }, review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' },
      categories: [], media: [], updatePolicy: 'allowed', links: {},
    };
    const result = MarketplaceIndexQueryResultV1Schema.parse({
      revision: 1,
      items: [{ ...entry, source: { id: 'curated', title: 'Curated', kind: 'curated', sourceUrl: 'https://catalog.example/index.json' }, freshness: { state: 'fresh', fetchedAtMs: 1 }, admission: { install: 'full-review', mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true }, artifactAccess: { state: 'public', registryProfileId: null } }],
      nextCursor: null,
      sources: [],
      diagnostics: [],
    });
    expect(result.items[0].admission).toEqual({
      install: 'full-review',
      mutatesInstalledTrust: false,
      disablesInstalledCode: false,
      directNpmRequiresFullReview: true,
    });
    expect(MarketplaceIndexQueryResultV1Schema.safeParse({
      revision: 1,
      items: [{ ...result.items[0], admission: { install: 'allowed', mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true } }],
      nextCursor: null,
      sources: [],
      diagnostics: [],
    }).success).toBe(false);
  });

  it('rejects registry URLs that are not canonical origins', () => {
    const base = {
      pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Acme', description: null },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.example/path?token=x', packageName: '@acme/plugin', version: '1.0.0', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', compatibility: { happier: '>=1', platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] }, review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' },
      categories: [], media: [], updatePolicy: 'allowed', links: {},
    };
    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({ source: { id: 'curated', title: 'Curated', kind: 'curated', sourceUrl: 'https://catalog.example/index.json' }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [base], diagnostics: [] }).success).toBe(false);
  });

  it.each([
    { version: 'latest', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
    { version: '1.0', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
    { version: '1.0.0', integrity: 'sha512-YWJjZA==' },
  ])('rejects a marketplace release without exact canonical version and full SHA-512 SRI: $version', (distribution) => {
    const entry = {
      pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Acme', description: null },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.example', packageName: '@acme/plugin', ...distribution },
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', compatibility: { happier: '>=1', platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] }, review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' },
      categories: [], media: [], updatePolicy: 'allowed', links: {},
    };
    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse({ source: { id: 'curated', title: 'Curated', kind: 'curated', sourceUrl: 'https://catalog.example/index.json' }, freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [entry], diagnostics: [] }).success).toBe(false);
  });
});

describe('parseMarketplaceIndexSourceSnapshotV1', () => {
  const entry = {
    pluginId: 'acme.plugin',
    publisher: { id: 'acme', displayName: 'Acme' },
    display: { title: 'Acme', description: null },
    distribution: {
      kind: 'npm', registryOrigin: 'https://registry.example', packageName: '@acme/plugin',
      version: '1.0.0', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    },
    manifestDigest: `sha256:${'a'.repeat(64)}`,
    compatibility: { platforms: ['linux'] },
    summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
    review: { status: 'unreviewed', reviewedAt: null },
    categories: [], media: [], updatePolicy: 'allowed', links: {},
  };
  const snapshot = {
    source: { id: 'user', title: 'User', kind: 'user', sourceUrl: 'https://catalog.example/index.json' },
    freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [entry], diagnostics: [],
  };

  it('preserves an absent author engine floor in the canonical listing and its reader', () => {
    expect(MarketplaceIndexSourceSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(parseMarketplaceIndexSourceSnapshotV1(snapshot)).toEqual(snapshot);
    for (const happier of ['', '*', 'not-a-range']) {
      expect(() => parseMarketplaceIndexSourceSnapshotV1({
        ...snapshot, entries: [{ ...entry, compatibility: { ...entry.compatibility, happier } }],
      })).toThrow();
    }
  });

  it('drops only additive presentation while canonical output remains closed', () => {
    const additive = { ...snapshot, entries: [{
      ...entry,
      display: { ...entry.display, badge: { label: 'New' } },
      summary: { ...entry.summary, installFootprint: { bytes: 1_024 } },
      links: { documentation: 'https://example.test/docs' },
    }] };
    expect(MarketplaceIndexSourceSnapshotV1Schema.safeParse(additive).success).toBe(false);
    expect(parseMarketplaceIndexSourceSnapshotV1(additive)).toEqual(snapshot);
  });

  it('keeps known presentation and all identity, authority and executable facts strict', () => {
    for (const invalidEntry of [
      { ...entry, display: { ...entry.display, title: 42, badge: 'New' } },
      { ...entry, summary: { ...entry.summary, executableRealms: ['future'] } },
      { ...entry, links: { homepage: 'javascript:alert(1)', documentation: 'https://example.test' } },
      { ...entry, pluginId: 42 },
      { ...entry, publisher: { ...entry.publisher, verified: true } },
      { ...entry, distribution: { ...entry.distribution, executableUrl: 'https://example.test/code' } },
      { ...entry, compatibility: { ...entry.compatibility, futureAuthority: true } },
      { ...entry, review: { ...entry.review, trusted: true } },
      { ...entry, review: { status: 'approved', reviewedAt: '2026-09-05T00:00:00.000Z' } },
      { ...entry, activate: './future.js' },
    ]) {
      expect(() => parseMarketplaceIndexSourceSnapshotV1({ ...snapshot, entries: [invalidEntry] })).toThrow();
    }
    expect(() => parseMarketplaceIndexSourceSnapshotV1({
      ...snapshot, source: { ...snapshot.source, credentials: 'secret' },
    })).toThrow();
    expect(() => parseMarketplaceIndexSourceSnapshotV1({ ...snapshot, authority: 'future' })).toThrow();
  });
});

describe('readMarketplaceNpmDiscoveryProjectionV1', () => {
  const CORE_PROJECTION = {
    version: 1,
    pluginId: 'acme.community',
    manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    display: { title: 'Community', description: null },
    summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
  } as const;

  it('admits unknown additive fields at the top level and inside known objects, and normalizes them away', () => {
    const additive = {
      ...CORE_PROJECTION,
      futureListingFact: { addedIn: 2, notes: ['ignored'] },
      display: { ...CORE_PROJECTION.display, badgeUrl: 'https://cdn.example/badge.png' },
      summary: { ...CORE_PROJECTION.summary, installFootprint: { bytes: 1_024 } },
    };
    expect(readMarketplaceNpmDiscoveryProjectionV1(additive)).toEqual({ status: 'parsed', projection: CORE_PROJECTION });
  });

  it('rejects malformed known fields and missing security- or compatibility-critical fields', () => {
    expect(readMarketplaceNpmDiscoveryProjectionV1({
      ...CORE_PROJECTION,
      display: { title: 42, description: null },
    }).status).toBe('invalid');
    expect(readMarketplaceNpmDiscoveryProjectionV1({
      ...CORE_PROJECTION,
      summary: { ...CORE_PROJECTION.summary, requiredHostAccess: 'network' },
    }).status).toBe('invalid');
    expect(readMarketplaceNpmDiscoveryProjectionV1({
      version: 1,
      pluginId: 'acme.community',
      display: CORE_PROJECTION.display,
      summary: CORE_PROJECTION.summary,
    }).status).toBe('invalid');
    expect(readMarketplaceNpmDiscoveryProjectionV1({
      ...CORE_PROJECTION,
      version: '1',
    }).status).toBe('invalid');
    expect(readMarketplaceNpmDiscoveryProjectionV1(null).status).toBe('invalid');
  });

  it('reports numeric projection versions other than one as unsupported rather than malformed', () => {
    expect(readMarketplaceNpmDiscoveryProjectionV1({ ...CORE_PROJECTION, version: 2 })).toEqual({ status: 'unsupported-version' });
    expect(readMarketplaceNpmDiscoveryProjectionV1({ ...CORE_PROJECTION, version: 0 }).status).toBe('unsupported-version');
  });

  it('compares the normalized known core, ignoring additive fields and malformed inputs', () => {
    const additive = {
      ...CORE_PROJECTION,
      futureListingFact: { addedIn: 2 },
      display: { ...CORE_PROJECTION.display, badgeUrl: 'https://cdn.example/badge.png' },
      summary: { ...CORE_PROJECTION.summary, installFootprint: { bytes: 1_024 } },
    };
    expect(marketplaceNpmDiscoveryProjectionEqualV1(additive, CORE_PROJECTION)).toBe(true);
    expect(marketplaceNpmDiscoveryProjectionEqualV1(
      { ...CORE_PROJECTION, display: { title: '  Community  ', description: null } },
      CORE_PROJECTION,
    )).toBe(true);
    expect(marketplaceNpmDiscoveryProjectionEqualV1(
      { ...CORE_PROJECTION, display: { title: 'Other', description: null } },
      CORE_PROJECTION,
    )).toBe(false);
    expect(marketplaceNpmDiscoveryProjectionEqualV1({ ...CORE_PROJECTION, version: 2 }, CORE_PROJECTION)).toBe(false);
    expect(marketplaceNpmDiscoveryProjectionEqualV1({ ...CORE_PROJECTION, manifestDigest: 'sha256:bbbb' }, CORE_PROJECTION)).toBe(false);
    expect(marketplaceNpmDiscoveryProjectionEqualV1(null, CORE_PROJECTION)).toBe(false);
  });
});

describe('decideMarketplaceListingInstallV1', () => {
  const USER_ITEM_SOURCE = { id: 'team', title: 'Team catalog', kind: 'user', sourceUrl: 'https://team.example/index.json' } as const;
  const COMMUNITY_ITEM_SOURCE = { id: 'marketplace:community-npm', title: 'Community npm', kind: 'community-npm', sourceUrl: 'https://registry.example/-/v1/search' } as const;
  const UNREVIEWED = { status: 'unreviewed', reviewedAt: null } as const;

  function createListingItem(overrides: Partial<MarketplaceIndexItemV1> = {}): MarketplaceIndexItemV1 {
    return {
      pluginId: 'acme.plugin',
      publisher: { id: 'acme', displayName: 'Acme' },
      display: { title: 'Acme', description: null },
      distribution: {
        kind: 'npm',
        registryOrigin: 'https://registry.example',
        packageName: '@acme/plugin',
        version: '1.0.0',
        integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      },
      manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      compatibility: { happier: '>=1', platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' },
      categories: [],
      media: [],
      updatePolicy: 'allowed',
      links: {},
      source: { id: 'curated', title: 'Curated', kind: 'curated', sourceUrl: 'https://catalog.example/index.json' },
      freshness: { state: 'fresh', fetchedAtMs: 1 },
      admission: { install: 'full-review', mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
      artifactAccess: { state: 'public', registryProfileId: null },
      ...overrides,
    };
  }

  const decisionTable: readonly [
    name: string,
    overrides: Partial<MarketplaceIndexItemV1>,
    expected: MarketplaceListingInstallDecisionV1,
  ][] = [
    ['curated approved listing with a recorded review', {}, { installable: true }],
    ['curated approved listing reachable through its private registry profile',
      { artifactAccess: { state: 'available', registryProfileId: 'registry_one' } }, { installable: true }],
    ['user catalog listing left unreviewed for the full-review flow',
      { source: USER_ITEM_SOURCE, review: UNREVIEWED, updatePolicy: 'allowed' }, { installable: true }],
    ['community npm listing left unreviewed for the full-review flow',
      { source: COMMUNITY_ITEM_SOURCE, review: UNREVIEWED, updatePolicy: 'allowed' }, { installable: true }],
    ['curated listing withdrawn by curation', { review: { status: 'withdrawn', reviewedAt: null } },
      { installable: false, block: 'curated-review-withdrawn' }],
    ['curated listing blocked by curation', { review: { status: 'blocked', reviewedAt: null } },
      { installable: false, block: 'curated-review-not-approved' }],
    ['curated approved listing without a recorded review timestamp', { review: { status: 'approved', reviewedAt: null } },
      { installable: false, block: 'curated-review-not-approved' }],
    ['user listing that claims a curated review',
      { source: USER_ITEM_SOURCE, review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' } },
      { installable: false, block: 'full-review-unavailable' }],
    ['community npm listing that claims a curation review state',
      { source: COMMUNITY_ITEM_SOURCE, review: { status: 'withdrawn', reviewedAt: null } },
      { installable: false, block: 'full-review-unavailable' }],
    ['curated listing served from a stale source',
      { freshness: { state: 'stale', fetchedAtMs: 1, staleSinceMs: 1 } },
      { installable: false, block: 'source-not-fresh' }],
    ['user listing served from an offline source',
      { source: USER_ITEM_SOURCE, review: UNREVIEWED, freshness: { state: 'stale-offline', fetchedAtMs: 1, staleSinceMs: 1 } },
      { installable: false, block: 'source-not-fresh' }],
    ['curated listing served from an unreadable source',
      { freshness: { state: 'corrupt', fetchedAtMs: 1 } },
      { installable: false, block: 'source-not-fresh' }],
    ['curated listing whose artifact needs an unavailable registry profile',
      { artifactAccess: { state: 'auth-unavailable', registryProfileId: 'registry_one' } },
      { installable: false, block: 'artifact-unavailable' }],
    ['user listing whose artifact is unreachable offline',
      { source: USER_ITEM_SOURCE, review: UNREVIEWED, artifactAccess: { state: 'offline', registryProfileId: null } },
      { installable: false, block: 'artifact-unavailable' }],
    ['community listing whose artifact source was removed',
      { source: COMMUNITY_ITEM_SOURCE, review: UNREVIEWED, artifactAccess: { state: 'source-removed', registryProfileId: null } },
      { installable: false, block: 'artifact-unavailable' }],
    ['curated listing whose registry profile could not be verified',
      { artifactAccess: { state: 'unverified-profile', registryProfileId: null } },
      { installable: false, block: 'artifact-unavailable' }],
  ];

  it.each(decisionTable)('%s', (_name, overrides, expected) => {
    expect(decideMarketplaceListingInstallV1(createListingItem(overrides))).toEqual(expected);
  });

  it('refuses a listing whose admission left the constant full-review path', () => {
    const user = createListingItem({ source: USER_ITEM_SOURCE, review: UNREVIEWED, updatePolicy: 'allowed' });
    // Admission is a schema constant; force a drifted value through the
    // fixture boundary to pin the defensive decision for producers that
    // bypass the schema.
    const drifted = { ...user, admission: { ...user.admission, install: 'allowed' } } as unknown as MarketplaceIndexItemV1;
    expect(decideMarketplaceListingInstallV1(drifted))
      .toEqual({ installable: false, block: 'full-review-unavailable' });
  });

  it('refuses a listing whose source kind no consumer can interpret', () => {
    const item = createListingItem();
    // Parsed fixtures cannot carry an unknown kind; force one through the
    // fixture boundary to pin the defensive decision for runtime producers.
    const unknownKind = { ...item, source: { ...item.source, kind: 'enterprise' } } as unknown as MarketplaceIndexItemV1;
    expect(decideMarketplaceListingInstallV1(unknownKind))
      .toEqual({ installable: false, block: 'unsupported-source-kind' });
  });

  it('decides durable review trust before transient machine reachability', () => {
    // A stale, unreachable, withdrawn curated listing is refused for the
    // durable withdrawal first; between the machine facts, freshness decides
    // before artifact access.
    expect(decideMarketplaceListingInstallV1(createListingItem({
      review: { status: 'withdrawn', reviewedAt: null },
      freshness: { state: 'stale', fetchedAtMs: 1, staleSinceMs: 1 },
      artifactAccess: { state: 'offline', registryProfileId: null },
    }))).toEqual({ installable: false, block: 'curated-review-withdrawn' });
    expect(decideMarketplaceListingInstallV1(createListingItem({
      freshness: { state: 'stale', fetchedAtMs: 1, staleSinceMs: 1 },
      artifactAccess: { state: 'auth-unavailable', registryProfileId: 'registry_one' },
    }))).toEqual({ installable: false, block: 'source-not-fresh' });
  });

  it('drafts the profile a Home adds for a required registry from the package scope', () => {
    expect(draftMarketplaceRegistryProfileV1({ registryOrigin: 'https://npm.acme.example', packageName: '@acme/plugin' }))
      .toEqual({ displayName: 'npm.acme.example', origin: 'https://npm.acme.example', scopes: ['@acme'], useAsDefault: false, allowPrivateNetwork: false });
    expect(draftMarketplaceRegistryProfileV1({ registryOrigin: 'https://npm.acme.example', packageName: 'acme-plugin' }))
      .toEqual({ displayName: 'npm.acme.example', origin: 'https://npm.acme.example', scopes: [], useAsDefault: true, allowPrivateNetwork: false });
  });

  it('names the registry selection only when artifact access is the one remaining block', () => {
    const profiles = [{ profileId: 'registry_team', origin: 'https://registry.example' }];
    const requirement = (overrides: Partial<MarketplaceIndexItemV1>) => (
      readMarketplaceListingRegistryProfileRequirementV1(createListingItem(overrides), profiles)
    );
    // A profile that must sign in again is named as it is bound.
    expect(requirement({ artifactAccess: { state: 'auth-unavailable', registryProfileId: 'registry_bound' } }))
      .toEqual({ registryOrigin: 'https://registry.example', packageName: '@acme/plugin', registryProfileId: 'registry_bound' });
    // No usable binding: this Home's profile for the origin is the candidate.
    for (const state of ['unverified-profile', 'source-removed'] as const) {
      expect(requirement({ artifactAccess: { state, registryProfileId: 'registry_gone' } }))
        .toEqual({ registryOrigin: 'https://registry.example', packageName: '@acme/plugin', registryProfileId: 'registry_team' });
    }
    expect(readMarketplaceListingRegistryProfileRequirementV1(
      createListingItem({ artifactAccess: { state: 'unverified-profile', registryProfileId: null } }),
      [],
    )).toEqual({ registryOrigin: 'https://registry.example', packageName: '@acme/plugin', registryProfileId: null });
    // Reachability and durable refusals are not registry selections.
    expect(requirement({ artifactAccess: { state: 'offline', registryProfileId: 'registry_team' } })).toBeNull();
    expect(requirement({ artifactAccess: { state: 'public', registryProfileId: null } })).toBeNull();
    expect(requirement({
      freshness: { state: 'stale', fetchedAtMs: 1, staleSinceMs: 1 },
      artifactAccess: { state: 'auth-unavailable', registryProfileId: 'registry_bound' },
    })).toBeNull();
    expect(requirement({
      review: { status: 'withdrawn', reviewedAt: null },
      artifactAccess: { state: 'unverified-profile', registryProfileId: null },
    })).toBeNull();
  });
});
