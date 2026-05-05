import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPngPetAtlasBytes } from '../testkit/petTestImages';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-discover-'));
  createdRoots.add(root);
  return root;
}

async function writePetPackage(packagePath: string, id: string): Promise<void> {
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, 'pet.json'), JSON.stringify({
    id,
    displayName: id,
    description: `${id} pet`,
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

async function loadDiscoverModule() {
  const modulePath = './discoverCodexPets';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  if (!mod) throw new Error('expected discoverCodexPets module');
  return mod;
}

describe('discoverCodexPets', () => {
  it('stops at the configured per-root pet budget and returns diagnostics', async () => {
    const root = tempRoot();
    const petsPath = join(root, 'codex-home', 'pets');
    await writePetPackage(join(petsPath, 'blink'), 'blink');
    await writePetPackage(join(petsPath, 'milo'), 'milo');

    const mod = await loadDiscoverModule();
    const result = await mod.discoverCodexPets({
      roots: [{
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: join(root, 'codex-home'),
        petsPath,
      }],
      maxPetsPerRoot: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.pets).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.diagnostics.map((item: { code: string }) => item.code)).toContain('pet_limit_exceeded');
  });

  it('stops when the discovery wallclock budget is exceeded', async () => {
    const root = tempRoot();
    const petsPath = join(root, 'codex-home', 'pets');
    await writePetPackage(join(petsPath, 'blink'), 'blink');
    await writePetPackage(join(petsPath, 'milo'), 'milo');

    let now = 0;
    const mod = await loadDiscoverModule();
    const result = await mod.discoverCodexPets({
      roots: [{
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: join(root, 'codex-home'),
        petsPath,
      }],
      maxPetsPerRoot: 10,
      maxDiscoveryWallClockMs: 5,
      nowMs: () => {
        now += 10;
        return now;
      },
    });

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.diagnostics.map((item: { code: string }) => item.code)).toContain('time_budget_exceeded');
  });

  it('does not wait for package validation beyond the remaining discovery budget', async () => {
    const root = tempRoot();
    const petsPath = join(root, 'codex-home', 'pets');
    await writePetPackage(join(petsPath, 'blink'), 'blink');

    const capturedSignal: { current: AbortSignal | null } = { current: null };
    const mod = await loadDiscoverModule();
    const result = await mod.discoverCodexPets({
      roots: [{
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: join(root, 'codex-home'),
        petsPath,
      }],
      maxPetsPerRoot: 10,
      maxDiscoveryWallClockMs: 1,
      nowMs: () => 0,
      validatePackage: async (validationInput: { packagePath: string; signal?: AbortSignal }) => {
        capturedSignal.current = validationInput.signal ?? null;
        return await new Promise((resolve) => {
          validationInput.signal?.addEventListener('abort', () => {
            resolve({ ok: false, issues: [{ code: 'internal_error', message: 'aborted' }] });
          }, { once: true });
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(result.pets).toHaveLength(0);
    expect(result.partial).toBe(true);
    expect(result.diagnostics.map((item: { code: string }) => item.code)).toContain('time_budget_exceeded');
    expect(capturedSignal.current?.aborted).toBe(true);
  });
});
