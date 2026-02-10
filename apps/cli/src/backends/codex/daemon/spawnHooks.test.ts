import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getCodexAcpDepStatusMock = vi.fn(async () => ({ installed: false, binPath: null }));
vi.mock('@/capabilities/deps/codexAcp', () => ({
  // Keep this `any` so TS doesn't complain about rest/spread mismatch.
  getCodexAcpDepStatus: (...args: any[]) => (getCodexAcpDepStatusMock as any)(...args),
}));

const ORIGINAL_ENV = {
  HAPPIER_CODEX_ACP_BIN: process.env.HAPPIER_CODEX_ACP_BIN,
  HAPPIER_CODEX_ACP_NPX_MODE: process.env.HAPPIER_CODEX_ACP_NPX_MODE,
  PATH: process.env.PATH,
};

const tempDirs = new Set<string>();

async function createFakeBin(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-codex-spawnhooks-'));
  tempDirs.add(dir);
  const bin = join(dir, name);
  await writeFile(bin, '#!/bin/sh\necho ok\n', 'utf8');
  await chmod(bin, 0o755);
  return dir;
}

afterEach(async () => {
  getCodexAcpDepStatusMock.mockClear();
  if (ORIGINAL_ENV.HAPPIER_CODEX_ACP_BIN === undefined) delete process.env.HAPPIER_CODEX_ACP_BIN;
  else process.env.HAPPIER_CODEX_ACP_BIN = ORIGINAL_ENV.HAPPIER_CODEX_ACP_BIN;
  if (ORIGINAL_ENV.HAPPIER_CODEX_ACP_NPX_MODE === undefined) delete process.env.HAPPIER_CODEX_ACP_NPX_MODE;
  else process.env.HAPPIER_CODEX_ACP_NPX_MODE = ORIGINAL_ENV.HAPPIER_CODEX_ACP_NPX_MODE;
  if (ORIGINAL_ENV.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_ENV.PATH;
  vi.resetModules();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('codexDaemonSpawnHooks.validateSpawn', () => {
  it('allows ACP spawn when codex-acp is not installed but npx is available (npx mode auto)', async () => {
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    delete process.env.HAPPIER_CODEX_ACP_NPX_MODE;

    const pathDir = await createFakeBin('npx');
    process.env.PATH = pathDir;

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
      experimentalCodexResume: false,
    } as any);
    expect(res.ok).toBe(true);
  });

  it('rejects ACP spawn when npx mode is never and codex-acp is not installed', async () => {
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    process.env.HAPPIER_CODEX_ACP_NPX_MODE = 'never';

    const pathDir = await mkdtemp(join(tmpdir(), 'happier-codex-spawnhooks-empty-'));
    tempDirs.add(pathDir);
    process.env.PATH = pathDir;

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
      experimentalCodexResume: false,
    } as any);
    expect(res.ok).toBe(false);
  });
});
