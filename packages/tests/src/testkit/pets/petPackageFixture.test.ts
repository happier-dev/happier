import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRunDirs } from '../runDir';

import {
  createMinimalCodexPetPackage,
  digestPetFixtureBytes,
  minimalPetPngSignature,
  readMinimalAccountPetCreatePayload,
} from './petPackageFixture';

const run = createRunDirs({ runLabel: 'pets-fixture' });

function readPngDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, minimalPetPngSignature.length)).toEqual(minimalPetPngSignature);
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

describe('pet package fixture', () => {
  it('creates a tiny contract-valid Codex-compatible pet package', async () => {
    const rootDir = run.testDir('minimal-codex-pet-package');

    const fixture = await createMinimalCodexPetPackage({
      rootDir,
      petId: 'blink-e2e-fixture',
      displayName: 'Blink E2E Fixture',
    });

    const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest).toEqual({
      id: 'blink-e2e-fixture',
      displayName: 'Blink E2E Fixture',
      description: 'Minimal transparent pet package for Happier e2e tests.',
      spritesheetPath: 'spritesheet.png',
    });
    expect(basename(fixture.packageDir)).toBe('blink-e2e-fixture');

    const spritesheet = await readFile(fixture.spritesheetPath);
    expect(readPngDimensions(spritesheet)).toEqual({ width: 1536, height: 1872 });
    expect(spritesheet.length).toBeLessThan(64 * 1024);

    const accountPayload = await readMinimalAccountPetCreatePayload(fixture, {
      kind: 'detectedCodexHome',
      homeKind: 'user',
    });
    expect(accountPayload).toMatchObject({
      manifest,
      spritesheet: {
        mediaType: 'image/png',
        encoding: 'base64',
        sizeBytes: spritesheet.byteLength,
        digest: digestPetFixtureBytes(spritesheet),
      },
      origin: { kind: 'detectedCodexHome', homeKind: 'user' },
    });
    expect(Buffer.from(accountPayload.spritesheet.data, 'base64').subarray(0, minimalPetPngSignature.length)).toEqual(
      minimalPetPngSignature,
    );
  });
});
