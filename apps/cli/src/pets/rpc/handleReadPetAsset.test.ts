import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTransparentPetSpritesheetPng } from '../testkit/petPngFixture.testkit';

const managedRegistryFileName = '.managed-local-pet-registry-v1.json';
const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-rpc-read-'));
  createdRoots.add(root);
  return root;
}

async function writePetPackage(packagePath: string): Promise<void> {
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
    id: 'blink',
    displayName: 'Blink',
    description: 'Happier companion pet',
    spritesheetPath: 'spritesheet.png',
  }));
  await writeFile(join(packagePath, 'spritesheet.png'), createTransparentPetSpritesheetPng());
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

describe('handleReadPetPreviewAsset', () => {
  it('rejects preview requests with client supplied source paths', async () => {
    const root = tempRoot();
    const codexHome = join(root, 'codex-home');
    const packagePath = join(codexHome, 'pets', 'blink');
    await writePetPackage(packagePath);

    const { createPetSourceKey } = await import('../discovery/createPetSourceKey');
    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const sourceKey = createPetSourceKey(['detectedCodexHome', 'user', packagePath]);
    const preview = await handleReadPetPreviewAsset({
      source: {
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: codexHome,
        packagePath,
        sourceKey,
      },
    });

    expect(preview).toMatchObject({
      ok: false,
      errorCode: 'invalid_request',
    });
  });

  it('reads detected Codex pets by source key from the discovery cache', async () => {
    const root = tempRoot();
    const codexHome = join(root, 'codex-home');
    const packagePath = join(codexHome, 'pets', 'blink');
    await writePetPackage(packagePath);

    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { createPetSourceKey } = await import('../discovery/createPetSourceKey');
    const { validatePetPackage } = await import('../validation/validatePetPackage');
    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const validation = await validatePetPackage({ packagePath });
    if (!validation.ok) throw new Error('expected test package to validate');
    const sourceKey = createPetSourceKey(['detectedCodexHome', 'user', packagePath, validation.digest]);
    const discoveryCache = createPetPackageDiscoveryCache();
    discoveryCache.remember([{
      sourceKey,
      petId: validation.manifest.id,
      displayName: validation.manifest.displayName,
      packageFormat: validation.packageFormat,
      manifest: validation.manifest,
      source: {
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: codexHome,
        packagePath,
        sourceKey,
      },
      packagePath,
      spritesheetPath: validation.spritesheetPath,
      mediaType: validation.mediaType,
      digest: validation.digest,
      sizeBytes: validation.sizeBytes,
    }]);

    const preview = await handleReadPetPreviewAsset({ sourceKey }, { discoveryCache });

    expect(preview).toMatchObject({
      sourceKey,
      mediaType: 'image/png',
      digest: validation.digest,
      dataBase64: expect.any(String),
    });
  });

  it('rejects detected preview requests after the cache entry expires', async () => {
    const root = tempRoot();
    const codexHome = join(root, 'codex-home');
    const packagePath = join(codexHome, 'pets', 'blink');
    await writePetPackage(packagePath);

    let nowMs = 1_000;
    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { createPetSourceKey } = await import('../discovery/createPetSourceKey');
    const { validatePetPackage } = await import('../validation/validatePetPackage');
    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const validation = await validatePetPackage({ packagePath });
    if (!validation.ok) throw new Error('expected test package to validate');
    const sourceKey = createPetSourceKey(['detectedCodexHome', 'user', packagePath, validation.digest]);
    const discoveryCache = createPetPackageDiscoveryCache({ ttlMs: 25, nowMs: () => nowMs });
    discoveryCache.remember([{
      sourceKey,
      petId: validation.manifest.id,
      displayName: validation.manifest.displayName,
      packageFormat: validation.packageFormat,
      manifest: validation.manifest,
      source: {
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: codexHome,
        packagePath,
        sourceKey,
      },
      packagePath,
      spritesheetPath: validation.spritesheetPath,
      mediaType: validation.mediaType,
      digest: validation.digest,
      sizeBytes: validation.sizeBytes,
    }]);

    nowMs += 50;
    const preview = await handleReadPetPreviewAsset({ sourceKey }, { discoveryCache });

    expect(preview).toMatchObject({
      ok: false,
      errorCode: 'not_found',
    });
  });

  it('rejects detected preview requests after discovery cache eviction', async () => {
    const root = tempRoot();
    const codexHome = join(root, 'codex-home');
    const packagePath = join(codexHome, 'pets', 'blink');
    await writePetPackage(packagePath);

    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { createPetSourceKey } = await import('../discovery/createPetSourceKey');
    const { validatePetPackage } = await import('../validation/validatePetPackage');
    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const validation = await validatePetPackage({ packagePath });
    if (!validation.ok) throw new Error('expected test package to validate');
    const sourceKey = createPetSourceKey(['detectedCodexHome', 'user', packagePath, validation.digest]);
    const discoveryCache = createPetPackageDiscoveryCache();
    discoveryCache.remember([{
      sourceKey,
      petId: validation.manifest.id,
      displayName: validation.manifest.displayName,
      packageFormat: validation.packageFormat,
      manifest: validation.manifest,
      source: {
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: codexHome,
        packagePath,
        sourceKey,
      },
      packagePath,
      spritesheetPath: validation.spritesheetPath,
      mediaType: validation.mediaType,
      digest: validation.digest,
      sizeBytes: validation.sizeBytes,
    }]);

    discoveryCache.drop();
    const preview = await handleReadPetPreviewAsset({ sourceKey }, { discoveryCache });

    expect(preview).toMatchObject({
      ok: false,
      errorCode: 'not_found',
    });
  });

  it('reads imported local pets by source key from a fresh discovery cache', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    await writePetPackage(packagePath);

    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { createPetSourceKey } = await import('../discovery/createPetSourceKey');
    const { validatePetPackage } = await import('../validation/validatePetPackage');
    const { handleImportLocalPetPackage } = await import('./handleImportPetPackage');
    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const importCache = createPetPackageDiscoveryCache();
    const validation = await validatePetPackage({ packagePath });
    if (!validation.ok) throw new Error('expected test package to validate');
    const sourceKey = createPetSourceKey(['detectedCodexHome', 'user', packagePath, validation.digest]);
    importCache.remember([{
      sourceKey,
      petId: validation.manifest.id,
      displayName: validation.manifest.displayName,
      packageFormat: validation.packageFormat,
      manifest: validation.manifest,
      source: {
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: join(root, 'codex-home'),
        packagePath,
        sourceKey,
      },
      packagePath,
      spritesheetPath: validation.spritesheetPath,
      mediaType: validation.mediaType,
      digest: validation.digest,
      sizeBytes: validation.sizeBytes,
    }]);
    const imported = await handleImportLocalPetPackage({ sourceKey }, {
      discoveryCache: importCache,
      managedRoot,
    });

    if ('ok' in imported) throw new Error('expected import to succeed');
    const preview = await handleReadPetPreviewAsset({
      sourceKey: imported.importedPet.sourceKey,
    }, {
      discoveryCache: createPetPackageDiscoveryCache(),
      managedRoot,
    });

    expect(preview).toMatchObject({
      sourceKey: imported.importedPet.sourceKey,
      mediaType: 'image/png',
      digest: imported.importedPet.digest,
      dataBase64: expect.any(String),
    });
  });

  it('rejects managed registry entries that point outside the managed import root', async () => {
    const root = tempRoot();
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    const outsidePackagePath = join(root, 'outside-pets', 'blink');
    await writePetPackage(outsidePackagePath);
    await mkdir(managedRoot, { recursive: true });

    const { createPetSourceKey } = await import('../discovery/createPetSourceKey');
    const { validatePetPackage } = await import('../validation/validatePetPackage');
    const validation = await validatePetPackage({ packagePath: outsidePackagePath });
    if (!validation.ok) throw new Error('expected test package to validate');
    const sourceKey = createPetSourceKey(['happierManagedLocal', outsidePackagePath, validation.digest]);
    await writeFile(join(managedRoot, managedRegistryFileName), JSON.stringify({
      version: 1,
      pets: {
        [sourceKey]: {
          kind: 'happierManagedLocal',
          sourceKey,
          packagePath: outsidePackagePath,
        },
      },
    }));

    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const preview = await handleReadPetPreviewAsset({ sourceKey }, { managedRoot });

    expect(preview).toMatchObject({
      ok: false,
      errorCode: 'unsupported_source',
    });
  });

  it('does not trust detected Codex registry entries as durable local imports', async () => {
    const root = tempRoot();
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    const codexHome = join(root, 'codex-home');
    const packagePath = join(codexHome, 'pets', 'blink');
    await writePetPackage(packagePath);
    await mkdir(managedRoot, { recursive: true });

    const { createPetSourceKey } = await import('../discovery/createPetSourceKey');
    const { validatePetPackage } = await import('../validation/validatePetPackage');
    const validation = await validatePetPackage({ packagePath });
    if (!validation.ok) throw new Error('expected test package to validate');
    const sourceKey = createPetSourceKey(['detectedCodexHome', 'user', packagePath, validation.digest]);
    await writeFile(join(managedRoot, managedRegistryFileName), JSON.stringify({
      version: 1,
      pets: {
        [sourceKey]: {
          kind: 'detectedCodexHome',
          homeKind: 'user',
          homePath: codexHome,
          sourceKey,
          packagePath,
        },
      },
    }));

    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const preview = await handleReadPetPreviewAsset({ sourceKey }, { managedRoot });

    expect(preview).toMatchObject({
      ok: false,
      errorCode: 'unsupported_source',
    });
  });
});
