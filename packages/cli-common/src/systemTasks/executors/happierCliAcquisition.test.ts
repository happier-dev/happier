import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveInstalledFirstPartyComponentPaths } from '../../firstPartyRuntime/index.js';
import {
  DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
  ensureLocalFirstPartyComponentCommand,
} from '../index.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('ensureLocalFirstPartyComponentCommand', () => {
  it('returns an explicit env-var command without attempting install', async () => {
    const preparePayload = vi.fn();
    const installPayload = vi.fn();

    await expect(ensureLocalFirstPartyComponentCommand(
      {
        componentId: 'happier-cli',
        processEnv: {
          ...process.env,
          [DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES[0]]: '/tmp/explicit-happier',
        },
        envVarNames: DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
        releaseRing: 'stable',
      },
      {
        preparePayload: preparePayload as never,
        installPayload: installPayload as never,
      },
    )).resolves.toBe('/tmp/explicit-happier');

    expect(preparePayload).not.toHaveBeenCalled();
    expect(installPayload).not.toHaveBeenCalled();
  });

  it('prepares and installs the component when no explicit/installed command exists', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'cli-common-cli-acquire-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    const previousCwd = process.cwd();

    const preparePayload = vi.fn(async () => ({
      versionId: '1.2.3',
      payloadRoot: join(rootDir, 'payload'),
      cleanup: async () => undefined,
    }));

    const installPayload = vi.fn(async (params: Parameters<typeof import('../../firstPartyRuntime/index.js')['installVersionedPayload']>[0]) => {
      const paths = resolveInstalledFirstPartyComponentPaths({
        componentId: params.componentId,
        processEnv: params.processEnv,
        releaseRing: params.releaseRing,
      });
      mkdirSync(dirname(paths.binaryPath), { recursive: true });
      writeFileSync(paths.binaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      chmodSync(paths.binaryPath, 0o755);
    });

    try {
      process.chdir(rootDir);
      const command = await ensureLocalFirstPartyComponentCommand(
        {
          componentId: 'happier-cli',
          processEnv: {
            ...process.env,
            HAPPIER_HOME_DIR: happyHomeDir,
          },
          envVarNames: DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
          releaseRing: 'stable',
        },
        {
          preparePayload: preparePayload as never,
          installPayload: installPayload as never,
        },
      );

      const expected = resolveInstalledFirstPartyComponentPaths({
        componentId: 'happier-cli',
        processEnv: {
          ...process.env,
          HAPPIER_HOME_DIR: happyHomeDir,
        },
        releaseRing: 'stable',
      }).binaryPath;

      expect(command).toBe(expected);
      expect(preparePayload).toHaveBeenCalledTimes(1);
      expect(installPayload).toHaveBeenCalledTimes(1);
    } finally {
      process.chdir(previousCwd);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
