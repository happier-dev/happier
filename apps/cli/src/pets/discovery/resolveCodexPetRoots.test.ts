import { mkdir } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const createdRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'happier-pets-roots-'));
  createdRoots.add(root);
  return root;
}

afterEach(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  createdRoots.clear();
});

async function loadRootsModule() {
  const modulePath = './resolveCodexPetRoots';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  if (!mod) throw new Error('expected resolveCodexPetRoots module');
  return mod;
}

describe('resolveCodexPetRoots', () => {
  it('reuses the configured Codex home and connected-service home layout', async () => {
    const root = tempRoot();
    const userCodexHome = join(root, 'codex-home');
    const activeServerDir = join(root, 'active-server');
    const connectedCodexHome = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      'work',
      'codex',
      'codex-home',
    );
    await mkdir(join(userCodexHome, 'pets'), { recursive: true });
    await mkdir(join(connectedCodexHome, 'pets'), { recursive: true });

    const mod = await loadRootsModule();
    const roots = await mod.resolveCodexPetRoots({
      env: { CODEX_HOME: userCodexHome, HOME: root },
      activeServerDir,
      includeUserCodexHome: true,
      includeConnectedServiceCodexHomes: true,
    });

    expect(roots.map((entry: { homeKind: string; petsPath: string }) => ({
      homeKind: entry.homeKind,
      petsPath: entry.petsPath,
    }))).toEqual([
      { homeKind: 'user', petsPath: join(userCodexHome, 'pets') },
      { homeKind: 'connectedService', petsPath: join(connectedCodexHome, 'pets') },
    ]);
  });

  it('caps connected-service Codex home roots across profiles', async () => {
    const root = tempRoot();
    const activeServerDir = join(root, 'active-server');
    const firstCodexHome = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      'work-a',
      'codex',
      'codex-home',
    );
    const secondCodexHome = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      'work-b',
      'codex',
      'codex-home',
    );
    await mkdir(join(firstCodexHome, 'pets'), { recursive: true });
    await mkdir(join(secondCodexHome, 'pets'), { recursive: true });

    const mod = await loadRootsModule();
    const result = await mod.resolveCodexPetRootsWithDiagnostics({
      env: { HOME: root },
      activeServerDir,
      includeUserCodexHome: false,
      includeConnectedServiceCodexHomes: true,
      maxConnectedServiceRoots: 1,
    });

    expect(result.roots).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.diagnostics.map((item: { code: string }) => item.code)).toContain('root_limit_exceeded');
  });
});
