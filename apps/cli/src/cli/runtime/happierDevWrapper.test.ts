import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type WrapperFixture = Readonly<{
  root: string;
  wrapperPath: string;
}>;

async function createWrapperFixture(): Promise<WrapperFixture> {
  const root = await mkdtemp(join(tmpdir(), 'happier-dev-wrapper-'));
  const projectRoot = join(root, 'project');
  const binDir = join(projectRoot, 'bin');
  const runtimeDir = join(projectRoot, 'runtime');
  await mkdir(binDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const testDir = dirname(fileURLToPath(import.meta.url));
  const cliRoot = join(testDir, '..', '..', '..');
  const wrapperSource = await readFile(join(cliRoot, 'bin', 'happier-dev.mjs'), 'utf8');
  await writeFile(join(binDir, 'happier-dev.mjs'), wrapperSource, 'utf8');
  await writeFile(
    join(binDir, '_importRuntimeEntrypoint.mjs'),
    [
      "import { fileURLToPath } from 'node:url';",
      "import { resolve } from 'node:path';",
      "export async function importPreparedRuntimeEntrypoint() {",
      "  return await import(new URL('../runtime/probe.mjs', import.meta.url));",
      '}',
      "if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {",
      '  const wrapperPath = process.argv[2];',
      '  const runtimeArgs = process.argv.slice(5);',
      '  process.argv.splice(1, process.argv.length - 1, wrapperPath, ...runtimeArgs);',
      '  await importPreparedRuntimeEntrypoint();',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(runtimeDir, 'probe.mjs'),
    [
      'console.log(JSON.stringify({',
      '  happyHomeDir: process.env.HAPPIER_HOME_DIR ?? null,',
      '  variant: process.env.HAPPIER_VARIANT ?? null,',
      '  invokedPath: process.env.HAPPIER_CLI_INVOKED_PATH ?? null,',
      '  invokerName: process.env.HAPPIER_CLI_INVOKER_NAME ?? null,',
      '  argv: process.argv.slice(2),',
      '}));',
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    root,
    wrapperPath: join(binDir, 'happier-dev.mjs'),
  };
}

function runWrapper(wrapperPath: string, env: NodeJS.ProcessEnv, options?: Readonly<{ timeout?: number }>) {
  return spawnSync(process.execPath, [wrapperPath, 'auth', 'status', '--json'], {
    env,
    encoding: 'utf8',
    timeout: options?.timeout,
  });
}

describe('happier-dev wrapper', () => {
  it('preserves an explicit HAPPIER_HOME_DIR override', async () => {
    const fixture = await createWrapperFixture();
    const explicitHome = join(tmpdir(), `happier-explicit-home-${process.pid}`);

    try {
      const result = runWrapper(fixture.wrapperPath, { ...process.env, HAPPIER_HOME_DIR: explicitHome });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const parsed = JSON.parse(result.stdout.trim()) as {
        happyHomeDir: string | null;
        variant: string | null;
        invokerName: string | null;
        argv: string[];
      };
      expect(parsed.happyHomeDir).toBe(explicitHome);
      expect(parsed.variant).toBe('dev');
      expect(parsed.invokerName).toBe('happier-dev');
      expect(parsed.argv).toEqual(['auth', 'status', '--json']);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('defaults to the dev home when no HAPPIER_HOME_DIR override is set', async () => {
    const fixture = await createWrapperFixture();
    const env = { ...process.env };
    delete env.HAPPIER_HOME_DIR;

    try {
      const result = runWrapper(fixture.wrapperPath, env);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const parsed = JSON.parse(result.stdout.trim()) as { happyHomeDir: string | null };
      expect(parsed.happyHomeDir).toBe(join(homedir(), '.happier-dev'));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('exits after the delegated runtime succeeds even when wrapper preflight leaves active handles', async () => {
    const fixture = await createWrapperFixture();
    const wrapperOnlyActiveHandleProbe = [
      "if (String(process.argv[1] ?? '').endsWith('/happier-dev.mjs')) {",
      '  setInterval(() => {}, 1000);',
      '}',
    ].join('\n');

    try {
      const result = runWrapper(fixture.wrapperPath, {
        ...process.env,
        NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(wrapperOnlyActiveHandleProbe)}`,
      }, { timeout: 2000 });

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe('');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
