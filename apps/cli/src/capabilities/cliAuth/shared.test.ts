import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writePnpmNodeBridge } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { runCliCommandBestEffort } from './shared';

const envKeys = [
  'PATH',
  'HAPPIER_PNPM_BIN',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
] as const;

describe('runCliCommandBestEffort', () => {
  const tempDirs: string[] = [];
  const systemPath = process.env.PATH;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir).catch(() => undefined)));
  });

  it('executes JavaScript CLIs through the current runtime when PATH does not contain node', async () => {
    const dir = await createTempDir('happier-cli-auth-js-');
    tempDirs.push(dir);

    const scriptPath = join(dir, 'fake-cli.js');
    await writeFile(
      scriptPath,
      '#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(" "));\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    envScope.patch({ PATH: '' });
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir, pathLookup: systemPath });

    const result = await runCliCommandBestEffort({
      resolvedPath: scriptPath,
      args: ['login', 'status'],
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('login status');
  });

  it('preserves non-zero exit codes for JavaScript CLIs bootstrapped through the managed runtime', async () => {
    const dir = await createTempDir('happier-cli-auth-js-exit-');
    tempDirs.push(dir);

    const scriptPath = join(dir, 'fake-cli.js');
    await writeFile(
      scriptPath,
      '#!/usr/bin/env node\nprocess.exit(1);\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    envScope.patch({ PATH: '' });
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir, pathLookup: systemPath });

    const result = await runCliCommandBestEffort({
      resolvedPath: scriptPath,
      args: ['login', 'status'],
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'executes node-shebang CLIs without a file extension through the managed runtime when PATH does not contain node',
    async () => {
      const dir = await createTempDir('happier-cli-auth-node-shebang-');
      tempDirs.push(dir);

      const scriptPath = join(dir, 'fake-cli');
      await writeFile(
        scriptPath,
        '#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(" "));\n',
        'utf8',
      );
      await chmod(scriptPath, 0o755);

      envScope.patch({
        PATH: '',
        HAPPIER_JS_RUNTIME_PATH: undefined,
        HAPPIER_MANAGED_NODE_BIN: undefined,
        HAPPIER_NODE_PATH: undefined,
      });
      process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir, pathLookup: systemPath });

      const result = await runCliCommandBestEffort({
        resolvedPath: scriptPath,
        args: ['auth', 'list'],
        timeoutMs: 2_000,
      });

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('auth list');
    },
  );
});
