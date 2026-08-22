import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn as spawnChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { collectPkgrollInputPaths, runPkgrollBuild } from '../runPkgrollBuild.mjs';

const cliPackageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function writeIsolatedPkgrollRepo(prefix: string) {
  const repoRoot = createTempDirSync(prefix);
  const packageRoot = join(repoRoot, 'apps', 'cli');
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageYamlPath = join(packageRoot, 'package.yaml');
  const pkgrollCliPath = join(packageRoot, 'pkgroll-cli.mjs');
  const outputDir = 'dist.staging.test';
  const stagingDir = join(packageRoot, outputDir);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
  writeFileSync(join(repoRoot, 'yarn.lock'), '# isolated wrapper fixture\n', 'utf8');
  writeFileSync(packageJsonPath, JSON.stringify({
    name: '@happier-dev/pkgroll-fixture',
    version: '0.0.0',
    main: './dist/index.cjs',
  }), 'utf8');
  writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');
  return {
    repoRoot,
    packageRoot,
    packageJsonPath,
    packageYamlPath,
    pkgrollCliPath,
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
      () => reject(new Error(`timed out waiting for ${JSON.stringify(expected)}; stderr=${stderr}`)),
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

function runPhysicalPackageAlias(aliasKind: 'directory' | 'file') {
  const fixture = writeIsolatedPkgrollRepo(`happier-dev-cli-pkgroll-${aliasKind}-owner-`);
  const aliasRepoRoot = createTempDirSync(`happier-dev-cli-pkgroll-${aliasKind}-alias-`);
  const aliasPackageRoot = join(aliasRepoRoot, 'apps', 'cli');
  const aliasPackageJsonPath = join(aliasPackageRoot, 'package.json');
  writeFileSync(join(aliasRepoRoot, 'package.json'), '{"private":true}\n', 'utf8');
  writeFileSync(join(aliasRepoRoot, 'yarn.lock'), '# lexical alias repository\n', 'utf8');
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
    const spawn = vi.fn((_executable, _args, options) => {
      expect(options.cwd).toBe(realpathSync.native(fixture.stagingDir));
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(true);
      return { status: 0 };
    });
    runPkgrollBuild({
      packageJsonPath: aliasPackageJsonPath,
      pkgrollCliPath: fixture.pkgrollCliPath,
      outputDir: fixture.outputDir,
      spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(aliasRepoRoot, { recursive: true, force: true });
    rmSync(fixture.repoRoot, { recursive: true, force: true });
  }
}

describe('runPkgrollBuild', () => {
  it('converges a directory symlink or junction alias on the physical package stage', () => {
    runPhysicalPackageAlias('directory');
  }, 20_000);

  it.skipIf(process.platform === 'win32')(
    'converges a file symlink alias on the physical package stage',
    () => {
      runPhysicalPackageAlias('file');
    },
    20_000,
  );

  it('fails on a missing physical package manifest before any build work', () => {
    const fixture = writeIsolatedPkgrollRepo('happier-dev-cli-pkgroll-missing-manifest-');
    rmSync(fixture.packageJsonPath);
    try {
      expect(() => runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        pkgrollCliPath: fixture.pkgrollCliPath,
        outputDir: fixture.outputDir,
        spawn: vi.fn(() => ({ status: 0 })),
      })).toThrow(/ENOENT|no such file or directory/i);
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('requires an explicit relative builder-owned output directory', () => {
    const fixture = writeIsolatedPkgrollRepo('happier-dev-cli-pkgroll-required-stage-');
    const spawn = vi.fn(() => ({ status: 0 }));
    try {
      for (const outputDir of [
        undefined,
        '/absolute/stage',
        'C:\\absolute\\stage',
        '\\\\server\\stage',
        '../escape',
        'nested/../escape',
      ]) {
        expect(() => runPkgrollBuild({
          packageJsonPath: fixture.packageJsonPath,
          pkgrollCliPath: fixture.pkgrollCliPath,
          outputDir,
          spawn,
        })).toThrow(/explicit relative builder-owned output directory/);
      }
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('uses a transformed stage-owned manifest while preserving parent manifests', () => {
    const fixture = writeIsolatedPkgrollRepo('happier-dev-cli-pkgroll-stage-manifest-');
    const parentYamlRaw = 'name: user-authored-parent-manifest\ncustom: preserve-exactly\n';
    writeFileSync(fixture.packageYamlPath, parentYamlRaw, 'utf8');
    const sourceManifest = {
      name: '@happier-dev/pkgroll-fixture',
      version: '0.0.0',
      main: './dist/index.cjs',
      module: './package-dist/index.mjs',
      dependencies: {
        '@happier-dev/protocol': '0.0.0',
        zod: '4.3.6',
      },
      devDependencies: {
        vitest: '3.2.4',
      },
      bundledDependencies: ['@happier-dev/protocol'],
      bin: {
        happier: './bin/happier.mjs',
      },
    };
    const sourceManifestRaw = `${JSON.stringify(sourceManifest, null, 2)}\n`;
    writeFileSync(fixture.packageJsonPath, sourceManifestRaw, 'utf8');
    let observedStageManifest: unknown = null;
    const spawn = vi.fn((_executable, _args, options) => {
      expect(options.cwd).toBe(realpathSync.native(fixture.stagingDir));
      observedStageManifest = JSON.parse(
        readFileSync(join(fixture.stagingDir, 'package.json'), 'utf8'),
      );
      expect(readFileSync(fixture.packageYamlPath, 'utf8')).toBe(parentYamlRaw);
      return { status: 0 };
    });

    try {
      runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        pkgrollCliPath: fixture.pkgrollCliPath,
        outputDir: fixture.outputDir,
        spawn,
      });

      expect(spawn.mock.calls[0]?.[1]).toEqual([
        fixture.pkgrollCliPath,
        '--packagejson=false',
        '--srcdist',
        '../src:.',
        '--input',
        'index.cjs',
        '--input',
        'index.mjs',
      ]);
      expect(observedStageManifest).toMatchObject({
        main: './index.cjs',
        module: './index.mjs',
        dependencies: { zod: '4.3.6' },
        devDependencies: {
          '@happier-dev/protocol': '0.0.0',
          vitest: '3.2.4',
        },
      });
      expect(observedStageManifest).not.toHaveProperty('bin');
      expect(readFileSync(fixture.packageJsonPath, 'utf8')).toBe(sourceManifestRaw);
      expect(readFileSync(fixture.packageYamlPath, 'utf8')).toBe(parentYamlRaw);
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(false);
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('removes the stage manifest after failure without mutating the source package', () => {
    const fixture = writeIsolatedPkgrollRepo('happier-dev-cli-pkgroll-stage-failure-');
    const spawn = vi.fn(() => {
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(true);
      expect(existsSync(fixture.packageYamlPath)).toBe(false);
      throw new Error('simulated pkgroll failure');
    });
    try {
      expect(() => runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        pkgrollCliPath: fixture.pkgrollCliPath,
        outputDir: fixture.outputDir,
        spawn,
      })).toThrow(/simulated pkgroll failure/);
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(false);
      expect(existsSync(fixture.packageYamlPath)).toBe(false);
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('leaves abrupt-termination residue only inside the builder-owned stage', async () => {
    const fixture = writeIsolatedPkgrollRepo('happier-dev-cli-pkgroll-stage-sigkill-');
    const wrapperModuleUrl = new URL('../runPkgrollBuild.mjs', import.meta.url).href;
    const childSource = `
const { runPkgrollBuild } = await import(${JSON.stringify(wrapperModuleUrl)});
runPkgrollBuild({
  packageJsonPath: ${JSON.stringify(fixture.packageJsonPath)},
  pkgrollCliPath: ${JSON.stringify(fixture.pkgrollCliPath)},
  outputDir: ${JSON.stringify(fixture.outputDir)},
  lockTimeoutMs: 5_000,
  lockPollIntervalMs: 10,
  lockStaleAfterMs: 5_000,
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

  it('includes the deferred Voice inference runtime in the real CLI package build inputs', () => {
    const manifest = JSON.parse(readFileSync(join(cliPackageRoot, 'package.json'), 'utf8'));

    expect(collectPkgrollInputPaths(manifest)).toContain(
      'dist/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.mjs',
    );
  });

  it('runs pkgroll with a package.json entrypoint filter without mutating the package manifest', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-manifest-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    const outputDir = 'dist.staging.filter';
    const original = {
      main: './dist/index.cjs',
      bin: {
        happier: './bin/happier.mjs',
      },
      exports: {
        '.': {
          import: {
            default: './package-dist/index.mjs',
          },
        },
      },
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');

    let manifestObservedByPkgroll: any = null;
    const spawn = vi.fn(() => {
      manifestObservedByPkgroll = JSON.parse(
        readFileSync(join(dir, outputDir, 'package.json'), 'utf8'),
      );
      return { status: 0 };
    });

    runPkgrollBuild({ cwd: dir, outputDir, pkgrollCliPath, spawn });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        pkgrollCliPath,
        '--packagejson=false',
        '--srcdist',
        '../src:.',
        '--input',
        'index.cjs',
        '--input',
        'index.mjs',
      ],
      expect.objectContaining({
        cwd: realpathSync.native(join(dir, outputDir)),
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: 600_000,
      }),
    );
    expect(manifestObservedByPkgroll).toMatchObject({
      main: './index.cjs',
      exports: {
        '.': {
          import: {
            default: './index.mjs',
          },
        },
      },
    });
    expect(manifestObservedByPkgroll).not.toHaveProperty('bin');
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(original);
    expect(existsSync(join(dir, outputDir, 'package.json'))).toBe(false);
  });

  it('fails fast with a clear error when the resolved pkgroll entrypoint is a shell shim without mutating the manifest', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-shell-shim-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-shell-shim.mjs');
    const original = {
      main: './package-dist/index.cjs',
      exports: {
        '.': {
          import: {
            default: './package-dist/index.mjs',
          },
        },
      },
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/bin/sh\nexec node "$0" "$@"\n', 'utf8');

    const spawn = vi.fn(() => ({ status: 0 }));

    expect(() =>
      runPkgrollBuild({
        cwd: dir,
        outputDir: 'dist.staging.shell-shim',
        pkgrollCliPath,
        spawn,
      }),
    ).toThrow(/expected a JavaScript entrypoint but found a shell wrapper/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(original);
  });

  it('fails when pkgroll is terminated by a signal instead of reporting a successful build', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-signal-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './dist/index.mjs' }, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');

    const spawn = vi.fn(() => ({ status: null, signal: 'SIGTERM' }));

    expect(() => runPkgrollBuild({
      cwd: dir,
      outputDir: 'dist.staging.signal',
      pkgrollCliPath,
      spawn,
    })).toThrow(
      /terminated by signal SIGTERM/i,
    );
  });

  it('applies bounded timeout override from environment for Windows stall protection', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-timeout-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './package-dist/index.mjs' }, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');

    const spawn = vi.fn(() => ({ status: 0 }));

    runPkgrollBuild({
      cwd: dir,
      outputDir: 'dist.staging.timeout',
      pkgrollCliPath,
      spawn,
      env: { HAPPIER_CLI_PKGROLL_TIMEOUT_MS: '120000' },
    });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        pkgrollCliPath,
        '--packagejson=false',
        '--srcdist',
        '../src:.',
        '--input',
        'index.mjs',
      ],
      expect.objectContaining({
        timeout: 120_000,
      }),
    );
  });

  it('gives pkgroll the canonical Node heap budget while preserving existing Node options', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-heap-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './dist/index.mjs' }, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');

    const spawn = vi.fn(() => ({ status: 0 }));

    runPkgrollBuild({
      cwd: dir,
      outputDir: 'dist.staging.heap',
      pkgrollCliPath,
      spawn,
      env: { NODE_OPTIONS: '--trace-warnings' },
    });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          NODE_OPTIONS: '--trace-warnings --max-old-space-size=12288',
        }),
      }),
    );
  });

  it('runs executable and declaration bundles in separate pkgroll processes', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-memory-boundaries-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    writeFileSync(packageJsonPath, `${JSON.stringify({
      main: './dist/index.cjs',
      module: './dist/index.mjs',
      types: './dist/index.d.cts',
      exports: {
        '.': {
          import: {
            types: './dist/index.d.mts',
            default: './dist/index.mjs',
          },
          require: {
            types: './dist/index.d.cts',
            default: './dist/index.cjs',
          },
        },
      },
    }, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');

    const spawn = vi.fn(() => ({ status: 0 }));

    runPkgrollBuild({
      cwd: dir,
      outputDir: 'dist.staging.memory-boundaries',
      pkgrollCliPath,
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    const invocations = spawn.mock.calls.map(([, args]) => args as string[]);
    expect(invocations).toContainEqual([
      pkgrollCliPath,
      '--packagejson=false',
      '--srcdist',
      '../src:.',
      '--input',
      'index.cjs',
      '--input',
      'index.mjs',
    ]);
    expect(invocations).toContainEqual([
      pkgrollCliPath,
      '--packagejson=false',
      '--srcdist',
      '../src:.',
      '--input',
      'index.d.cts',
      '--input',
      'index.d.mts',
    ]);
  });

  it('copies bundled first-party static assets into dist after pkgroll succeeds', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-static-assets-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    const outputDir = 'dist.staging.assets';
    const assetRelativePath = join(
      'src',
      'plugins',
      'projection',
      'registry',
      'static-assets',
      'happier.inspector',
      'dist',
      'happier-plugin-ui',
      'hosted-web',
      'inspector-app-web',
      'index.html',
    );
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './dist/index.mjs' }, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');
    mkdirSync(join(dir, assetRelativePath, '..'), { recursive: true });
    writeFileSync(join(dir, assetRelativePath), '<!doctype html>\n', 'utf8');

    const spawn = vi.fn(() => ({ status: 0 }));

    runPkgrollBuild({ cwd: dir, outputDir, pkgrollCliPath, spawn });

    expect(readFileSync(join(
      dir,
      outputDir,
      'plugins',
      'projection',
      'registry',
      'static-assets',
      'happier.inspector',
      'dist',
      'happier-plugin-ui',
      'hosted-web',
      'inspector-app-web',
      'index.html',
    ), 'utf8')).toBe('<!doctype html>\n');
  });

  it('stages built dist output into the stack-provided build output directory', () => {
    const dir = createTempDirSync('happier-cli-pkgroll-output-dir-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    const outputDir = '.tmp/stack-build';
    const assetRelativePath = join(
      'src',
      'plugins',
      'projection',
      'registry',
      'static-assets',
      'happier.inspector',
      'dist',
      'happier-plugin-ui',
      'hosted-web',
      'inspector-app-web',
      'index.html',
    );
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './dist/index.mjs' }, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');
    mkdirSync(join(dir, assetRelativePath, '..'), { recursive: true });
    writeFileSync(join(dir, assetRelativePath), '<!doctype html>\n', 'utf8');

    const spawn = vi.fn(() => {
      mkdirSync(join(dir, outputDir), { recursive: true });
      writeFileSync(join(dir, outputDir, 'index.mjs'), 'export const built = true;\n', 'utf8');
      return { status: 0 };
    });

    runPkgrollBuild({
      cwd: dir,
      outputDir,
      pkgrollCliPath,
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        pkgrollCliPath,
        '--packagejson=false',
        '--srcdist',
        '../../src:.',
        '--input',
        'index.mjs',
      ],
      expect.any(Object),
    );
    expect(readFileSync(join(dir, outputDir, 'index.mjs'), 'utf8')).toBe('export const built = true;\n');
    expect(readFileSync(join(
      dir,
      outputDir,
      'plugins',
      'projection',
      'registry',
      'static-assets',
      'happier.inspector',
      'dist',
      'happier-plugin-ui',
      'hosted-web',
      'inspector-app-web',
      'index.html',
    ), 'utf8')).toBe('<!doctype html>\n');
  });
});
