import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTransparentPetSpritesheetPng } from '../testkit/petTestImages';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-rpc-validate-'));
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

describe('handleValidatePetPackage', () => {
  it('enforces pets.companion before validating caller supplied paths', async () => {
    const { handleValidatePetPackage } = await import('./handleValidatePetPackage');

    const result = await handleValidatePetPackage({ packagePath: '/tmp/not-validated' }, {
      companionFeatureEnabled: false,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'feature_disabled',
      error: 'pets.companion is disabled.',
    });
  });

  it('rate limits validate requests through the pet RPC limiter', async () => {
    const { handleValidatePetPackage } = await import('./handleValidatePetPackage');

    const result = await handleValidatePetPackage({ packagePath: '/tmp/not-validated' }, {
      rateLimiter: {
        tryConsume(operation) {
          expect(operation).toBe('validatePackage');
          return false;
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'rate_limited',
      error: 'Pet validation is rate limited.',
    });
  });

  it('returns a generated package preview handle without exposing absolute paths', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    await writePetPackage(packagePath);
    const { handleValidatePetPackage } = await import('./handleValidatePetPackage');
    const { createPetPackageDiscoveryCache } = await import('../discovery/petPackageDiscoveryCache');
    const { handleReadPetPreviewAsset } = await import('./handleReadPetAsset');
    const discoveryCache = createPetPackageDiscoveryCache();

    const result = await handleValidatePetPackage({
      packagePath,
      strict: true,
    }, { discoveryCache });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.validation.ok) throw new Error('expected sanitized validation to succeed');
    expect(result.validation.spritesheetPath).toBe('spritesheet.png');
    expect(JSON.stringify(result)).not.toContain(packagePath);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(result).toMatchObject({ previewHandle: { kind: 'daemonSourceKey', sourceKey: expect.any(String) } });
    if (!result.previewHandle) throw new Error('expected a generated package preview handle');
    const rechecked = await handleValidatePetPackage({ sourceKey: result.previewHandle.sourceKey, strict: true }, { discoveryCache });
    expect(rechecked).toMatchObject({ ok: true, validation: { ok: true }, previewHandle: result.previewHandle });
    const preview = await handleReadPetPreviewAsset({ sourceKey: result.previewHandle.sourceKey }, { discoveryCache });
    expect(preview).toMatchObject({ mediaType: 'image/png', dataBase64: expect.any(String) });
    expect('dataBase64' in preview && Buffer.from(preview.dataBase64, 'base64').equals(createTransparentPetSpritesheetPng())).toBe(true);
    expect(JSON.stringify(preview)).not.toContain(root);
  });
});
