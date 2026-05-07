import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTransparentPetSpritesheetPng } from '../testkit/petPngFixture.testkit';

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

  it('returns sanitized validation results without absolute package paths', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    await writePetPackage(packagePath);
    const { handleValidatePetPackage } = await import('./handleValidatePetPackage');

    const result = await handleValidatePetPackage({
      packagePath,
      strict: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.validation.ok) throw new Error('expected sanitized validation to succeed');
    expect(result.validation.spritesheetPath).toBe('spritesheet.png');
    expect(JSON.stringify(result)).not.toContain(packagePath);
    expect(JSON.stringify(result)).not.toContain(root);
  });
});
