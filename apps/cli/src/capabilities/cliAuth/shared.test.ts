import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import {
  resolveSystemJavaScriptRuntimeBinary,
  writeExecutableShim,
  writePnpmNodeBridge,
} from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir, withTempDir } from '@/testkit/fs/tempDir';
import { createDaemonizingProcessFixture } from '@/testkit/process/daemonizingProcess';
import { waitForProcessExit } from '@/testkit/process/spawn';

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

  it('reaps descendants on its own deadline even without a caller abort signal', async ({ task }) => {
    await withTempDir('happier-auth-deadline-custody-', async dir => {
      const fixture = createDaemonizingProcessFixture(dir);
      const probe = runCliCommandBestEffort({ resolvedPath: process.execPath, args: fixture.args, timeoutMs: 5_000 });
      try {
        const pid = await fixture.ready({ launch: probe, timeoutMs: task.timeout });
        await expect(probe).resolves.toMatchObject({ ok: false });
        expect(await waitForProcessExit(pid, { timeoutMs: 2_000 })).toBe(true);
      } finally {
        await fixture.release();
        await fixture.cleanup();
        await Promise.allSettled([probe]);
      }
    });
  }, 60_000);

  it('uses the supplied child environment for JavaScript runtime selection and credential unsets', async () => {
    const dir = await createTempDir('happier-cli-auth-child-env-');
    tempDirs.push(dir);
    const scriptPath = join(dir, 'auth.js');
    await writeFile(scriptPath,
      "process.stdout.write(process.env.HAPPIER_AUTH_CHILD_KEY && !process.env.HAPPIER_PNPM_BIN ? 'logged_in' : 'logged_out');\n",
      'utf8');
    envScope.patch({ HAPPIER_JS_RUNTIME_PATH: join(dir, 'missing-runtime'), HAPPIER_PNPM_BIN: 'ambient-only' });
    const result = await runCliCommandBestEffort({
      resolvedPath: scriptPath, args: [], timeoutMs: 2_000,
      processEnv: { ...process.env, HAPPIER_JS_RUNTIME_PATH: process.execPath,
        HAPPIER_PNPM_BIN: undefined, HAPPIER_AUTH_CHILD_KEY: 'launch-key' },
    });
    expect(result).toMatchObject({ ok: true, stdout: 'logged_in', exitCode: 0 });
    expect(process.env.HAPPIER_PNPM_BIN).toBe('ambient-only');
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

  it.skipIf(process.platform === 'win32')(
    'executes bun-shebang CLIs through a sibling bun runtime instead of node',
    async () => {
      const dir = await createTempDir('happier-cli-auth-bun-shebang-');
      tempDirs.push(dir);

      const scriptPath = join(dir, 'fake-omp');
      await writeFile(
        scriptPath,
        '#!/usr/bin/env bun\nconst message: string = "unreachable";\nprocess.stdout.write(message);\n',
        'utf8',
      );
      await chmod(scriptPath, 0o755);

      const runtimeBinary = resolveSystemJavaScriptRuntimeBinary(systemPath);
      await writeExecutableShim({
        dir,
        fileName: 'bun',
        contents: `#!/bin/sh\nshift\nexec "${runtimeBinary}" -e 'process.stdout.write(process.argv.slice(1).join(\" \"))' -- "$@"\n`,
      });

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
