import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTransparentPetSpritesheetPng } from '../testkit/petTestImages';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-rpc-forget-'));
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

describe('handleForgetLocalPetPackage', () => {
  it('removes the managed package and clears the discovery cache entry', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    await writePetPackage(packagePath);

    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { handleImportLocalPetPackage } = await import('./handleImportPetPackage');
    const { handleForgetLocalPetPackage } = await import('./handleForgetLocalPetPackage');
    const discoveryCache = createPetPackageDiscoveryCache();

    const imported = await handleImportLocalPetPackage({ packagePath }, {
      discoveryCache,
      managedRoot,
    });
    if ('ok' in imported) throw new Error('expected import to succeed');
    expect(discoveryCache.get(imported.importedPet.sourceKey)).not.toBeNull();

    const forgotten = await handleForgetLocalPetPackage({
      sourceKey: imported.importedPet.sourceKey,
    }, {
      discoveryCache,
      managedRoot,
    });

    expect(forgotten).toEqual({
      ok: true,
      sourceKey: imported.importedPet.sourceKey,
    });
    expect(discoveryCache.get(imported.importedPet.sourceKey)).toBeNull();
  });
});
