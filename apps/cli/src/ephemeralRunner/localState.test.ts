import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const filesystemFailure = vi.hoisted(() => ({ failNextCacheDirectory: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (path: Parameters<typeof actual.mkdir>[0], options?: Parameters<typeof actual.mkdir>[1]) => {
      if (filesystemFailure.failNextCacheDirectory && String(path).endsWith(`${sep}.cache`)) {
        filesystemFailure.failNextCacheDirectory = false;
        throw new Error('simulated activation-local setup failure');
      }
      return await actual.mkdir(path, options);
    },
  };
});

import {
  bindEphemeralRunnerProcessStorageEnvironment,
  createEphemeralRunnerLocalState,
} from './localState';

import { resolveNativeAgentLaunchEnvironment } from '@/agent/runtime/launchEnvironment';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';

const roots: string[] = [];

afterEach(async () => {
  filesystemFailure.failNextCacheDirectory = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ephemeral Runner local state', () => {
  it('uses one protected activation-scoped Home and removes only that Home', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-runner-state-parent-'));
    roots.push(parent);
    const unrelated = join(parent, 'keep.txt');
    await writeFile(unrelated, 'keep');

    const state = await createEphemeralRunnerLocalState({
      activationId: '00000000-0000-4000-8000-000000000013',
      parentDirectory: parent,
    });
    const mode = (await stat(state.homeDirectory)).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o700);
    expect(state.environment.HAPPIER_HOME_DIR).toBe(state.homeDirectory);
    expect(state.endpointHomeDirectory).not.toBe(state.homeDirectory);

    await writeFile(join(state.homeDirectory, 'private-material'), 'secret');
    await state.dispose();
    await expect(access(state.homeDirectory)).rejects.toBeDefined();
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
    await state.dispose();
  });

  it('does not inherit ambient credentials or persistent native-login homes into the scoped runtime', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-runner-state-parent-'));
    roots.push(parent);

    const state = await createEphemeralRunnerLocalState({
      activationId: '00000000-0000-4000-8000-000000000014',
      parentDirectory: parent,
      baseEnvironment: {
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        HOME: '/persistent/home',
        USERPROFILE: 'C:\\Users\\persistent',
        CODEX_HOME: '/persistent/codex',
        OPENAI_API_KEY: 'ambient-openai-secret',
        HAPPIER_TOKEN: 'ambient-happier-secret',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '[{"kind":"profile"}]',
        HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: '["MATERIALIZED_PROVIDER_SECRET"]',
        MATERIALIZED_PROVIDER_SECRET: 'ambient-connected-service-secret',
      },
    });

    expect(state.environment).toMatchObject({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      HOME: state.homeDirectory,
      USERPROFILE: state.homeDirectory,
      HAPPIER_HOME_DIR: state.homeDirectory,
    });
    expect(state.endpointHomeDirectory).toBe('/persistent/home');
    expect(state.environment).not.toHaveProperty('CODEX_HOME');
    expect(state.environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(state.environment).not.toHaveProperty('HAPPIER_TOKEN');
    expect(state.environment).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON');
    expect(state.environment).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON');
    expect(state.environment).not.toHaveProperty('MATERIALIZED_PROVIDER_SECRET');

    expect(state.unsetEnvironmentVariables).toEqual(expect.arrayContaining([
      'CODEX_HOME',
      'OPENAI_API_KEY',
      'HAPPIER_TOKEN',
      'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
      'HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON',
      'MATERIALIZED_PROVIDER_SECRET',
    ]));
  });

  it('binds only storage roots for runtime module initialization and restores the ambient process exactly', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-runner-state-parent-'));
    roots.push(parent);
    const state = await createEphemeralRunnerLocalState({
      activationId: '00000000-0000-4000-8000-000000000016',
      parentDirectory: parent,
      baseEnvironment: { PATH: '/usr/bin' },
    });
    const previous = {
      HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
      HOME: process.env.HOME,
      HAPPIER_RUNNER_NATIVE_SHELL: process.env.HAPPIER_RUNNER_NATIVE_SHELL,
    };
    process.env.HAPPIER_HOME_DIR = '/ordinary-cli-home';
    process.env.HOME = '/ordinary-user-home';
    process.env.HAPPIER_RUNNER_NATIVE_SHELL = 'stdio';

    const restore = bindEphemeralRunnerProcessStorageEnvironment(state);
    try {
      expect(process.env.HAPPIER_HOME_DIR).toBe(state.homeDirectory);
      expect(process.env.HOME).toBe(state.homeDirectory);
      expect(process.env.HAPPIER_RUNNER_NATIVE_SHELL).toBe('stdio');
      restore();
      restore();
      expect(process.env.HAPPIER_HOME_DIR).toBe('/ordinary-cli-home');
      expect(process.env.HOME).toBe('/ordinary-user-home');
      expect(process.env.HAPPIER_RUNNER_NATIVE_SHELL).toBe('stdio');
    } finally {
      restore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('removes its exact activation Home when setup fails before a state handle exists', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-runner-state-parent-'));
    roots.push(parent);
    await writeFile(join(parent, 'keep.txt'), 'keep');
    filesystemFailure.failNextCacheDirectory = true;

    await expect(createEphemeralRunnerLocalState({
      activationId: '00000000-0000-4000-8000-000000000015',
      parentDirectory: parent,
    })).rejects.toThrow('simulated activation-local setup failure');

    expect(await readdir(parent)).toEqual(['keep.txt']);
  });

  it('retains Windows installation paths through native launch while keeping the activation Home private', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-runner-state-parent-'));
    roots.push(parent);
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    try {
      const state = await createEphemeralRunnerLocalState({
        activationId: '00000000-0000-4000-8000-000000000017', parentDirectory: parent,
        baseEnvironment: { HOME: 'D:\\Users\\persistent', USERPROFILE: 'D:\\Users\\persistent',
          APPDATA: 'D:\\Users\\persistent\\AppData\\Roaming', OPENAI_API_KEY: 'ambient-secret',
          ProgramFiles: 'D:\\Applications', 'ProgramFiles(x86)': 'D:\\Applications (x86)', pRoGrAmDaTa: 'D:\\ProgramData' },
      });
      const environmentVariables = Object.fromEntries(Object.entries(state.environment)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const launched = resolveNativeAgentLaunchEnvironment({ processEnv: state.environment,
        environmentVariables, unsetEnvironmentVariables: state.unsetEnvironmentVariables });
      expect(launched.values).toMatchObject({ ProgramFiles: 'D:\\Applications', 'ProgramFiles(x86)': 'D:\\Applications (x86)',
        pRoGrAmDaTa: 'D:\\ProgramData', HOME: state.homeDirectory, USERPROFILE: state.homeDirectory });
      expect(launched.values).not.toHaveProperty('APPDATA');
      expect(launched.values).not.toHaveProperty('OPENAI_API_KEY');
      expect(validateEnvVarRecordStrict(launched.values)).toEqual({ ok: true, env: launched.values });
      await state.dispose();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});
