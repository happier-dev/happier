import { afterEach, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';

import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import { createExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await removeTempDir(dir);
  tempDirs.clear();
});

async function createIsolatedEnv(): Promise<NodeJS.ProcessEnv> {
  const home = await createTempDir('happier-spawn-cli-admission-home-');
  tempDirs.add(home);
  return { PATH: home, HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home };
}

async function createProviderBinDir(name: string): Promise<string> {
  const binPath = await createExecutableShim({
    dirPrefix: 'happier-spawn-cli-admission-bin-',
    fileName: process.platform === 'win32' ? `${name}.cmd` : name,
    contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
  });
  const dir = dirname(binPath);
  tempDirs.add(dir);
  return dir;
}

async function admit(params: Readonly<{
  backendTarget: SpawnSessionOptions['backendTarget'];
  processEnv: NodeJS.ProcessEnv;
  daemonSpawnHooks?: DaemonSpawnHooks | null;
}>) {
  return await resolveSpawnChildEnvironment({
    options: { directory: '/tmp', backendTarget: params.backendTarget },
    profileEnvironmentVariables: {},
    daemonSpawnHooks: params.daemonSpawnHooks ?? null,
    processEnv: params.processEnv,
    logDebug: () => {},
    logInfo: () => {},
    logWarn: () => {},
  });
}

describe('resolveSpawnChildEnvironment provider CLI admission', () => {
  it('refuses a provider without its own launch hook when its CLI is not resolvable', async () => {
    const result = await admit({
      backendTarget: { kind: 'builtInAgent', agentId: 'qwen' },
      processEnv: await createIsolatedEnv(),
    });

    expect(result).toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });
  });

  it('admits a provider without its own launch hook when its CLI is resolvable', async () => {
    const result = await admit({
      backendTarget: { kind: 'builtInAgent', agentId: 'qwen' },
      processEnv: { ...await createIsolatedEnv(), PATH: await createProviderBinDir('qwen') },
    });

    expect(result.ok).toBe(true);
  });

  it('lets a provider launch hook own its requirement instead of the base CLI', async () => {
    const hooks: DaemonSpawnHooks = { validateSpawn: async () => ({ ok: true }) };

    const result = await admit({
      backendTarget: { kind: 'builtInAgent', agentId: 'agy' },
      processEnv: await createIsolatedEnv(),
      daemonSpawnHooks: hooks,
    });

    expect(result.ok).toBe(true);
  });

  it('does not apply built-in CLI admission to configured ACP backends', async () => {
    const result = await admit({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
      processEnv: await createIsolatedEnv(),
    });

    expect(result.ok).toBe(true);
  });
});
