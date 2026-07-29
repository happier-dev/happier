import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPngPetAtlasBytes } from '../testkit/petTestImages';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-package-'));
  createdRoots.add(root);
  return root;
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

describe('validatePetPackage', () => {
  it('rejects safe child paths that are outside the canonical manifest asset contract', async () => {
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
    await writeFile(join(spritesheetDir, 'spritesheet.png'), createPngPetAtlasBytes());

    const modulePath = './validatePetPackage';
    const mod = await import(modulePath).catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected validatePetPackage module');

    const result = await mod.validatePetPackage({ packagePath });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected noncanonical spritesheet path to be rejected');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('manifest_invalid_shape');
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
    await writeFile(join(packagePath, 'spritesheet.png'), createPngPetAtlasBytes());
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

  it('honors an aborted validation signal before reading package bytes', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    await mkdir(packagePath, { recursive: true });
    await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.png',
    }));
    await writeFile(join(packagePath, 'spritesheet.png'), createPngPetAtlasBytes());

    const modulePath = './validatePetPackage';
    const mod = await import(modulePath).catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected validatePetPackage module');

    const controller = new AbortController();
    controller.abort();
    const result = await mod.validatePetPackage({ packagePath, signal: controller.signal });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected aborted package validation to fail');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('internal_error');
  });
});
