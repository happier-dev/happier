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
  it('defaults the registry to an empty source list', () => {
    expect(MarketplaceSourceRegistryV1Schema.parse({})).toEqual({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [],
    });
  });

  it('parses persisted marketplace sources with curated origin metadata', () => {
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
    expect((source as any).futureSourceFlag).toBe('keep-me');
    expect(MarketplaceSourceOriginV1Schema.parse('user')).toBe('user');
  });

  it('preserves additive fields on marketplace source registries', () => {
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
    expect((parsed as any).futureRegistryFlag).toBe('keep-me');
    expect((parsed.sources[0] as any).futureSourceFlag).toBe('keep-me');
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
