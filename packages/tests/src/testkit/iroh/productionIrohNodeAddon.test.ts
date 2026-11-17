import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveIrohNodeAddonPath } from '@happier-dev/iroh-native/node';

import { pnpmCommand } from '../process/commands';
import {
  ensureProductionIrohNodeAddon,
  resolveProductionIrohNodeAddonBuildSpec,
  stageProductionIrohNodeAddonForConsumer,
} from './productionIrohNodeAddon';

describe('production Iroh node addon custody', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempPackageRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'happier-iroh-addon-custody-'));
    mkdirSync(join(dir, 'native'), { recursive: true });
    cleanupDirs.push(dir);
    return dir;
  }

  it('requests the canonical ordinary-addon build through the repository pnpm corridor', () => {
    const packageRoot = '/repo/packages/iroh-native';
    const build = resolveProductionIrohNodeAddonBuildSpec({ packageRoot });
    // The exact canonical script the real-integration runner invokes, routed
    // through the same binary-safe `pnpmCommand()` corridor every other
    // testkit child launch uses (never a direct cargo/npm/node spawn).
    expect(build.command).toBe(pnpmCommand());
    expect(build.args).toEqual(['run', '--silent', 'build:native']);
    expect(build.cwd).toBe(packageRoot);
    expect(resolveProductionIrohNodeAddonBuildSpec().cwd).toMatch(/packages[\\/]iroh-native$/u);
  });

  it('builds the ordinary addon and verifies the canonical artifact before returning', async () => {
    const packageRoot = makeTempPackageRoot();
    const addonPath = resolveIrohNodeAddonPath(packageRoot);
    const builds: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const result = await ensureProductionIrohNodeAddon({
      testDir: packageRoot,
      packageRoot,
      runBuild: async (build) => {
        builds.push(build);
        // Simulate the canonical build's artifact install step.
        writeFileSync(addonPath, 'addon');
      },
    });

    expect(builds).toEqual([
      { command: pnpmCommand(), args: ['run', '--silent', 'build:native'], cwd: packageRoot },
    ]);
    // The verified path comes from the production loader's canonical owner,
    // not a restated artifact grammar.
    expect(result.addonPath).toBe(addonPath);
    expect(existsSync(result.addonPath)).toBe(true);
  });

  it('rebuilds even when the artifact already exists, so custody holds before every child start', async () => {
    const packageRoot = makeTempPackageRoot();
    writeFileSync(resolveIrohNodeAddonPath(packageRoot), 'stale');
    let builds = 0;
    await ensureProductionIrohNodeAddon({
      testDir: packageRoot,
      packageRoot,
      runBuild: async () => {
        builds += 1;
      },
    });
    expect(builds).toBe(1);
  });

  it('fails closed when the canonical build does not produce the ordinary artifact', async () => {
    const packageRoot = makeTempPackageRoot();
    const addonPath = resolveIrohNodeAddonPath(packageRoot);
    const error = await ensureProductionIrohNodeAddon({
      testDir: packageRoot,
      packageRoot,
      runBuild: async () => undefined,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(addonPath);
    expect((error as Error).message).toContain('build:native');
    expect(existsSync(addonPath)).toBe(false);
  });

  it('stages only addon bytes into an unowned physical consumer package', () => {
    const root = makeTempPackageRoot();
    const sourceAddonPath = resolveIrohNodeAddonPath(root);
    writeFileSync(sourceAddonPath, 'current ordinary addon bytes');
    const consumerDir = join(root, 'consumer');
    const installedPackageDir = join(consumerDir, 'node_modules', '@happier-dev', 'iroh-native');
    mkdirSync(join(installedPackageDir, 'dist'), { recursive: true });
    writeFileSync(join(installedPackageDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/iroh-native',
      type: 'module',
      exports: { './node': './dist/nodeNative.js' },
    }));
    writeFileSync(join(installedPackageDir, 'dist', 'nodeNative.js'), 'export {};');

    const staged = stageProductionIrohNodeAddonForConsumer({ sourceAddonPath, consumerDir });
    expect(staged).toBe(resolveIrohNodeAddonPath(realpathSync(installedPackageDir)));
    expect(readFileSync(staged, 'utf8')).toBe('current ordinary addon bytes');
    writeFileSync(sourceAddonPath, 'new addon bytes');
    expect(stageProductionIrohNodeAddonForConsumer({ sourceAddonPath, consumerDir })).toBe(staged);
    expect(readFileSync(staged, 'utf8')).toBe('new addon bytes');
    expect(readFileSync(join(installedPackageDir, 'dist', 'nodeNative.js'), 'utf8')).toBe('export {};');
    expect(existsSync(join(installedPackageDir, '.happier-testkit-source'))).toBe(false);
  });

  it('uses the source package behind a workspace symlink without creating a consumer copy', () => {
    const sourcePackageRoot = makeTempPackageRoot();
    const sourceAddonPath = resolveIrohNodeAddonPath(sourcePackageRoot);
    writeFileSync(sourceAddonPath, 'source addon bytes');
    mkdirSync(join(sourcePackageRoot, 'dist'), { recursive: true });
    writeFileSync(join(sourcePackageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/iroh-native',
      type: 'module',
      exports: { './node': './dist/nodeNative.js' },
    }));
    writeFileSync(join(sourcePackageRoot, 'dist', 'nodeNative.js'), 'export {};');
    const installedPackageDir = join(sourcePackageRoot, 'node_modules', '@happier-dev', 'iroh-native');
    mkdirSync(join(sourcePackageRoot, 'node_modules', '@happier-dev'), { recursive: true });
    symlinkSync(sourcePackageRoot, installedPackageDir, 'dir');
    const consumerDir = join(sourcePackageRoot, 'consumer');
    mkdirSync(consumerDir);
    writeFileSync(join(consumerDir, 'package.json'), '{}');

    expect(stageProductionIrohNodeAddonForConsumer({ sourceAddonPath, consumerDir }))
      .toBe(sourceAddonPath);
    expect(existsSync(join(consumerDir, 'node_modules', '@happier-dev', 'iroh-native')))
      .toBe(false);
  });

  it('removes only a marker-owned testkit copy so consumer resolution returns to the workspace package', () => {
    const sourcePackageRoot = makeTempPackageRoot();
    const sourceAddonPath = resolveIrohNodeAddonPath(sourcePackageRoot);
    mkdirSync(join(sourcePackageRoot, 'dist'), { recursive: true });
    const packageJson = JSON.stringify({
      name: '@happier-dev/iroh-native',
      type: 'module',
      exports: { './node': './dist/nodeNative.js' },
    });
    writeFileSync(join(sourcePackageRoot, 'package.json'), packageJson);
    writeFileSync(join(sourcePackageRoot, 'dist', 'nodeNative.js'), 'export const current = true;');
    writeFileSync(sourceAddonPath, 'current ordinary addon bytes');
    mkdirSync(join(sourcePackageRoot, 'node_modules', '@happier-dev'), { recursive: true });
    symlinkSync(sourcePackageRoot, join(sourcePackageRoot, 'node_modules', '@happier-dev', 'iroh-native'), 'dir');

    const consumerDir = join(sourcePackageRoot, 'consumer');
    const installedPackageDir = join(consumerDir, 'node_modules', '@happier-dev', 'iroh-native');
    mkdirSync(join(installedPackageDir, 'dist'), { recursive: true });
    mkdirSync(join(installedPackageDir, 'native'), { recursive: true });
    writeFileSync(join(consumerDir, 'package.json'), '{}');
    writeFileSync(join(installedPackageDir, 'package.json'), packageJson);
    writeFileSync(join(installedPackageDir, 'dist', 'nodeNative.js'), 'export const current = true;');
    writeFileSync(join(installedPackageDir, '.happier-testkit-source'), realpathSync(sourcePackageRoot));
    writeFileSync(resolveIrohNodeAddonPath(installedPackageDir), 'old addon bytes');

    const staged = stageProductionIrohNodeAddonForConsumer({
      sourceAddonPath,
      consumerDir,
    });
    expect(staged).toBe(sourceAddonPath);
    expect(readFileSync(staged, 'utf8')).toBe('current ordinary addon bytes');
    expect(existsSync(installedPackageDir)).toBe(false);
    expect(createRequire(join(consumerDir, 'package.json')).resolve('@happier-dev/iroh-native/node'))
      .toBe(realpathSync(join(sourcePackageRoot, 'dist', 'nodeNative.js')));
  });

  it('preserves a physical package when its ownership marker names another source', () => {
    const sourcePackageRoot = makeTempPackageRoot();
    const sourceAddonPath = resolveIrohNodeAddonPath(sourcePackageRoot);
    writeFileSync(sourceAddonPath, 'current ordinary addon bytes');
    const consumerDir = join(sourcePackageRoot, 'consumer');
    const installedPackageDir = join(consumerDir, 'node_modules', '@happier-dev', 'iroh-native');
    mkdirSync(join(installedPackageDir, 'dist'), { recursive: true });
    writeFileSync(join(consumerDir, 'package.json'), '{}');
    writeFileSync(join(installedPackageDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/iroh-native',
      type: 'module',
      exports: { './node': './dist/nodeNative.js' },
    }));
    writeFileSync(join(installedPackageDir, 'dist', 'nodeNative.js'), 'export {};');
    writeFileSync(join(installedPackageDir, '.happier-testkit-source'), 'different-source');

    expect(() => stageProductionIrohNodeAddonForConsumer({ sourceAddonPath, consumerDir }))
      .toThrow(/Iroh testkit package copy belongs to another source/u);
    expect(existsSync(resolveIrohNodeAddonPath(installedPackageDir))).toBe(false);
    expect(readFileSync(join(installedPackageDir, '.happier-testkit-source'), 'utf8'))
      .toBe('different-source');
    expect(readFileSync(join(installedPackageDir, 'dist', 'nodeNative.js'), 'utf8'))
      .toBe('export {};');
  });

  it('refuses to remove a marker-owned copy with unrelated added files', () => {
    const sourcePackageRoot = makeTempPackageRoot();
    const sourceAddonPath = resolveIrohNodeAddonPath(sourcePackageRoot);
    writeFileSync(sourceAddonPath, 'current ordinary addon bytes');
    const consumerDir = join(sourcePackageRoot, 'consumer');
    const installedPackageDir = join(consumerDir, 'node_modules', '@happier-dev', 'iroh-native');
    mkdirSync(installedPackageDir, { recursive: true });
    writeFileSync(join(consumerDir, 'package.json'), '{}');
    writeFileSync(join(installedPackageDir, '.happier-testkit-source'), realpathSync(sourcePackageRoot));
    writeFileSync(join(installedPackageDir, 'user-notes.txt'), 'keep this');

    expect(() => stageProductionIrohNodeAddonForConsumer({ sourceAddonPath, consumerDir }))
      .toThrow(/Cannot remove modified Iroh testkit package copy/u);
    expect(readFileSync(join(installedPackageDir, 'user-notes.txt'), 'utf8')).toBe('keep this');
  });
});
