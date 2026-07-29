import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTransparentPetSpritesheetPng } from '../testkit/petTestImages';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-import-'));
  createdRoots.add(root);
  return root;
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function writePetPackage(packagePath: string, options: Readonly<{
  id?: string;
  spritesheetPath?: string;
  spritesheetBytes?: Buffer;
}> = {}): Promise<Buffer> {
  const spritesheetPath = options.spritesheetPath ?? 'spritesheet.png';
  const spritesheet = options.spritesheetBytes ?? createTransparentPetSpritesheetPng();
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
    id: options.id ?? 'blink',
    displayName: options.id ?? 'Blink',
    description: 'Happier companion pet',
    spritesheetPath,
  }));
  await mkdir(dirname(join(packagePath, spritesheetPath)), { recursive: true });
  await writeFile(join(packagePath, spritesheetPath), spritesheet);
  return spritesheet;
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

async function loadImportModule() {
  const modulePath = './importPetPackage';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  if (!mod) throw new Error('expected importPetPackage module');
  return mod;
}

describe('importPetPackage', () => {
  it('copies a validated package into managed local storage without requiring pets sync', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    await writePetPackage(packagePath);

    const mod = await loadImportModule();
    const result = await mod.importPetPackage({
      target: 'local',
      packagePath,
      managedRoot,
      petsSyncEnabled: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected local import to succeed');
    expect(result.target).toBe('local');
    expect(result.source.kind).toBe('happierManagedLocal');
    await expect(readFile(join(result.source.packagePath, 'pet.json'), 'utf8')).resolves.toContain('"id":"blink"');
    await expect(readFile(join(result.source.packagePath, 'spritesheet.png'))).resolves.toBeInstanceOf(Buffer);
  });

  it('writes a durable managed local registry entry for imported packages', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    await writePetPackage(packagePath);

    const mod = await loadImportModule();
    const result = await mod.importPetPackage({
      target: 'local',
      packagePath,
      managedRoot,
      petsSyncEnabled: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected local import to succeed');
    const registryText = await readFile(
      join(managedRoot, '.managed-local-pet-registry-v1.json'),
      'utf8',
    ).catch(() => '');
    expect(registryText).toContain(result.source.sourceKey);
    expect(registryText).toContain(result.source.packagePath);
  });

  it('forgets imported managed local packages', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    await writePetPackage(packagePath);

    const mod = await loadImportModule();
    const result = await mod.importPetPackage({
      target: 'local',
      packagePath,
      managedRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected local import to succeed');
    expect(typeof mod.forgetManagedLocalPetSource).toBe('function');

    const forgotten = await mod.forgetManagedLocalPetSource({
      sourceKey: result.source.sourceKey,
      managedRoot,
    });

    expect(forgotten).toEqual({
      ok: true,
      sourceKey: result.source.sourceKey,
    });
    await expect(stat(result.source.packagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const registryText = await readFile(
      join(managedRoot, '.managed-local-pet-registry-v1.json'),
      'utf8',
    );
    expect(registryText).not.toContain(result.source.sourceKey);
  });

  it('rejects noncanonical nested spritesheet paths before importing into managed local storage', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    await writePetPackage(packagePath, { spritesheetPath: 'assets/spritesheet.png' });

    const mod = await loadImportModule();
    const result = await mod.importPetPackage({
      target: 'local',
      packagePath,
      managedRoot,
      petsSyncEnabled: false,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'validation_failed',
      validation: {
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'manifest_invalid_shape' }),
        ]),
      },
    });
    await expect(readdir(managedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed for account imports when pets sync is disabled', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    await writePetPackage(packagePath);

    const mod = await loadImportModule();
    const result = await mod.importPetPackage({
      target: 'account',
      packagePath,
      managedRoot,
      petsSyncEnabled: false,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'feature_disabled',
    });
  });

  it('uses injected account upload when pets sync is enabled', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const spritesheet = await writePetPackage(packagePath);

    const requests: unknown[] = [];
    const mod = await loadImportModule();
    const result = await mod.importPetPackage({
      target: 'account',
      packagePath,
      petsSyncEnabled: true,
      createAccountPet: async (request: unknown) => {
        requests.push(request);
        return {
          ok: true,
          pet: {
            accountPetId: 'pet_account_1',
            packageFormat: 'codex-compatible-atlas-v1',
            manifest: {
              id: 'blink',
              displayName: 'Blink',
              description: 'Happier companion pet',
              spritesheetPath: 'spritesheet.png',
            },
            spritesheetAssetRef: {
              assetId: 'asset_1',
              mediaType: 'image/png',
              digest: 'sha256:asset',
              sizeBytes: spritesheet.byteLength,
            },
            digest: 'sha256:package',
            sizeBytes: spritesheet.byteLength,
            createdAt: 1,
            updatedAt: 1,
            origin: { kind: 'manualImport' },
          },
        };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      target: 'account',
      account: { ok: true },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      manifest: { id: 'blink' },
      spritesheet: {
        mediaType: 'image/png',
        encoding: 'base64',
        sizeBytes: spritesheet.byteLength,
        digest: digest(spritesheet),
      },
      origin: { kind: 'manualImport' },
    });
  });

  it('returns top-level failure when the account upload is rejected', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    await writePetPackage(packagePath);

    const mod = await loadImportModule();
    const result = await mod.importPetPackage({
      target: 'account',
      packagePath,
      petsSyncEnabled: true,
      createAccountPet: async () => ({
        ok: false,
        errorCode: 'quota_exceeded',
        error: 'quota_exceeded',
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'quota_exceeded',
    });
  });

  it('rejects local imports before copying when the device pet count quota is exhausted', async () => {
    const root = tempRoot();
    const firstPackagePath = join(root, 'codex-home', 'pets', 'blink');
    const secondPackagePath = join(root, 'codex-home', 'pets', 'milo');
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    await writePetPackage(firstPackagePath);
    await writePetPackage(secondPackagePath, { id: 'milo' });

    const mod = await loadImportModule();
    const first = await mod.importPetPackage({
      target: 'local',
      packagePath: firstPackagePath,
      managedRoot,
      maxImportedPetsPerDevice: 1,
    });
    expect(first.ok).toBe(true);
    const managedEntriesBeforeRejectedImport = await readdir(managedRoot);

    const second = await mod.importPetPackage({
      target: 'local',
      packagePath: secondPackagePath,
      managedRoot,
      maxImportedPetsPerDevice: 1,
    });

    expect(second).toMatchObject({
      ok: false,
      errorCode: 'quota_exceeded',
    });
    await expect(readdir(managedRoot)).resolves.toEqual(managedEntriesBeforeRejectedImport);
  });

  it('rejects local imports before copying when the device imported byte quota would be exceeded', async () => {
    const root = tempRoot();
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    const packagePath = join(root, 'codex-home', 'pets', 'milo');
    const spritesheet = await writePetPackage(packagePath, { id: 'milo' });

    const mod = await loadImportModule();
    const result = await mod.importPetPackage({
      target: 'local',
      packagePath,
      managedRoot,
      maxImportedPetBytesPerDevice: spritesheet.byteLength - 1,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'quota_exceeded',
    });
    await expect(readdir(managedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up copied local packages when the managed registry write fails', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const managedRoot = join(root, 'happier-home', 'pets', 'imports');
    await writePetPackage(packagePath);
    await mkdir(managedRoot, { recursive: true });
    await mkdir(join(managedRoot, '.managed-local-pet-registry-v1.json'));

    const mod = await loadImportModule();
    const result = await mod.importPetPackage({
      target: 'local',
      packagePath,
      managedRoot,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'internal_error',
    });
    await expect(readdir(managedRoot)).resolves.toEqual(['.managed-local-pet-registry-v1.json']);
  });
});
