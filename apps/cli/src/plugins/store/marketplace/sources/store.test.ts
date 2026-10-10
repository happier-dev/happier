import { mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createMarketplaceSourceV1, DEFAULT_CURATED_MARKETPLACE_SOURCE_URL } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import { createMarketplaceSourceRegistryStore } from './store';

describe('marketplace source registry store', () => {
  const tempDirs: string[] = [];
  let envScope: ReturnType<typeof createEnvKeyScope> | null = null;

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    envScope?.restore();
    envScope = null;
  });

  it('preserves every configured source and large valid source settings across restart', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-many-sources-'));
    tempDirs.push(happyHomeDir);
    const store = createMarketplaceSourceRegistryStore({ happyHomeDir });
    const current = await store.read();
    const sources = Array.from({ length: 70 }, (_, index) => createMarketplaceSourceV1({
      sourceUrl: `https://source-${index}.example/index.json?catalog=${'x'.repeat(3_000)}`,
      title: `Source ${index} ${'title'.repeat(200)}`, description: 'description'.repeat(300), enabled: true, origin: 'user',
    }));
    await store.write({ ...current, sources: [...current.sources, ...sources] });
    expect((await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources)
      .toEqual([...current.sources, ...sources]);
  });

  it('boots the canonical curated source and ignores an ambient legacy URL when the file does not exist', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-registry-'));
    tempDirs.push(happyHomeDir);
    envScope = createEnvKeyScope(['HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({
      HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: 'https://marketplace.example.test/catalog.json',
    });
    const store = createMarketplaceSourceRegistryStore({ happyHomeDir });

    await expect(store.read()).resolves.toEqual(expect.objectContaining({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [
        expect.objectContaining({
          id: expect.stringMatching(/^marketplace:[0-9a-f]{12}$/),
          title: 'Happier curated marketplace',
          sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
          enabled: true,
          origin: 'curated',
          description: 'Official curated source',
          addedAtMs: expect.any(Number),
          updatedAtMs: expect.any(Number),
        }),
      ],
    }));
    expect(JSON.parse(readFileSync(join(happyHomeDir, 'plugins', 'plugins', 'state', 'marketplace-source-registry.v1.json'), 'utf8'))).toMatchObject({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [
        {
          id: expect.stringMatching(/^marketplace:[0-9a-f]{12}$/),
          title: 'Happier curated marketplace',
          sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
          enabled: true,
          origin: 'curated',
          description: 'Official curated source',
        },
      ],
    });
  });

  it('accepts an explicit curated source URL at the store boundary without rewriting persisted registries', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-registry-'));
    tempDirs.push(happyHomeDir);

    const seeded = createMarketplaceSourceRegistryStore({
      happyHomeDir,
      curatedSourceUrl: 'https://seed.example.test/catalog.json',
    });
    await expect(seeded.read()).resolves.toMatchObject({
      sources: [expect.objectContaining({
        sourceUrl: 'https://seed.example.test/catalog.json',
        origin: 'curated',
      })],
    });

    const reopened = createMarketplaceSourceRegistryStore({
      happyHomeDir,
      curatedSourceUrl: 'https://replacement.example.test/catalog.json',
    });
    await expect(reopened.read()).resolves.toMatchObject({
      sources: [expect.objectContaining({
        sourceUrl: 'https://seed.example.test/catalog.json',
        origin: 'curated',
      })],
    });
    expect(readFileSync(join(happyHomeDir, 'plugins', 'plugins', 'state', 'marketplace-source-registry.v1.json'), 'utf8'))
      .not.toContain('replacement.example.test');
  });

  it('fails closed instead of activating a truncated or foreign persisted registry', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-registry-'));
    tempDirs.push(happyHomeDir);
    const stateDir = join(happyHomeDir, 'plugins', 'plugins', 'state');
    const registryPath = join(stateDir, 'marketplace-source-registry.v1.json');
    mkdirSync(stateDir, { recursive: true });
    const store = createMarketplaceSourceRegistryStore({
      happyHomeDir,
      curatedSourceUrl: 'https://marketplace.example.test/catalog.json',
    });

    writeFileSync(registryPath, JSON.stringify({
      schemaVersion: 1,
      sources: [{
        id: 'marketplace:truncated',
        title: 'Truncated',
        sourceUrl: 'https://truncated.example.test/catalog.json',
      }],
    }));
    await expect(store.read()).rejects.toThrow(/Invalid marketplace source registry file/u);
    const afterTruncatedRead = readFileSync(registryPath, 'utf8');
    expect(afterTruncatedRead).not.toContain('happier_marketplace_source_registry_v1');
    expect(JSON.parse(afterTruncatedRead)).toMatchObject({ schemaVersion: 1 });

    writeFileSync(registryPath, JSON.stringify({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [{
        id: 'marketplace:foreign',
        title: 'Foreign',
        sourceUrl: 'https://foreign.example.test/catalog.json',
        enabled: true,
        origin: 'user',
        futureAuthorityFlag: 'keep-me',
      }],
    }));
    await expect(store.read()).rejects.toThrow(/Invalid marketplace source registry file/u);
    expect(readFileSync(registryPath, 'utf8')).toContain('futureAuthorityFlag');
  });

  it('persists and resolves marketplace sources by id and URL', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-registry-'));
    tempDirs.push(happyHomeDir);
    const store = createMarketplaceSourceRegistryStore({
      happyHomeDir,
      curatedSourceUrl: 'https://marketplace.example.test/catalog.json',
    });

    const source = await store.upsertSource({
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      title: 'Example marketplace',
      origin: 'curated',
      enabled: true,
    });

    expect(source.id).toMatch(/^marketplace:[0-9a-f]{12}$/);
    expect(source.sourceUrl).toBe('https://marketplace.example.test/catalog.json');
    expect(source.origin).toBe('curated');

    const registryPath = join(happyHomeDir, 'plugins', 'plugins', 'state', 'marketplace-source-registry.v1.json');
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toMatchObject({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [
        {
          id: source.id,
          title: 'Example marketplace',
          sourceUrl: 'https://marketplace.example.test/catalog.json',
          enabled: true,
          origin: 'curated',
        },
      ],
    });

    await expect(store.resolveSourceReference(source.id)).resolves.toMatchObject({
      id: source.id,
      sourceUrl: 'https://marketplace.example.test/catalog.json',
    });
    await expect(store.resolveSourceReference('https://marketplace.example.test/catalog.json')).resolves.toMatchObject({
      id: source.id,
      sourceUrl: 'https://marketplace.example.test/catalog.json',
    });
    await expect(store.resolveSourceReference('https://unregistered.example.test/catalog.json')).resolves.toBeNull();
    await expect(store.resolvePreferredSource()).resolves.toMatchObject({
      id: source.id,
      sourceUrl: 'https://marketplace.example.test/catalog.json',
    });

    await expect(store.setSourceEnabled(source.id, false)).resolves.toMatchObject({
      id: source.id,
      enabled: false,
    });
    await expect(store.resolvePreferredSource()).resolves.toBeNull();

    await expect(store.removeSource(source.id)).resolves.toBe(true);
    await expect(store.read()).resolves.toEqual({
      t: 'happier_marketplace_source_registry_v1',
      schemaVersion: 1,
      sources: [],
    });
  });

  it('binds, rebinds, and unbinds a persisted source without storing credential material', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-registry-'));
    tempDirs.push(happyHomeDir);
    const store = createMarketplaceSourceRegistryStore({
      happyHomeDir,
      curatedSourceUrl: 'https://marketplace.example.test/catalog.json',
    });

    await expect(store.upsertSource({
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      registryProfileId: 'registry_one',
    })).resolves.toMatchObject({ registryProfileId: 'registry_one' });
    await expect(store.upsertSource({
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      registryProfileId: 'registry_two',
    })).resolves.toMatchObject({ registryProfileId: 'registry_two' });
    await expect(store.upsertSource({
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      registryProfileId: null,
    })).resolves.not.toHaveProperty('registryProfileId');

    const raw = readFileSync(join(happyHomeDir, 'plugins', 'plugins', 'state', 'marketplace-source-registry.v1.json'), 'utf8');
    expect(raw).not.toContain('Bearer');
    expect(raw).not.toContain('token');
  });

  it('serializes concurrent transactional updates so marketplace source changes are not lost', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-registry-'));
    tempDirs.push(happyHomeDir);
    const store = createMarketplaceSourceRegistryStore({
      happyHomeDir,
      curatedSourceUrl: 'https://marketplace.example.test/catalog.json',
    });

    await Promise.all([
      store.update(async (registry) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ...registry,
          sources: [
            ...registry.sources,
            createMarketplaceSourceV1({
              sourceUrl: 'https://marketplace.example.test/alpha.json',
              title: 'Alpha',
              origin: 'user',
              enabled: true,
            }),
          ],
        };
      }),
      store.update(async (registry) => ({
        ...registry,
        sources: [
          ...registry.sources,
          createMarketplaceSourceV1({
            sourceUrl: 'https://marketplace.example.test/beta.json',
            title: 'Beta',
            origin: 'user',
            enabled: true,
          }),
        ],
      })),
    ]);

    await expect(store.read()).resolves.toEqual(expect.objectContaining({
      sources: expect.arrayContaining([
        expect.objectContaining({ sourceUrl: 'https://marketplace.example.test/catalog.json' }),
        expect.objectContaining({ sourceUrl: 'https://marketplace.example.test/alpha.json' }),
        expect.objectContaining({ sourceUrl: 'https://marketplace.example.test/beta.json' }),
      ]),
    }));
  });

  it('rejects introducing or promoting a user-controlled source as curated', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-registry-'));
    tempDirs.push(happyHomeDir);
    const store = createMarketplaceSourceRegistryStore({
      happyHomeDir,
      curatedSourceUrl: 'https://marketplace.example.test/catalog.json',
    });

    await expect(store.upsertSource({
      sourceUrl: 'https://evil.example.test/catalog.json',
      title: 'Not curated',
      origin: 'curated',
    })).rejects.toThrow(/curated authority/u);

    const userSource = await store.upsertSource({
      sourceUrl: 'https://user.example.test/catalog.json',
      title: 'User source',
      origin: 'user',
    });
    const current = await store.read();
    await expect(store.write({
      ...current,
      sources: current.sources.map((source) => source.id === userSource.id ? { ...source, origin: 'curated' as const } : source),
    })).rejects.toThrow(/curated authority/u);
  });
});
