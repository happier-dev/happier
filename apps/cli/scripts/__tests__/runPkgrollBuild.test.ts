import { spawn as spawnChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { preparePkgrollPackageManifest, runPkgrollBuild } from '../runPkgrollBuild.mjs';

function writeIsolatedPkgrollRepo(prefix: string) {
  const repoRoot = createTempDirSync(prefix);
  const packageRoot = join(repoRoot, 'apps', 'cli');
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageYamlPath = join(packageRoot, 'package.yaml');
  const outputDir = 'dist.staging.test';
  const stagingDir = join(packageRoot, outputDir);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(packageJsonPath, JSON.stringify({
    name: '@happier-dev/pkgroll-fixture',
    version: '0.0.0',
    main: './dist/index.cjs',
  }), 'utf8');
  return {
    repoRoot,
    packageRoot,
    packageJsonPath,
    packageYamlPath,
    outputDir,
    stagingDir,
  };
}

function waitForChildOutput(
  child: ReturnType<typeof spawnChildProcess>,
  expected: string,
  timeoutMs = 10_000,
) {
  return new Promise<void>((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for child output ${JSON.stringify(expected)}; stderr=${stderr}`)),
      timeoutMs,
    );
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (!stdout.includes(expected)) return;
      clearTimeout(timeout);
      resolvePromise();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(
        `wrapper fixture exited before ${JSON.stringify(expected)} (code=${code}, signal=${signal}, stderr=${stderr})`,
      ));
    });
  });
}

function runPhysicalPackageAliasStageBehavior(aliasKind: 'directory' | 'file') {
  const fixture = writeIsolatedPkgrollRepo(`happier-cli-pkgroll-${aliasKind}-alias-owner-`);
  const aliasRepoRoot = createTempDirSync(`happier-cli-pkgroll-${aliasKind}-alias-repo-`);
  const aliasPackageRoot = join(aliasRepoRoot, 'apps', 'cli');
  const aliasPackageJsonPath = join(aliasPackageRoot, 'package.json');
  mkdirSync(join(aliasRepoRoot, 'apps'), { recursive: true });
  if (aliasKind === 'directory') {
    symlinkSync(
      fixture.packageRoot,
      aliasPackageRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } else {
    mkdirSync(aliasPackageRoot, { recursive: true });
    symlinkSync(fixture.packageJsonPath, aliasPackageJsonPath, 'file');
  }
  expect(realpathSync.native(aliasPackageJsonPath)).toBe(realpathSync.native(fixture.packageJsonPath));

  try {
    const spawn = vi.fn((_executable, _args, spawnOptions) => {
      expect(spawnOptions.cwd).toBe(realpathSync.native(fixture.stagingDir));
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(true);
      return { status: 0 };
    });
    runPkgrollBuild({
      packageJsonPath: aliasPackageJsonPath,
      outputDir: fixture.outputDir,
      spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(false);
    expect(existsSync(fixture.packageYamlPath)).toBe(false);
  } finally {
    rmSync(aliasRepoRoot, { recursive: true, force: true });
    rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
}

describe('runPkgrollBuild', () => {
  it('uses the physical staging directory for a directory symlink or junction alias', () => {
    runPhysicalPackageAliasStageBehavior('directory');
  });

  it.skipIf(process.platform === 'win32')(
    'uses the physical staging directory for a file symlink alias',
    () => {
      runPhysicalPackageAliasStageBehavior('file');
    },
  );

  it('fails on a missing package manifest before creating a stage', () => {
    const repoRoot = createTempDirSync('happier-cli-pkgroll-missing-physical-manifest-');
    const packageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
    mkdirSync(dirname(packageJsonPath), { recursive: true });
    const spawn = vi.fn(() => ({ status: 0 }));
    try {
      expect(() => runPkgrollBuild({
        packageJsonPath,
        outputDir: 'dist.staging.test',
        spawn,
      })).toThrow(/ENOENT|no such file or directory/i);
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(join(dirname(packageJsonPath), 'dist.staging.test'))).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('requires an explicit builder-owned output directory', () => {
    const fixture = writeIsolatedPkgrollRepo('happier-cli-pkgroll-required-stage-');
    const spawn = vi.fn(() => ({ status: 0 }));
    try {
      expect(() => runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        spawn,
      })).toThrow(/explicit relative builder-owned output directory/);
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(fixture.packageYamlPath)).toBe(false);
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('uses a transformed stage-owned manifest while preserving an arbitrary parent package.yaml', () => {
    const fixture = writeIsolatedPkgrollRepo('happier-cli-pkgroll-stage-manifest-');
    const parentYamlRaw = 'name: user-authored-parent-manifest\ncustom: preserve-exactly\n';
    writeFileSync(fixture.packageYamlPath, parentYamlRaw, 'utf8');
    writeFileSync(fixture.packageJsonPath, JSON.stringify({
      name: '@happier-dev/pkgroll-fixture',
      version: '0.0.0',
      main: './dist/index.cjs',
      module: './dist/index.mjs',
      dependencies: {
        '@happier-dev/protocol': '0.0.0',
        zod: '4.3.6',
      },
      bundledDependencies: ['@happier-dev/protocol'],
      bin: {
        happier: './bin/happier.mjs',
      },
    }), 'utf8');
    const updatedCanonicalManifestRaw = readFileSync(fixture.packageJsonPath, 'utf8');

    let stageManifestDuringPkgroll: unknown = null;
    const spawn = vi.fn((_executable, _args, options) => {
      expect(options.cwd).toBe(realpathSync.native(fixture.stagingDir));
      stageManifestDuringPkgroll = JSON.parse(
        readFileSync(join(fixture.stagingDir, 'package.json'), 'utf8'),
      );
      expect(readFileSync(fixture.packageYamlPath, 'utf8')).toBe(parentYamlRaw);
      return { status: 0 };
    });

    try {
      runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        outputDir: fixture.outputDir,
        spawn,
      });

      expect(spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
        '--packagejson=false',
        '--srcdist',
        '../src:.',
        '--input',
        'index.cjs',
        '--input',
        'index.mjs',
      ]));
      expect(stageManifestDuringPkgroll).toMatchObject({
        main: './index.cjs',
        module: './index.mjs',
        dependencies: { zod: '4.3.6' },
        devDependencies: { '@happier-dev/protocol': '0.0.0' },
      });
      expect(stageManifestDuringPkgroll).not.toHaveProperty('bin');
      expect(stageManifestDuringPkgroll).not.toHaveProperty('x-happier-pkgroll-override');
      expect(readFileSync(fixture.packageJsonPath, 'utf8')).toBe(updatedCanonicalManifestRaw);
      expect(readFileSync(fixture.packageYamlPath, 'utf8')).toBe(parentYamlRaw);
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(false);
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('removes the stage manifest after a pkgroll failure without mutating the source package', () => {
    const fixture = writeIsolatedPkgrollRepo('happier-cli-pkgroll-interruption-');
    const canonicalManifestRaw = readFileSync(fixture.packageJsonPath, 'utf8');
    const spawn = vi.fn((_executable, _args, options) => {
      expect(options.cwd).toBe(realpathSync.native(fixture.stagingDir));
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(true);
      expect(existsSync(fixture.packageYamlPath)).toBe(false);
      throw new Error('simulated pkgroll interruption');
    });

    try {
      expect(() => runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        outputDir: fixture.outputDir,
        spawn,
      })).toThrow(/simulated pkgroll interruption/);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readFileSync(fixture.packageJsonPath, 'utf8')).toBe(canonicalManifestRaw);
      expect(existsSync(fixture.packageYamlPath)).toBe(false);
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(false);
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('leaves abrupt-termination residue only inside the builder-owned stage', async () => {
    const fixture = writeIsolatedPkgrollRepo('happier-cli-pkgroll-abrupt-interruption-');
    const wrapperModuleUrl = new URL('../runPkgrollBuild.mjs', import.meta.url).href;
    const childSource = `
const { runPkgrollBuild } = await import(${JSON.stringify(wrapperModuleUrl)});
runPkgrollBuild({
  packageJsonPath: ${JSON.stringify(fixture.packageJsonPath)},
  outputDir: ${JSON.stringify(fixture.outputDir)},
  spawn: () => {
    process.stdout.write('pkgroll-boundary-ready\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});
`;
    const child = spawnChildProcess(
      process.execPath,
      ['--input-type=module', '--eval', childSource],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      await waitForChildOutput(child, 'pkgroll-boundary-ready\n');
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(true);
      expect(existsSync(fixture.packageYamlPath)).toBe(false);

      const childExit = new Promise<void>((resolvePromise) => {
        child.once('exit', () => resolvePromise());
      });
      expect(child.kill('SIGKILL')).toBe(true);
      await childExit;

      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(true);
      expect(existsSync(fixture.packageYamlPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it('rewrites package-dist entrypoints to dist for pkgroll without modifying publish file allowlists', () => {
    const manifest = preparePkgrollPackageManifest({
      main: './package-dist/index.cjs',
      module: './package-dist/index.mjs',
      types: './package-dist/index.d.cts',
      exports: {
        '.': {
          require: {
            types: './package-dist/index.d.cts',
            default: './package-dist/index.cjs',
          },
          import: {
            types: './package-dist/index.d.mts',
            default: './package-dist/index.mjs',
          },
        },
      },
      bin: {
        happier: './bin/happier.mjs',
      },
      files: ['package-dist', 'package-dist/**', 'bin'],
    });

    expect(manifest).toMatchObject({
      main: './dist/index.cjs',
      module: './dist/index.mjs',
      types: './dist/index.d.cts',
      exports: {
        '.': {
          require: {
            types: './dist/index.d.cts',
            default: './dist/index.cjs',
          },
          import: {
            types: './dist/index.d.mts',
            default: './dist/index.mjs',
          },
        },
      },
      files: ['package-dist', 'package-dist/**', 'bin'],
    });
    expect(manifest).not.toHaveProperty('bin');
  });

  it('can rewrite package-dist entrypoints to an explicit build output directory', () => {
    const manifest = preparePkgrollPackageManifest(
      {
        main: './package-dist/index.cjs',
        module: './package-dist/index.mjs',
        exports: {
          '.': {
            import: {
              default: './package-dist/index.mjs',
            },
          },
        },
        bin: {
          happier: './bin/happier.mjs',
        },
      },
      { outputDir: '.tmp.cli-dist-build' },
    );

    expect(manifest).toMatchObject({
      main: './.tmp.cli-dist-build/index.cjs',
      module: './.tmp.cli-dist-build/index.mjs',
      exports: {
        '.': {
          import: {
            default: './.tmp.cli-dist-build/index.mjs',
          },
        },
      },
    });
    expect(manifest).not.toHaveProperty('bin');
  });

  it('keeps a completed runtime generation behaviorally immutable after its workspace dependency changes', async () => {
    const dir = createTempDirSync('happier-cli-pkgroll-immutable-generation-');
    const outputDir = 'dist.staging.immutable';
    try {
      const dependencyDir = join(dir, 'node_modules', '@happier-dev', 'runtime-fixture');
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(dependencyDir, { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), "export { generation } from '@happier-dev/runtime-fixture';\n", 'utf8');
      writeFileSync(join(dependencyDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/runtime-fixture',
        version: '0.0.0',
        type: 'module',
        exports: './index.js',
      }), 'utf8');
      writeFileSync(join(dependencyDir, 'index.js'), "export const generation = 'previous';\n", 'utf8');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: '@happier-dev/runtime-host-fixture',
        version: '0.0.0',
        type: 'module',
        module: './dist/index.mjs',
        dependencies: { '@happier-dev/runtime-fixture': '0.0.0' },
        bundledDependencies: ['@happier-dev/runtime-fixture'],
      }), 'utf8');
      runPkgrollBuild({
        packageJsonPath: join(dir, 'package.json'),
        outputDir,
      });
      writeFileSync(join(dependencyDir, 'index.js'), "export const generation = 'mutated';\n", 'utf8');

      const builtPath = join(dir, outputDir, 'index.mjs');
      const built = await import(`${pathToFileURL(builtPath).href}?t=${Date.now()}`);
      expect(built.generation).toBe('previous');
      expect(readFileSync(builtPath, 'utf8')).not.toContain('@happier-dev/runtime-fixture');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses slash-normalized stage-relative source and input paths for a nested output directory', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-output-dir-');
    const packageJsonPath = join(dir, 'package.json');
    const outputDir = '.tmp/cli-dist-build';
    const original = {
      module: './dist/index.mjs',
      exports: {
        '.': {
          import: {
            default: './dist/index.mjs',
          },
        },
      },
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
    const spawn = vi.fn(() => ({ status: 0 }));

    try {
      runPkgrollBuild({ packageJsonPath, spawn, outputDir });

      expect(spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
        '--packagejson=false',
        '--srcdist',
        '../../src:.',
        '--input',
        'index.mjs',
      ]));
      expect(spawn.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
        cwd: realpathSync.native(join(dir, outputDir)),
      }));
      expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies bounded timeout override from environment for Windows stall protection', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-timeout-');
    const packageJsonPath = join(dir, 'package.json');
    const outputDir = 'dist.staging.timeout';
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './package-dist/index.mjs' }, null, 2)}\n`, 'utf8');
    const spawn = vi.fn(() => ({ status: 0 }));

    try {
      runPkgrollBuild({
        packageJsonPath,
        outputDir,
        spawn,
        env: { HAPPIER_CLI_PKGROLL_TIMEOUT_MS: '120000' },
      });

      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining([
          expect.stringContaining('pkgroll/dist/cli.mjs'),
          '--packagejson=false',
          '--srcdist',
          '../src:.',
        ]),
        expect.objectContaining({
          cwd: realpathSync.native(join(dir, outputDir)),
          timeout: 120_000,
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forwards the admitted build environment to the pkgroll subprocess', () => {
    const fixture = writeIsolatedPkgrollRepo('happier-cli-pkgroll-build-env-');
    const spawn = vi.fn(() => ({ status: 0 }));
    const env = {
      PATH: process.env.PATH ?? '',
      NODE_OPTIONS: '--trace-warnings --max-old-space-size=8192',
    };

    try {
      runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        outputDir: fixture.outputDir,
        spawn,
        env,
      });

      expect(spawn.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ env }));
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });
});
