import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-package-'));
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

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

describe('validatePetPackage', () => {
  it('rejects nested spritesheet paths so CLI and server imports share one policy', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const spritesheetDir = join(packagePath, '..sprites');
    await mkdir(spritesheetDir, { recursive: true });
    await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: '..sprites/spritesheet.png',
    }));
    await writeFile(join(spritesheetDir, 'spritesheet.png'), pngHeader(1536, 1872));

    const modulePath = './validatePetPackage';
    const mod = await import(modulePath).catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected validatePetPackage module');

    const result = await mod.validatePetPackage({ packagePath });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected nested spritesheet path to fail');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('spritesheet_path_unsafe');
  });

  it('rejects manifests that are symlinks escaping the package root', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const outside = join(root, 'outside');
    await mkdir(packagePath, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'pet.json'), JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.png',
    }));
    await writeFile(join(packagePath, 'spritesheet.png'), pngHeader(1536, 1872));
    await symlink(join(outside, 'pet.json'), join(packagePath, 'pet.json'));

    const modulePath = './validatePetPackage';
    const mod = await import(modulePath).catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected validatePetPackage module');

    const result = await mod.validatePetPackage({ packagePath });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected package validation to fail');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('symlink_escape');
  });

  it('stops before atlas decoding when validation is aborted', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.png',
    }));
    await writeFile(join(packagePath, 'spritesheet.png'), pngHeader(1536, 1872));

    const modulePath = './validatePetPackage';
    const mod = await import(modulePath).catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected validatePetPackage module');

    const controller = new AbortController();
    controller.abort();
    let decoderCalled = false;

    const result = await mod.validatePetPackage({
      packagePath,
      signal: controller.signal,
      decoder: () => {
        decoderCalled = true;
        return {
          mediaType: 'image/png',
          width: 1536,
          height: 1872,
        };
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected aborted package validation to fail');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('internal_error');
    expect(decoderCalled).toBe(false);
  });

  it('rejects packages that exceed the configured total package size cap', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.png',
    }));
    await writeFile(join(packagePath, 'spritesheet.png'), pngHeader(1536, 1872));

    const modulePath = './validatePetPackage';
    const mod = await import(modulePath).catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected validatePetPackage module');

    const result = await mod.validatePetPackage({
      packagePath,
      maxPackageBytes: 32,
      decoder: () => ({
        mediaType: 'image/png',
        width: 1536,
        height: 1872,
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected total package cap to fail');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('package_too_large');
  });
});
