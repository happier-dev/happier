import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-rpc-'));
  createdRoots.add(root);
  return root;
}

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function webpHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
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
  await writeFile(join(packagePath, 'spritesheet.png'), pngHeader(1536, 1872));
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
  await writeFile(join(packagePath, 'spritesheet.png'), pngHeader(1536, 1872));
}

async function transparentPetAtlasWebp(): Promise<Buffer> {
  const { PET_ANIMATION_ROWS_V1, PET_ATLAS_V1 } = await import('@happier-dev/protocol');
  const sharp = (await import('sharp')).default;
  const raw = Buffer.alloc(PET_ATLAS_V1.width * PET_ATLAS_V1.height * 4);
  for (const row of PET_ANIMATION_ROWS_V1) {
    for (let frame = 0; frame < row.frames; frame += 1) {
      const x = frame * PET_ATLAS_V1.cellWidth + Math.floor(PET_ATLAS_V1.cellWidth / 2);
      const y = row.row * PET_ATLAS_V1.cellHeight + Math.floor(PET_ATLAS_V1.cellHeight / 2);
      const offset = (y * PET_ATLAS_V1.width + x) * 4;
      raw[offset] = 255;
      raw[offset + 1] = 255;
      raw[offset + 2] = 255;
      raw[offset + 3] = 255;
    }
  }
  return sharp(raw, {
    raw: {
      width: PET_ATLAS_V1.width,
      height: PET_ATLAS_V1.height,
      channels: 4,
    },
  }).webp().toBuffer();
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
        petId: 'blink',
        displayName: 'Blink',
        manifest: expect.objectContaining({ id: 'blink' }),
        kind: 'happierManagedLocal',
      }),
    ]);
  });

  it('supports core e2e discover, import local, forget local, and preview asset RPC shapes', async () => {
    const root = tempRoot();
    const codexHome = join(root, 'codex-home');
    const packagePath = join(codexHome, 'pets', 'blink');
    const happyHomeDir = join(root, 'happier-home');
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.webp',
    }));
    await writeFile(join(packagePath, 'spritesheet.webp'), await transparentPetAtlasWebp());

    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { handleImportLocalPetPackage } = await import('./handleImportPetPackage');
    const forgetModule = await import('./handleForgetLocalPetPackage').catch(() => null);
    expect(forgetModule).not.toBeNull();
    if (!forgetModule) throw new Error('expected handleForgetLocalPetPackage module');
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
      petId: 'blink',
      displayName: 'Blink',
      kind: 'detectedCodexHome',
    });
    expect(JSON.stringify(detected)).not.toContain(packagePath);
    expect(JSON.stringify(detected)).not.toContain(codexHome);

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
        kind: 'happierManagedLocal',
      },
    });
    expect(JSON.stringify(imported)).not.toContain('packagePath');

    if ('ok' in imported) throw new Error('expected import to succeed');
    const preview = await handleReadPetPreviewAsset({
      sourceKey: imported.importedPet.sourceKey,
    }, { discoveryCache });

    expect(preview).toMatchObject({
      sourceKey: imported.importedPet.sourceKey,
      mediaType: 'image/webp',
      digest: imported.importedPet.digest,
      dataBase64: expect.any(String),
    });

    const forgotten = await forgetModule.handleForgetLocalPetPackage({
      sourceKey: imported.importedPet.sourceKey,
    }, {
      discoveryCache,
      managedRoot: join(happyHomeDir, 'pets', 'imports'),
    });

    expect(forgotten).toEqual({
      ok: true,
      sourceKey: imported.importedPet.sourceKey,
    });

    const rescan = await mod.handleDiscoverPets({
      includeDetectedCodexHomes: false,
      includeManagedLocal: true,
      maxPetsPerRoot: 10,
    }, {
      activeServerDir: join(root, 'active-server'),
      env: { HOME: root, CODEX_HOME: codexHome },
      happyHomeDir,
      discoveryCache,
    });

    expect(rescan.ok).toBe(true);
    if (!rescan.ok) throw new Error('expected managed local rescan to succeed');
    expect(rescan.pets.filter((pet: { kind: string }) => pet.kind === 'happierManagedLocal')).toHaveLength(0);

    const previewAfterForget = await handleReadPetPreviewAsset({
      sourceKey: imported.importedPet.sourceKey,
    }, { discoveryCache, managedRoot: join(happyHomeDir, 'pets', 'imports') });
    expect(previewAfterForget).toMatchObject({
      ok: false,
      errorCode: 'not_found',
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
    await writeFile(join(packagePath, 'spritesheet.webp'), await transparentPetAtlasWebp());

    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { createPetSourceKey } = await import('../discovery/createPetSourceKey');
    const { validatePetPackage } = await import('../validation/validatePetPackage');
    const { handleImportLocalPetPackage } = await import('./handleImportPetPackage');
    const discoveryCache = createPetPackageDiscoveryCache();
    const validation = await validatePetPackage({ packagePath });
    if (!validation.ok) throw new Error('expected test package to validate');
    const sourceKey = createPetSourceKey(['detectedCodexHome', 'user', packagePath, validation.digest]);
    discoveryCache.remember([{
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

  it('rejects import requests that supply package paths instead of daemon source keys', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.webp',
    }));
    await writeFile(join(packagePath, 'spritesheet.webp'), await transparentPetAtlasWebp());

    const { handleImportLocalPetPackage } = await import('./handleImportPetPackage');
    const imported = await handleImportLocalPetPackage({ packagePath });

    expect(imported).toMatchObject({
      ok: false,
      errorCode: 'invalid_request',
    });
  });
});
