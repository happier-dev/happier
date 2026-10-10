import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

import {
  createCuratedMarketplaceSourceV1,
  createDefaultCuratedMarketplaceSourceRegistryV1,
  MarketplaceSourceOriginV1Schema,
  MarketplaceSourceRegistryV1Schema,
  MarketplaceSourceRegistryMutationV1Schema,
  MarketplaceSourceV1Schema,
  seedCuratedMarketplaceSourceRegistryV1,
  resolvePreferredMarketplaceSource,
  createMarketplaceSourceV1,
  deriveMarketplaceSourceId,
} from './marketplaceSourceRegistryV1.js';

const MARKETPLACE_BROWSER_EXPORTS = [
  'createMarketplaceSourceV1',
  'resolvePreferredMarketplaceSource',
  'MarketplaceIndexQueryResultV1Schema',
] as const;

const COMPLETE_PERSISTED_SOURCE = {
  id: 'marketplace:featured',
  title: 'Happier curated marketplace',
  sourceUrl: 'https://marketplace.example.test/catalog.json',
  enabled: true,
  origin: 'curated' as const,
  description: 'Official curated source',
  addedAtMs: 1,
  updatedAtMs: 2,
};

const COMPLETE_PERSISTED_REGISTRY = {
  t: 'happier_marketplace_source_registry_v1' as const,
  schemaVersion: 1 as const,
  sources: [COMPLETE_PERSISTED_SOURCE],
};

function omitKeys(value: Record<string, unknown>, ...keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

describe('marketplaceSourceRegistryV1 schemas', () => {
  it('preserves large valid source configuration through mutation and persisted schemas', () => {
    const source = { ...COMPLETE_PERSISTED_SOURCE,
      id: `marketplace:${'source'.repeat(100)}`,
      title: 'title'.repeat(200), description: 'description'.repeat(300),
      sourceUrl: `https://source.example/catalog.json?key=${'x'.repeat(3_000)}`,
    };
    expect(MarketplaceSourceV1Schema.parse(source)).toEqual(source);
    expect(MarketplaceSourceRegistryMutationV1Schema.parse({ kind: 'upsert', input: {
      sourceId: source.id, title: source.title, description: source.description, sourceUrl: source.sourceUrl,
    } })).toEqual({ kind: 'upsert', input: {
      sourceId: source.id, title: source.title, description: source.description, sourceUrl: source.sourceUrl,
    } });
  });
  it('parses only fine-grained source mutations', () => {
    expect(MarketplaceSourceRegistryMutationV1Schema.parse({
      kind: 'upsert',
      input: {
        sourceId: 'marketplace:user',
        sourceUrl: 'https://source.example/index.json',
        title: 'Source',
        origin: 'user',
      },
    })).toMatchObject({ kind: 'upsert', input: { sourceId: 'marketplace:user' } });
    expect(MarketplaceSourceRegistryMutationV1Schema.safeParse({
      kind: 'setEnabled', sourceId: 'marketplace:user', enabled: false,
    }).success).toBe(true);
    expect(MarketplaceSourceRegistryMutationV1Schema.safeParse({
      kind: 'setRegistryProfile', sourceId: 'marketplace:user', registryProfileId: null,
    }).success).toBe(true);
    expect(MarketplaceSourceRegistryMutationV1Schema.safeParse({
      kind: 'remove', sourceId: 'marketplace:user', registry: { sources: [] },
    }).success).toBe(false);
  });
  it('preserves every configured source beyond the former count limit', () => {
    const sources = Array.from({ length: 70 }, (_, index) => ({ id: `source-${index}`, title: `Source ${index}`, sourceUrl: `https://source-${index}.example/index.json`, enabled: true, origin: 'user' }));
    expect(MarketplaceSourceRegistryV1Schema.parse({ ...COMPLETE_PERSISTED_REGISTRY, sources }).sources).toEqual(sources);
  });

  it('requires the persisted root discriminator, schema version, and sources', () => {
    expect(MarketplaceSourceRegistryV1Schema.safeParse({}).success).toBe(false);
    expect(MarketplaceSourceRegistryV1Schema.safeParse(omitKeys(COMPLETE_PERSISTED_REGISTRY, 't')).success).toBe(false);
    expect(MarketplaceSourceRegistryV1Schema.safeParse(omitKeys(COMPLETE_PERSISTED_REGISTRY, 'schemaVersion')).success).toBe(false);
    expect(MarketplaceSourceRegistryV1Schema.safeParse(omitKeys(COMPLETE_PERSISTED_REGISTRY, 'sources')).success).toBe(false);
  });

  it('requires persisted source enabled and origin authority instead of defaulting it', () => {
    expect(MarketplaceSourceV1Schema.safeParse(omitKeys(COMPLETE_PERSISTED_SOURCE, 'enabled')).success).toBe(false);
    expect(MarketplaceSourceV1Schema.safeParse(omitKeys(COMPLETE_PERSISTED_SOURCE, 'origin')).success).toBe(false);
    expect(MarketplaceSourceRegistryV1Schema.safeParse({
      ...COMPLETE_PERSISTED_REGISTRY,
      sources: [omitKeys(COMPLETE_PERSISTED_SOURCE, 'enabled')],
    }).success).toBe(false);
    expect(MarketplaceSourceRegistryV1Schema.safeParse({
      ...COMPLETE_PERSISTED_REGISTRY,
      sources: [omitKeys(COMPLETE_PERSISTED_SOURCE, 'origin')],
    }).success).toBe(false);
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

    expect(MarketplaceSourceRegistryV1Schema.safeParse({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [legacy],
    }).success).toBe(true);

    expect(createMarketplaceSourceV1({
      sourceUrl: legacy.sourceUrl,
      registryProfileId: 'registry_private',
    }, legacy)).toMatchObject({ registryProfileId: 'registry_private' });
  });

  it('parses the complete persisted curated source projection with all authority fields', () => {
    expect(MarketplaceSourceV1Schema.parse({ ...COMPLETE_PERSISTED_SOURCE })).toEqual(COMPLETE_PERSISTED_SOURCE);
    expect(MarketplaceSourceOriginV1Schema.parse('user')).toBe('user');
  });

  it('rejects unknown persisted source and registry fields that could carry secrets or authority', () => {
    expect(MarketplaceSourceV1Schema.safeParse({ ...COMPLETE_PERSISTED_SOURCE, futureSourceFlag: 'keep-me' }).success).toBe(false);
    expect(MarketplaceSourceRegistryV1Schema.safeParse({
      ...COMPLETE_PERSISTED_REGISTRY,
      sources: [{ ...COMPLETE_PERSISTED_SOURCE, futureSourceFlag: 'keep-me' }],
    }).success).toBe(false);
    expect(MarketplaceSourceRegistryV1Schema.safeParse({
      ...COMPLETE_PERSISTED_REGISTRY,
      futureRegistryFlag: 'keep-me',
    }).success).toBe(false);
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

  it('retains the stable SHA-256 source identity used by persisted marketplace records', () => {
    expect(deriveMarketplaceSourceId('https://marketplace.example.test/catalog.json'))
      .toBe('marketplace:eb6d4c94505d');
  });

  it('bundles the public marketplace source projection without Node built-ins', async () => {
    const marketplaceEntry = resolve(import.meta.dirname, 'index.ts');
    const moduleIds = new Set<string>();
    const nodeImports = new Set<string>();
    const browserExternalImporters = new Set<string>();

    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [{
        name: 'marketplace-source-registry-browser-projection',
        resolveId(id, importer) {
          if (id.startsWith('node:')) {
            nodeImports.add(`${id} from ${importer ?? '<entry>'}`);
          }
          return id === 'virtual:marketplace-source-registry-browser-projection' ? `\0${id}` : null;
        },
        load(id) {
          if (id !== '\0virtual:marketplace-source-registry-browser-projection') return null;
          return `export { ${MARKETPLACE_BROWSER_EXPORTS.join(', ')} } from ${JSON.stringify(marketplaceEntry)};`;
        },
        generateBundle() {
          for (const id of this.getModuleIds()) {
            moduleIds.add(id);
            if (id.includes('__vite-browser-external')) {
              for (const importer of this.getModuleInfo(id)?.importers ?? []) {
                browserExternalImporters.add(importer);
              }
            }
          }
        },
      }],
      build: {
        minify: false,
        target: 'es2022',
        write: false,
        rollupOptions: {
          input: 'virtual:marketplace-source-registry-browser-projection',
          preserveEntrySignatures: 'strict',
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });

    expect({
      nodeImports: [...nodeImports],
      browserExternalImporters: [...browserExternalImporters],
      forbiddenModuleIds: [...moduleIds].filter((id) => id.startsWith('node:') || id.includes('__vite-browser-external')),
    }).toEqual({ nodeImports: [], browserExternalImporters: [], forbiddenModuleIds: [] });
  }, 60_000);

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
