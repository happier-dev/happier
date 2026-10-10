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
import { createRequire } from 'node:module';
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

async function runPhysicalPackageAlias(aliasKind: 'directory' | 'file') {
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
    await runPkgrollBuild({
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
  it('emits public declarations with the real pkgroll compiler during publication', async () => {
    const fixture = writeIsolatedPkgrollRepo('happier-cli-pkgroll-public-types-');
    try {
      writeFileSync(fixture.packageJsonPath, JSON.stringify({
        name: '@happier-dev/pkgroll-fixture', version: '0.0.0',
        main: './dist/index.cjs', module: './dist/index.mjs', types: './dist/index.d.cts',
      }));
      mkdirSync(join(fixture.packageRoot, 'src'));
      mkdirSync(join(fixture.packageRoot, 'node_modules'));
      // Pkgroll resolves its optional TypeScript API peer from this package.
      symlinkSync(dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
        join(fixture.packageRoot, 'node_modules', 'typescript'), process.platform === 'win32' ? 'junction' : 'dir');
      writeFileSync(join(fixture.packageRoot, 'src', 'index.ts'), 'export const runtime: string = "public";\n');
      writeFileSync(join(fixture.packageRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, types: [], skipLibCheck: true },
        include: ['src/index.ts'],
      }));
      await runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        outputDir: fixture.outputDir,
        env: { ...process.env, HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime', npm_lifecycle_event: 'prepack' },
      });
      expect(readFileSync(join(fixture.stagingDir, 'index.d.cts'), 'utf8')).toContain('runtime: string');
      expect(existsSync(join(fixture.stagingDir, 'index.cjs'))).toBe(true);
      expect(existsSync(join(fixture.stagingDir, 'index.mjs'))).toBe(true);
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('converges a directory symlink or junction alias on the physical package stage', async () => {
    await runPhysicalPackageAlias('directory');
  }, 20_000);

  it.skipIf(process.platform === 'win32')(
    'converges a file symlink alias on the physical package stage',
    async () => {
      await runPhysicalPackageAlias('file');
    },
    20_000,
  );

  it('fails on a missing physical package manifest before any build work', async () => {
    const fixture = writeIsolatedPkgrollRepo('happier-dev-cli-pkgroll-missing-manifest-');
    rmSync(fixture.packageJsonPath);
    try {
      await expect(runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        pkgrollCliPath: fixture.pkgrollCliPath,
        outputDir: fixture.outputDir,
        spawn: vi.fn(() => ({ status: 0 })),
      })).rejects.toThrow(/ENOENT|no such file or directory/i);
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('requires an explicit relative builder-owned output directory', async () => {
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
        await expect(runPkgrollBuild({
          packageJsonPath: fixture.packageJsonPath,
          pkgrollCliPath: fixture.pkgrollCliPath,
          outputDir,
          spawn,
        })).rejects.toThrow(/explicit relative builder-owned output directory/);
      }
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('uses a transformed stage-owned manifest while preserving parent manifests', async () => {
    const fixture = writeIsolatedPkgrollRepo('happier-dev-cli-pkgroll-stage-manifest-');
    const parentYamlRaw = 'name: user-authored-parent-manifest\ncustom: preserve-exactly\n';
    writeFileSync(fixture.packageYamlPath, parentYamlRaw, 'utf8');
    const sourceManifest = {
      name: '@happier-dev/pkgroll-fixture',
      version: '0.0.0',
      main: './dist/index.cjs',
      module: './package-dist/index.mjs',
      dependencies: {
        '@happier-dev/agents': '0.0.0',
        '@happier-dev/plugin-sdk': '0.0.0',
        '@happier-dev/protocol': '0.0.0',
        zod: '4.3.6',
      },
      devDependencies: {
        vitest: '3.2.4',
      },
      bundledDependencies: ['@happier-dev/agents', '@happier-dev/plugin-sdk', '@happier-dev/protocol'],
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
      await runPkgrollBuild({
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
      // Bundled internals are inlined, except the packages bundled plugins
      // import from the packaged closure at runtime: inlining those gives the
      // host a second module instance of the whole protocol schema graph.
      expect(observedStageManifest).toMatchObject({
        main: './index.cjs',
        module: './index.mjs',
        dependencies: {
          '@happier-dev/plugin-sdk': '0.0.0',
          '@happier-dev/protocol': '0.0.0',
          zod: '4.3.6',
        },
        devDependencies: {
          '@happier-dev/agents': '0.0.0',
          vitest: '3.2.4',
        },
      });
      expect(Object.keys((observedStageManifest as { devDependencies: object }).devDependencies))
        .not.toContain('@happier-dev/protocol');
      expect(observedStageManifest).not.toHaveProperty('bin');
      expect(readFileSync(fixture.packageJsonPath, 'utf8')).toBe(sourceManifestRaw);
      expect(readFileSync(fixture.packageYamlPath, 'utf8')).toBe(parentYamlRaw);
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(false);
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('removes the stage manifest after failure without mutating the source package', async () => {
    const fixture = writeIsolatedPkgrollRepo('happier-dev-cli-pkgroll-stage-failure-');
    const spawn = vi.fn(() => {
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(true);
      expect(existsSync(fixture.packageYamlPath)).toBe(false);
      throw new Error('simulated pkgroll failure');
    });
    try {
      await expect(runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        pkgrollCliPath: fixture.pkgrollCliPath,
        outputDir: fixture.outputDir,
        spawn,
      })).rejects.toThrow(/simulated pkgroll failure/);
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
await runPkgrollBuild({
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

  it('includes the deferred Voice inference runtime in the real CLI package build inputs', async () => {
    const manifest = JSON.parse(readFileSync(join(cliPackageRoot, 'package.json'), 'utf8'));

    expect(collectPkgrollInputPaths(manifest)).toContain(
      'dist/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.mjs',
    );
  });

  it('runs pkgroll with a package.json entrypoint filter without mutating the package manifest', async () => {
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

    await runPkgrollBuild({ cwd: dir, outputDir, pkgrollCliPath, spawn, env: {} });

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
      }),
    );
    expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty('timeout');
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

  it('fails fast with a clear error when the resolved pkgroll entrypoint is a shell shim without mutating the manifest', async () => {
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

    await expect(
      runPkgrollBuild({
        cwd: dir,
        outputDir: 'dist.staging.shell-shim',
        pkgrollCliPath,
        spawn,
      }),
    ).rejects.toThrow(/expected a JavaScript entrypoint but found a shell wrapper/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual(original);
  });

  it('fails when pkgroll is terminated by a signal instead of reporting a successful build', async () => {
    const dir = createTempDirSync('happier-cli-pkgroll-signal-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './dist/index.mjs' }, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');

    const spawn = vi.fn(() => ({ status: null, signal: 'SIGTERM' }));

    await expect(runPkgrollBuild({
      cwd: dir,
      outputDir: 'dist.staging.signal',
      pkgrollCliPath,
      spawn,
    })).rejects.toThrow(
      /terminated by signal SIGTERM/i,
    );
  });

  it.each([
    { timeoutMs: 1, env: {}, expected: 1 },
    { timeoutMs: 3_600_000, env: {}, expected: 3_600_000 },
    { env: { HAPPIER_CLI_PKGROLL_TIMEOUT_MS: '1' }, expected: 1 },
    { env: { HAPPIER_CLI_PKGROLL_TIMEOUT_MS: '3600000' }, expected: 3_600_000 },
  ])('preserves the configured operator budget $expected without clamping', async ({ timeoutMs, env, expected }) => {
    const dir = createTempDirSync('happier-cli-pkgroll-timeout-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './package-dist/index.mjs' }, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');

    const spawn = vi.fn(() => ({ status: 0 }));

    await runPkgrollBuild({
      cwd: dir,
      outputDir: 'dist.staging.timeout',
      pkgrollCliPath,
      spawn,
      timeoutMs,
      env,
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
        timeout: expected,
      }),
    );
  });

  it('rejects an operator budget that would overflow the subprocess timer instead of shortening it', async () => {
    const fixture = writeIsolatedPkgrollRepo('happier-cli-pkgroll-timer-range-');
    const spawn = vi.fn(() => ({ status: 0 }));
    try {
      await expect(runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        outputDir: fixture.outputDir,
        pkgrollCliPath: fixture.pkgrollCliPath,
        timeoutMs: 2_147_483_648,
        spawn,
      })).rejects.toThrow(/timer.*2147483647/i);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('reports a configured operator deadline without losing cleanup of the stage manifest', async () => {
    const fixture = writeIsolatedPkgrollRepo('happier-cli-pkgroll-operator-deadline-');
    const spawn = vi.fn(() => ({ error: Object.assign(new Error('boundary deadline'), { code: 'ETIMEDOUT' }) }));
    try {
      await expect(runPkgrollBuild({
        packageJsonPath: fixture.packageJsonPath,
        outputDir: fixture.outputDir,
        pkgrollCliPath: fixture.pkgrollCliPath,
        timeoutMs: 1,
        spawn,
      })).rejects.toThrow('pkgroll timed out after 1ms');
      expect(existsSync(join(fixture.stagingDir, 'package.json'))).toBe(false);
    } finally {
      rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
  });

  it('gives pkgroll the canonical Node heap budget while preserving existing Node options', async () => {
    const dir = createTempDirSync('happier-cli-pkgroll-heap-');
    const packageJsonPath = join(dir, 'package.json');
    const pkgrollCliPath = join(dir, 'pkgroll-cli.mjs');
    writeFileSync(packageJsonPath, `${JSON.stringify({ main: './dist/index.mjs' }, null, 2)}\n`, 'utf8');
    writeFileSync(pkgrollCliPath, '#!/usr/bin/env node\nconsole.log("pkgroll");\n', 'utf8');

    const spawn = vi.fn(() => ({ status: 0 }));

    await runPkgrollBuild({
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

  it('runs executable and declaration bundles in separate pkgroll processes', async () => {
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

    await runPkgrollBuild({
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

  it('copies bundled first-party static assets into dist after pkgroll succeeds', async () => {
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

    await runPkgrollBuild({ cwd: dir, outputDir, pkgrollCliPath, spawn });

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

  it('stages built dist output into the stack-provided build output directory', async () => {
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

    await runPkgrollBuild({
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
