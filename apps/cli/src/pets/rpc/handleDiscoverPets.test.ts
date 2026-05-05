import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPngPetAtlasBytes, createTransparentPetSpritesheetPng, createTransparentPetSpritesheetWebp } from '../testkit/petTestImages';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-rpc-'));
  createdRoots.add(root);
  return root;
}

async function writeConnectedServicePet(activeServerDir: string, serviceId: string, profileId: string): Promise<void> {
  const packagePath = join(
    activeServerDir,
    'daemon',
    'connected-services',
    'homes',
    serviceId,
    profileId,
    'codex',
    'codex-home',
    'pets',
    'blink',
  );
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
    id: `blink-${serviceId}`,
    displayName: 'Blink',
    description: 'Happier companion pet',
    spritesheetPath: 'spritesheet.png',
  }));
  await writeFile(join(packagePath, 'spritesheet.png'), createPngPetAtlasBytes());
}

async function writeManagedLocalPet(happyHomeDir: string): Promise<void> {
  const packagePath = join(happyHomeDir, 'pets', 'imports', 'blink');
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
    id: 'blink',
    displayName: 'Blink',
    description: 'Happier companion pet',
    spritesheetPath: 'spritesheet.png',
  }));
  await writeFile(join(packagePath, 'spritesheet.png'), createPngPetAtlasBytes());
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

async function loadRpcModule() {
  const modulePath = './handleDiscoverPets';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  if (!mod) throw new Error('expected handleDiscoverPets module');
  return mod;
}

function expectNoRawDiscoveryPathFields(pet: unknown): void {
  expect(pet).not.toHaveProperty('source');
  expect(pet).not.toHaveProperty('packagePath');
  expect(pet).not.toHaveProperty('homePath');
  expect(pet).not.toHaveProperty('spritesheetPath');
  expect(pet).not.toHaveProperty('rootPath');
}

function expectNoRawPathValues(value: unknown, rawPaths: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const rawPath of rawPaths) {
    expect(serialized).not.toContain(rawPath);
  }
}

describe('handleDiscoverPets', () => {
  it('returns invalid_request for malformed discover requests', async () => {
    const mod = await loadRpcModule();
    const result = await mod.handleDiscoverPets({ maxPetsPerRoot: 0 });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'invalid_request',
    });
  });

  it('returns diagnostics when connected-service root enumeration is capped', async () => {
    const root = tempRoot();
    const activeServerDir = join(root, 'active-server');
    await writeConnectedServicePet(activeServerDir, 'openai-codex-a', 'work');
    await writeConnectedServicePet(activeServerDir, 'openai-codex-b', 'work');

    const mod = await loadRpcModule();
    const result = await mod.handleDiscoverPets({
      includeUserCodexHome: false,
      includeConnectedServiceCodexHomes: true,
      maxRoots: 1,
      maxPetsPerRoot: 10,
    }, {
      activeServerDir,
      env: { HOME: root },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected discover to succeed with partial diagnostics');
    expect(result.partial).toBe(true);
    expect(result.diagnostics?.map((item: { code: string }) => item.code)).toContain('root_limit_exceeded');
    expect(JSON.stringify(result.diagnostics)).not.toContain('rootPath');
    expectNoRawPathValues(result.diagnostics, [activeServerDir]);
  });

  it('discovers daemon-managed local pet imports', async () => {
    const root = tempRoot();
    const happyHomeDir = join(root, 'happier-home');
    await writeManagedLocalPet(happyHomeDir);

    const mod = await loadRpcModule();
    const result = await mod.handleDiscoverPets({
      includeUserCodexHome: false,
      includeConnectedServiceCodexHomes: false,
      includeManagedLocal: true,
      maxPetsPerRoot: 10,
    }, {
      activeServerDir: join(root, 'active-server'),
      env: { HOME: root },
      happyHomeDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected discover to succeed');
    expect(result.pets).toEqual([
      expect.objectContaining({
        sourceKey: expect.any(String),
        kind: 'happierManagedLocal',
        petId: 'blink',
        displayName: 'Blink',
        manifest: expect.objectContaining({ id: 'blink' }),
        previewHandle: expect.objectContaining({
          kind: 'daemonSourceKey',
          sourceKey: expect.any(String),
        }),
      }),
    ]);
    expectNoRawDiscoveryPathFields(result.pets[0]);
    expect(result.pets[0]?.previewHandle).toMatchObject({
      kind: 'daemonSourceKey',
      sourceKey: result.pets[0]?.sourceKey,
    });
  });

  it('supports core e2e discover, import local, and preview asset RPC shapes', async () => {
    const root = tempRoot();
    const codexHome = join(root, 'codex-home');
    const packagePath = join(codexHome, 'pets', 'blink');
    const happyHomeDir = join(root, 'happier-home');
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.png',
    }));
    await writeFile(join(packagePath, 'spritesheet.png'), createTransparentPetSpritesheetPng());

    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { handleImportLocalPetPackage } = await import('./handleImportPetPackage');
    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const mod = await loadRpcModule();
    const discoveryCache = createPetPackageDiscoveryCache();

    const discover = await mod.handleDiscoverPets({
      includeDetectedCodexHomes: true,
      includeManagedLocal: false,
      maxPetsPerRoot: 10,
    }, {
      activeServerDir: join(root, 'active-server'),
      env: { HOME: root, CODEX_HOME: codexHome },
      happyHomeDir,
      discoveryCache,
    });

    expect(discover.ok).toBe(true);
    if (!discover.ok) throw new Error('expected discover to succeed');
    const detected = discover.pets[0];
    expect(detected).toMatchObject({
      sourceKey: expect.any(String),
      kind: 'detectedCodexHome',
      petId: 'blink',
      displayName: 'Blink',
      previewHandle: {
        kind: 'daemonSourceKey',
        sourceKey: detected.sourceKey,
      },
    });
    expectNoRawDiscoveryPathFields(detected);
    expectNoRawPathValues(detected, [
      codexHome,
      packagePath,
      join(packagePath, 'spritesheet.png'),
    ]);
    expect(discoveryCache.get(detected.sourceKey)).toMatchObject({
      packagePath,
      spritesheetPath: realpathSync(join(packagePath, 'spritesheet.png')),
      source: expect.objectContaining({
        kind: 'detectedCodexHome',
        homePath: codexHome,
        packagePath,
      }),
    });

    const imported = await handleImportLocalPetPackage({ sourceKey: detected.sourceKey }, {
      discoveryCache,
      managedRoot: join(happyHomeDir, 'pets', 'imports'),
    });
    expect(imported).toMatchObject({
      importedPet: {
        sourceKey: expect.any(String),
        petId: 'blink',
        displayName: 'Blink',
        digest: expect.stringMatching(/^sha256:/),
        source: expect.objectContaining({ kind: 'happierManagedLocal' }),
      },
    });

    if ('ok' in imported) throw new Error('expected import to succeed');
    const preview = await handleReadPetPreviewAsset({
      sourceKey: imported.importedPet.sourceKey,
    }, { discoveryCache });

    expect(preview).toMatchObject({
      sourceKey: imported.importedPet.sourceKey,
      mediaType: 'image/png',
      digest: imported.importedPet.digest,
      dataBase64: expect.any(String),
    });
  });

  it('remembers imported local packages with the validated WebP media type', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'milo');
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
      id: 'milo',
      displayName: 'Milo',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.webp',
    }));
    await writeFile(join(packagePath, 'spritesheet.webp'), await createTransparentPetSpritesheetWebp());

    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { handleImportLocalPetPackage } = await import('./handleImportPetPackage');
    const discoveryCache = createPetPackageDiscoveryCache();

    const imported = await handleImportLocalPetPackage({ packagePath }, {
      discoveryCache,
      managedRoot,
    });

    if ('ok' in imported) throw new Error('expected import to succeed');
    expect(imported.importedPet.mediaType).toBe('image/webp');
    expect(discoveryCache.get(imported.importedPet.sourceKey)?.mediaType).toBe('image/webp');
  });

  it('enforces pets.companion inside discover/import/forget/preview handlers', async () => {
    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { handleImportLocalPetPackage } = await import('./handleImportPetPackage');
    const { handleForgetLocalPetPackage } = await import('./handleForgetLocalPetPackage');
    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const mod = await loadRpcModule();
    const discoveryCache = createPetPackageDiscoveryCache();

    await expect(mod.handleDiscoverPets({}, { discoveryCache, companionFeatureEnabled: false })).resolves.toMatchObject({
      ok: false,
      errorCode: 'feature_disabled',
    });
    await expect(handleImportLocalPetPackage({ sourceKey: 'pet:0123456789abcdef0123456789abcdef' }, {
      discoveryCache,
      companionFeatureEnabled: false,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'feature_disabled',
    });
    await expect(handleForgetLocalPetPackage({ sourceKey: 'pet:0123456789abcdef0123456789abcdef' }, {
      discoveryCache,
      companionFeatureEnabled: false,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'feature_disabled',
    });
    await expect(handleReadPetPreviewAsset({ sourceKey: 'pet:0123456789abcdef0123456789abcdef' }, {
      discoveryCache,
      companionFeatureEnabled: false,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'feature_disabled',
    });
  });
});
