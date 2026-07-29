import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createMarketplaceSourceV1 } from '@happier-dev/protocol';

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

  it('boots a curated marketplace source when the file does not exist', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-registry-'));
    tempDirs.push(happyHomeDir);
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({
      HAPPIER_HOME_DIR: happyHomeDir,
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
          sourceUrl: 'https://marketplace.example.test/catalog.json',
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
          sourceUrl: 'https://marketplace.example.test/catalog.json',
          enabled: true,
          origin: 'curated',
          description: 'Official curated source',
        },
      ],
    });
  });

  it('persists and resolves marketplace sources by id and URL', async () => {
    const happyHomeDir = mkdtempSync(join(tmpdir(), 'happier-marketplace-registry-'));
    tempDirs.push(happyHomeDir);
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: 'https://marketplace.example.test/catalog.json',
    });
    const store = createMarketplaceSourceRegistryStore({ happyHomeDir });

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
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: 'https://marketplace.example.test/catalog.json',
    });
    const store = createMarketplaceSourceRegistryStore({ happyHomeDir });

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
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: 'https://marketplace.example.test/catalog.json',
    });
    const store = createMarketplaceSourceRegistryStore({ happyHomeDir });

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
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_MARKETPLACE_CURATED_SOURCE_URL']);
    envScope.patch({
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_MARKETPLACE_CURATED_SOURCE_URL: 'https://marketplace.example.test/catalog.json',
    });
    const store = createMarketplaceSourceRegistryStore({ happyHomeDir });

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
