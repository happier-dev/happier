import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFeatureDecision, type FeatureDecision } from '@happier-dev/protocol';

import { createTransparentPetSpritesheetPng } from '../testkit/petTestImages';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-rpc-import-'));
  createdRoots.add(root);
  return root;
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function petsSyncDecision(state: 'enabled' | 'disabled'): FeatureDecision {
  return createFeatureDecision({
    featureId: 'pets.sync',
    state,
    blockedBy: state === 'enabled' ? null : 'server',
    blockerCode: state === 'enabled' ? 'none' : 'feature_disabled',
    diagnostics: [],
    evaluatedAt: 1,
    scope: { scopeKind: 'runtime' },
  });
}

async function writePetPackage(packagePath: string): Promise<Buffer> {
  const spritesheet = createTransparentPetSpritesheetPng();
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
    id: 'blink',
    displayName: 'Blink',
    description: 'Happier companion pet',
    spritesheetPath: 'spritesheet.png',
  }));
  await writeFile(join(packagePath, 'spritesheet.png'), spritesheet);
  return spritesheet;
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

describe('handleImportAccountPetPackage', () => {
  it('refuses account upload when caller claims pets sync is enabled but daemon feature decision is disabled', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    await writePetPackage(packagePath);

    const requests: unknown[] = [];
    const deps = {
      resolvePetsSyncDecision: async () => petsSyncDecision('disabled'),
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
              sizeBytes: 1,
            },
            digest: 'sha256:package',
            sizeBytes: 1,
            createdAt: 1,
            updatedAt: 1,
            origin: { kind: 'manualImport' },
          },
        } as const;
      },
    };

    const { handleImportAccountPetPackage } = await import('./handleImportPetPackage');
    const result = await handleImportAccountPetPackage({
      packagePath,
      petsSyncEnabled: true,
    }, deps);

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'feature_disabled',
    });
    expect(requests).toHaveLength(0);
  });

  it('allows account upload when daemon feature decision enables pets sync without a caller flag', async () => {
    const root = tempRoot();
    const packagePath = join(root, 'codex-home', 'pets', 'blink');
    const spritesheet = await writePetPackage(packagePath);

    const requests: unknown[] = [];
    const deps = {
      resolvePetsSyncDecision: async () => petsSyncDecision('enabled'),
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
              digest: digest(spritesheet),
              sizeBytes: spritesheet.byteLength,
            },
            digest: 'sha256:package',
            sizeBytes: spritesheet.byteLength,
            createdAt: 1,
            updatedAt: 1,
            origin: { kind: 'manualImport' },
          },
        } as const;
      },
    };

    const { handleImportAccountPetPackage } = await import('./handleImportPetPackage');
    const result = await handleImportAccountPetPackage({ packagePath }, deps);

    expect(result).toMatchObject({
      ok: true,
      target: 'account',
      account: { ok: true, pet: { accountPetId: 'pet_account_1' } },
    });
    expect(requests).toHaveLength(1);
  });
});
