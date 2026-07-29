import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';
import {
  buildHappyCliSubprocessLaunchSpec,
  resolveTsxImportHookPath,
  toNodeImportSpecifier,
} from './spawnHappyCLI';

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const envScope = createSpawnHappyCliEnvScope();

afterEach(() => {
  process.argv = [...originalArgv];
  process.execArgv = [...originalExecArgv];
  envScope.restore();
});

function runSourceChild(params: Readonly<{
  filePath: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
}>): Readonly<{ code: number | null; stdout: string; stderr: string; error: string | null }> {
  const child = spawnSync(params.filePath, params.args, {
    cwd: params.cwd,
    env: {
      ...process.env,
      ...(params.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    code: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    error: child.error?.message ?? null,
  };
}

describe('spawnHappyCLI current-source subprocess invocation', () => {
  it('normalizes split and equals-form relative module flags without changing URL or bare specifiers', async () => {
    await withTempDir('happier source child flags ', async (root) => {
      const sourceEntrypoint = join(root, 'src', 'index.ts');
      mkdirSync(join(sourceEntrypoint, '..'), { recursive: true });
      writeFileSync(sourceEntrypoint, 'export {};', 'utf8');
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined,
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined,
      });
      process.argv[1] = sourceEntrypoint;
      process.execArgv = [
        '--import=../hooks/register.mjs',
        '--loader',
        './loaders/custom.mjs',
        '--import',
        'data:text/javascript,export default {}',
        '--loader=@scope/custom-loader',
      ];

      const launchSpec = buildHappyCliSubprocessLaunchSpec([]);

      expect(launchSpec.args).toEqual(expect.arrayContaining([
        `--import=${toNodeImportSpecifier(resolve('../hooks/register.mjs'))}`,
        '--loader',
        toNodeImportSpecifier(resolve('./loaders/custom.mjs')),
        '--import',
        'data:text/javascript,export default {}',
        '--loader=@scope/custom-loader',
      ]));
    });
  });

  it('runs a TypeScript child from an arbitrary session cwd with an inherited relative tsx import hook', async () => {
    await withTempDir('happier source child loader ', async (root) => {
      const sourceEntrypoint = join(root, 'source tree with spaces', 'src', 'index.ts');
      const sessionCwd = join(root, 'arbitrary session cwd');
      mkdirSync(sessionCwd, { recursive: true });
      mkdirSync(join(sourceEntrypoint, '..'), { recursive: true });
      writeFileSync(
        join(sourceEntrypoint, '..', '..', 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { module: 'esnext', target: 'es2022' } }),
        'utf8',
      );
      writeFileSync(
        sourceEntrypoint,
        'const signal: string = "source-child-ready"; process.stdout.write(signal);',
        'utf8',
      );

      const tsxHookPath = resolveTsxImportHookPath();
      expect(tsxHookPath).not.toBeNull();

      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: undefined,
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined,
      });
      process.argv[1] = sourceEntrypoint;
      process.execArgv = ['--import', relative(process.cwd(), tsxHookPath!)];

      const launchSpec = buildHappyCliSubprocessLaunchSpec([]);
      const importIndex = launchSpec.args.indexOf('--import');
      expect(importIndex).toBeGreaterThanOrEqual(0);
      expect(isAbsolute(launchSpec.args[importIndex + 1]!)).toBe(true);

      const result = runSourceChild({
        filePath: launchSpec.filePath,
        args: launchSpec.args,
        cwd: sessionCwd,
        env: launchSpec.env,
      });

      expect(result).toEqual({
        code: 0,
        stdout: 'source-child-ready',
        stderr: '',
        error: null,
      });
    });
  });
});
