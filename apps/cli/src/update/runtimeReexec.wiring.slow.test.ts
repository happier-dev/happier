import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';

function runBuildStep(args: string[], label: string): void {
  const result = spawnSync('yarn', args, {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: 'utf-8',
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${String(result.status)}:\n${result.stderr}`);
  }
}

function ensureDistBuilt(): void {
  if (existsSync(join(process.cwd(), 'dist', 'index.mjs'))) return;
  runBuildStep(['-s', 'build:shared'], 'build:shared');
  runBuildStep(['-s', 'pkgroll'], 'pkgroll');
}

function createRuntimePackage(homeDir: string, packageName: string, marker: string): void {
  const runtimePackageDir = join(homeDir, 'runtime', 'node_modules', ...packageName.split('/'));
  mkdirSync(join(runtimePackageDir, 'dist'), { recursive: true });
  writeFileSync(
    join(runtimePackageDir, 'package.json'),
    JSON.stringify({ name: packageName, version: '99.0.0' }, null, 2),
  );
  writeFileSync(join(runtimePackageDir, 'dist', 'index.mjs'), `console.log("${marker}");\n`);
}

function runCliVersionViaDist(homeDir: string, envOverrides?: NodeJS.ProcessEnv): string {
  const result = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'index.mjs'), '--version'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_VARIANT: 'stable',
      HAPPIER_CLI_UPDATE_CHECK: '0',
      ...envOverrides,
    },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('runtime re-exec wiring', () => {
  const tempDirs: string[] = [];

  beforeAll(() => {
    ensureDistBuilt();
  }, 240_000);

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-execs to runtime entrypoint when runtime is installed', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-runtime-home-'));
    tempDirs.push(homeDir);
    createRuntimePackage(homeDir, '@happier-dev/cli', 'RUNTIME_ENTRYPOINT');
    const stdout = runCliVersionViaDist(homeDir);
    expect(stdout).toContain('RUNTIME_ENTRYPOINT');
  }, 120000);

  it('respects HAPPIER_CLI_UPDATE_PACKAGE_NAME for runtime resolution', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-runtime-home-'));
    tempDirs.push(homeDir);
    createRuntimePackage(homeDir, '@company/happier-cli', 'RUNTIME_ENTRYPOINT_OVERRIDE');
    const stdout = runCliVersionViaDist(homeDir, {
      HAPPIER_CLI_UPDATE_PACKAGE_NAME: '@company/happier-cli',
    });
    expect(stdout).toContain('RUNTIME_ENTRYPOINT_OVERRIDE');
  }, 120000);
});
