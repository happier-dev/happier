import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPngPetAtlasBytes } from '../testkit/petTestImages';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-read-'));
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
  await writeFile(join(packagePath, 'spritesheet.png'), createPngPetAtlasBytes());
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

describe('readPetAsset', () => {
  it('rejects local managed sources with forged source keys', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'happier-home', 'pets', 'imports', 'blink');
    await writePetPackage(packagePath);

    const modulePath = './readPetAsset';
    const mod = await import(modulePath).catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected readPetAsset module');

    const result = await mod.readPetAsset({
      source: {
        kind: 'happierManagedLocal',
        packagePath,
        sourceKey: 'forged',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'unsupported_source',
    });
  });
});
