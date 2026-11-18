import { mkdir, symlink } from 'node:fs/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_NATIVE_HOME } from '@happier-dev/protocol/agents/codex/native-home-policy';

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
  it('resolves the Protocol-owned native home without requiring an Agent runtime contribution', async () => {
    const root = tempRoot();
    const userCodexHome = join(root, CODEX_NATIVE_HOME.defaultRelativePath);
    await mkdir(join(userCodexHome, 'pets'), { recursive: true });

    const mod = await loadRootsModule();
    const roots = await mod.resolveCodexPetRoots({
      env: { HOME: root },
      includeUserCodexHome: true,
      includeConnectedServiceCodexHomes: false,
    });

    expect(roots.map((entry: { homeKind: string; petsPath: string }) => ({
      homeKind: entry.homeKind,
      petsPath: entry.petsPath,
    }))).toEqual([
      { homeKind: 'user', petsPath: join(userCodexHome, 'pets') },
    ]);
  });

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
    const serviceRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex');
    const groupHome = join(serviceRoot, '__groups', 'team', 'codex', 'codex-home');
    await mkdir(join(groupHome, 'pets'), { recursive: true });
    const escapedHome = join(root, 'escaped-codex');
    await mkdir(join(escapedHome, 'codex-home', 'pets'), { recursive: true });
    await mkdir(join(serviceRoot, 'escaped'), { recursive: true });
    await symlink(escapedHome, join(serviceRoot, 'escaped', 'codex'), process.platform === 'win32' ? 'junction' : 'dir');

    const mod = await loadRootsModule();
    const roots = await mod.resolveCodexPetRoots({
      env: { CODEX_HOME: userCodexHome, HOME: root },
      activeServerDir,
      includeUserCodexHome: true,
      includeConnectedServiceCodexHomes: true,
    });

    expect(roots.map((entry: { homeKind: string; petsPath: string }) => ({
      homeKind: entry.homeKind,
      petsPath: realpathSync(entry.petsPath),
    }))).toEqual([
      { homeKind: 'user', petsPath: realpathSync(join(userCodexHome, 'pets')) },
      { homeKind: 'connectedService', petsPath: realpathSync(join(connectedCodexHome, 'pets')) },
      { homeKind: 'connectedService', petsPath: realpathSync(join(groupHome, 'pets')) },
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
