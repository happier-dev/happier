import { describe, expect, it } from 'vitest';

import {
  createCuratedMarketplaceSourceV1,
  createDefaultCuratedMarketplaceSourceRegistryV1,
  MarketplaceSourceOriginV1Schema,
  MarketplaceSourceRegistryV1Schema,
  MarketplaceSourceV1Schema,
  seedCuratedMarketplaceSourceRegistryV1,
  resolvePreferredMarketplaceSource,
  createMarketplaceSourceV1,
} from './marketplaceSourceRegistryV1.js';

describe('marketplaceSourceRegistryV1 schemas', () => {
  it('bounds configured sources', () => {
    expect(MarketplaceSourceRegistryV1Schema.safeParse({ sources: Array.from({ length: 65 }, (_, index) => ({ id: `source-${index}`, title: `Source ${index}`, sourceUrl: `https://source-${index}.example/index.json`, enabled: true, origin: 'user' })) }).success).toBe(false);
  });

  it('defaults the registry to an empty source list', () => {
    expect(MarketplaceSourceRegistryV1Schema.parse({})).toEqual({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [],
    });
  });

  it('persists an opaque host-owned registry profile binding while accepting predecessor records without one', () => {
    const legacy = MarketplaceSourceV1Schema.parse({
      id: 'marketplace:legacy',
      title: 'Legacy',
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      enabled: true,
      origin: 'user',
    });
    expect(legacy.registryProfileId).toBeUndefined();

    expect(createMarketplaceSourceV1({
      sourceUrl: legacy.sourceUrl,
      registryProfileId: 'registry_private',
    }, legacy)).toMatchObject({ registryProfileId: 'registry_private' });
  });

  it('parses persisted marketplace sources with curated origin metadata without retaining unknown fields', () => {
    const source = MarketplaceSourceV1Schema.parse({
      id: 'marketplace:featured',
      title: 'Happier curated marketplace',
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      enabled: true,
      origin: 'curated',
      description: 'Official curated source',
      addedAtMs: 1,
      updatedAtMs: 2,
      futureSourceFlag: 'keep-me',
    });

    expect(source).toMatchObject({
      id: 'marketplace:featured',
      title: 'Happier curated marketplace',
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      enabled: true,
      origin: 'curated',
      description: 'Official curated source',
      addedAtMs: 1,
      updatedAtMs: 2,
    });
    expect(source).not.toHaveProperty('futureSourceFlag');
    expect(MarketplaceSourceOriginV1Schema.parse('user')).toBe('user');
  });

  it('does not persist unknown source-registry fields that could carry secrets or authority', () => {
    const parsed = MarketplaceSourceRegistryV1Schema.parse({
      schemaVersion: 1,
      t: 'happier_marketplace_source_registry_v1',
      sources: [
        {
          id: 'marketplace:featured',
          title: 'Happier curated marketplace',
          sourceUrl: 'https://marketplace.example.test/catalog.json',
          enabled: true,
          origin: 'curated',
          futureSourceFlag: 'keep-me',
        },
      ],
      futureRegistryFlag: 'keep-me',
    });

    expect(parsed.sources).toHaveLength(1);
    expect(parsed).not.toHaveProperty('futureRegistryFlag');
    expect(parsed.sources[0]).not.toHaveProperty('futureSourceFlag');
  });

  it.each([
    'http://catalog.example/index.json',
    'https://token@catalog.example/index.json',
    'https://catalog.example/index.json#secret',
  ])('rejects unsafe persisted source URL %s', (sourceUrl) => {
    expect(() => createMarketplaceSourceV1({ sourceUrl, title: 'Unsafe' })).toThrow(/credential-free HTTPS/i);
    expect(MarketplaceSourceV1Schema.safeParse({ id: 'unsafe', title: 'Unsafe', sourceUrl, enabled: true, origin: 'user' }).success).toBe(false);
  });

  it('rejects duplicate configured source ids and canonical URLs', () => {
    const source = { id: 'source-a', title: 'Source A', sourceUrl: 'https://catalog.example/index.json', enabled: true, origin: 'user' as const };
    expect(MarketplaceSourceRegistryV1Schema.safeParse({ sources: [source, { ...source, title: 'Duplicate' }] }).success).toBe(false);
    expect(MarketplaceSourceRegistryV1Schema.safeParse({ sources: [source, { ...source, id: 'source-b' }] }).success).toBe(false);
  });

  it('prefers enabled curated sources when selecting a default marketplace source', () => {
    expect(resolvePreferredMarketplaceSource([
      {
        id: 'marketplace:user',
        title: 'User',
        sourceUrl: 'https://user.example.test/catalog.json',
        enabled: true,
        origin: 'user',
      },
      {
        id: 'marketplace:curated',
        title: 'Curated',
        sourceUrl: 'https://curated.example.test/catalog.json',
        enabled: true,
        origin: 'curated',
      },
    ])).toEqual({
      id: 'marketplace:curated',
      title: 'Curated',
      sourceUrl: 'https://curated.example.test/catalog.json',
      enabled: true,
      origin: 'curated',
    });
  });

  it('creates and seeds a curated marketplace source as an ordinary registry entry', () => {
    const source = createCuratedMarketplaceSourceV1('https://marketplace.example.test/catalog.json');

    expect(source).toEqual({
      id: expect.stringMatching(/^marketplace:[0-9a-f]{12}$/),
      title: 'Happier curated marketplace',
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      enabled: true,
      origin: 'curated',
      description: 'Official curated source',
      addedAtMs: expect.any(Number),
      updatedAtMs: expect.any(Number),
    });

    expect(seedCuratedMarketplaceSourceRegistryV1({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [],
    }, source)).toEqual({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [source],
    });
  });

  it('normalizes blank marketplace source descriptions to null', () => {
    expect(createMarketplaceSourceV1({
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      title: 'Example marketplace',
      description: '   ',
    })).toMatchObject({
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      title: 'Example marketplace',
      description: null,
    });
  });

  it('creates a default curated marketplace source registry from one curated source', () => {
    expect(createDefaultCuratedMarketplaceSourceRegistryV1('https://marketplace.example.test/catalog.json')).toEqual({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [
        expect.objectContaining({
          title: 'Happier curated marketplace',
          sourceUrl: 'https://marketplace.example.test/catalog.json',
          enabled: true,
          origin: 'curated',
          description: 'Official curated source',
        }),
      ],
    });
  });
});
