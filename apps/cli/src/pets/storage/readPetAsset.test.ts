import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTransparentPetSpritesheetPng,
  createTransparentPetSpritesheetWebp,
} from '../testkit/petPngFixture.testkit';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-read-'));
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

async function writePetPackage(packagePath: string): Promise<void> {
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
    id: 'blink',
    displayName: 'Blink',
    description: 'Happier companion pet',
    spritesheetPath: 'spritesheet.png',
  }));
  await writeFile(join(packagePath, 'spritesheet.png'), pngHeader(1536, 1872));
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
  vi.resetModules();
  vi.doUnmock('node:fs/promises');
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

  it('fails closed when the spritesheet changes between validation and the asset read', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'happier-home', 'pets', 'imports', 'blink');
    await mkdir(packagePath, { recursive: true });
    const manifestBytes = Buffer.from(JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.png',
    }));
    await writeFile(join(packagePath, 'pet.json'), manifestBytes);
    const validatedSpritesheet = createTransparentPetSpritesheetPng();
    const servedSpritesheet = await createTransparentPetSpritesheetWebp();
    const spritesheetPath = join(packagePath, 'spritesheet.png');
    await writeFile(spritesheetPath, validatedSpritesheet);

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let spritesheetStatCount = 0;
      return {
        ...actual,
        stat: vi.fn(async (path: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) => {
          const resolvedPath = String(path);
          if (/[\\/]spritesheet\.png$/u.test(resolvedPath)) {
            spritesheetStatCount += 1;
            if (spritesheetStatCount === 2) {
              await actual.writeFile(spritesheetPath, servedSpritesheet);
            }
          }
          return actual.stat(path, options as never);
        }),
      };
    });

    const { createPetSourceKey } = await import('../discovery/createPetSourceKey');
    const mod = await import('./readPetAsset').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected readPetAsset module');

    const validatedDigest = `sha256:${createHash('sha256')
      .update(manifestBytes)
      .update(validatedSpritesheet)
      .digest('hex')}`;
    const result = await mod.readPetAsset({
      source: {
        kind: 'happierManagedLocal',
        packagePath,
        sourceKey: createPetSourceKey(['happierManagedLocal', packagePath, validatedDigest]),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'unsupported_source',
    });
  });
});
