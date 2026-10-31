import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { installVersionedPayload } from '../../firstPartyRuntime/index.js';
import { CLI_UPDATE_CHECK_INTERVAL_MS, resolveCliUpdateCachePath, writeUpdateCache } from '../../update/index.js';
import { readLocalCliUpdateFact } from './cliUpdateFact.js';

async function installManagedCli(homeDir: string, versionId: string): Promise<void> {
  const payloadRoot = join(homeDir, `payload-${versionId}`);
  await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
  await writeFile(join(payloadRoot, process.platform === 'win32' ? 'happier.exe' : 'happier'), 'binary', 'utf8');
  await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');
  await installVersionedPayload({
    componentId: 'happier-cli',
    versionId,
    payloadRoot,
    processEnv: { ...process.env, HAPPIER_HOME_DIR: homeDir },
  });
}

describe('readLocalCliUpdateFact', () => {
  it('reports a newer channel release for the managed CLI from the cached update check, without refreshing a fresh cache', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-update-fact-'));
    const env: NodeJS.ProcessEnv = { HAPPIER_HOME_DIR: homeDir, HAPPIER_STACK_REPO_DIR: homeDir, PATH: process.env.PATH };
    try {
      await installManagedCli(homeDir, '0.3.0');
      const nowMs = 1_800_000_000_000;
      writeUpdateCache(resolveCliUpdateCachePath({ happierHomeDir: homeDir, channelLabel: 'stable' }), {
        checkedAt: nowMs - 1_000,
        latest: '0.3.2',
        current: '0.3.0',
        runtimeVersion: null,
        invokerVersion: null,
        updateAvailable: true,
        notifiedAt: null,
      });
      const refresh = vi.fn();

      expect(readLocalCliUpdateFact({ processEnv: env, nowMs, refresh })).toEqual({
        currentVersion: '0.3.0',
        latestVersion: '0.3.2',
        updateAvailable: true,
        managed: true,
      });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'stale'] as const)('starts the background check with a %s cache and preserves any last result', async (cacheState) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-update-fact-stale-'));
    const env: NodeJS.ProcessEnv = { HAPPIER_HOME_DIR: homeDir, HAPPIER_STACK_REPO_DIR: homeDir, PATH: process.env.PATH };
    try {
      await installManagedCli(homeDir, '0.3.1');
      const nowMs = 1_800_000_000_000;
      if (cacheState === 'stale') {
        writeUpdateCache(resolveCliUpdateCachePath({ happierHomeDir: homeDir, channelLabel: 'stable' }), {
          checkedAt: nowMs - CLI_UPDATE_CHECK_INTERVAL_MS - 1,
          latest: '0.3.2',
          current: '0.3.0',
          runtimeVersion: null,
          invokerVersion: null,
          updateAvailable: false,
          notifiedAt: null,
        });
      }
      const refresh = vi.fn();

      expect(readLocalCliUpdateFact({ processEnv: env, nowMs, refresh })).toEqual({
        currentVersion: '0.3.1',
        latestVersion: cacheState === 'stale' ? '0.3.2' : null,
        updateAvailable: cacheState === 'stale',
        managed: true,
      });
      expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ ring: 'stable', happierHomeDir: homeDir }));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('marks a CLI the install path did not place as not managed', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-update-fact-override-'));
    const cliPath = join(homeDir, 'dev-happier');
    await writeFile(cliPath, 'binary', 'utf8');
    const env: NodeJS.ProcessEnv = { HAPPIER_HOME_DIR: homeDir, HAPPIER_BOOTSTRAP_CLI_PATH: cliPath, PATH: process.env.PATH };
    try {
      writeUpdateCache(resolveCliUpdateCachePath({ happierHomeDir: homeDir, channelLabel: 'stable' }), {
        checkedAt: 1_800_000_000_000,
        latest: '0.3.2',
        current: '0.3.2',
        runtimeVersion: null,
        invokerVersion: null,
        updateAvailable: false,
        notifiedAt: null,
      });
      expect(readLocalCliUpdateFact({ processEnv: env, nowMs: 1_800_000_000_000, refresh: vi.fn() })).toEqual({
        currentVersion: '0.3.2',
        latestVersion: '0.3.2',
        updateAvailable: false,
        managed: false,
        // R17 (UI03-2): a CLI Happier did not install is named by where it came from.
        origin: cliPath,
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('reads another ring\'s version in the cache as unknown (plan R13 S-1: one ring-filtered reader)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-update-fact-ring-'));
    const env: NodeJS.ProcessEnv = { HAPPIER_HOME_DIR: homeDir, HAPPIER_STACK_REPO_DIR: homeDir, PATH: process.env.PATH };
    try {
      await installManagedCli(homeDir, '0.3.0');
      const nowMs = 1_800_000_000_000;
      // A pre-S-1 doctor repair wrote npm's `next` (a dev build) into the stable cache, unfiltered.
      writeUpdateCache(resolveCliUpdateCachePath({ happierHomeDir: homeDir, channelLabel: 'stable' }), {
        checkedAt: nowMs - 1_000,
        latest: '0.3.9-dev.4',
        current: '0.3.0',
        runtimeVersion: null,
        invokerVersion: null,
        updateAvailable: true,
        notifiedAt: null,
      });
      expect(readLocalCliUpdateFact({ processEnv: env, nowMs, refresh: vi.fn() })).toMatchObject({
        currentVersion: '0.3.0',
        latestVersion: null,
        updateAvailable: false,
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
