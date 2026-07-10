import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';
import { resolveBundledWorkspaceDependencyBuildOrder } from '../../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';
import {
  execYarn,
  resolveTscBin,
  resolveBundledWorkspaceTsconfigPath,
  resolveYarnInvocation,
  runTsc,
  readSourceDevSharedDepsWorkspaceNamesFromEnv,
  syncSharedDepsForSourceDev,
  syncBundledWorkspaceDist,
  syncBundledWorkspaceRuntimeDependencies,
  syncCliRuntimeDependencies,
  withBuildSharedDepsLock,
} from '../buildSharedDeps.mjs';
import {
  createPackageLayoutSandbox,
  writeCliBundledHostPackage,
  writeRuntimeDependencyStub,
} from './testkit/packageLayoutSandbox';

describe('buildSharedDeps', () => {
  it('surfaces which tsconfig failed when compilation throws', () => {
    const execFileSync = vi.fn(() => {
      throw new Error('tsc failed');
    });

    expect(() => runTsc('/repo/packages/protocol/tsconfig.json', { execFileSync })).toThrow(
      /tsconfig\.json/i,
    );
  });

  it('invokes the native TypeScript entrypoint through managed Node on Windows', () => {
    const execFileSync = vi.fn(() => undefined);

    runTsc('C:\\repo\\packages\\protocol\\tsconfig.json', {
      execFileSync,
      tscBin: 'C:\\repo\\node_modules\\@typescript\\native\\bin\\tsc',
      platform: 'win32',
    });

    expect(execFileSync).toHaveBeenCalled();
    const cmdCall = execFileSync.mock.calls[0] as unknown as [string, string[], { stdio: string }] | undefined;
    if (!cmdCall) throw new Error('expected execFileSync call');
    const [cmd, args, opts] = cmdCall;
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([
      'C:\\repo\\node_modules\\@typescript\\native\\bin\\tsc',
      '-p',
      'C:\\repo\\packages\\protocol\\tsconfig.json',
    ]);
    expect(opts).toEqual({ stdio: 'inherit' });
  });

  it('resolves the native TypeScript entrypoint from its package manifest', () => {
    const bin = resolveTscBin({
      requireResolve: (specifier: string) => {
        if (specifier === '@typescript/native/package.json') {
          return '/repo/node_modules/@typescript/native/package.json';
        }
        throw new Error(`unexpected specifier: ${specifier}`);
      },
      readFileSyncImpl: () => JSON.stringify({ bin: { tsc: './bin/tsc' } }),
    });

    expect(bin).toBe('/repo/node_modules/@typescript/native/bin/tsc');
  });

  it('falls back to yarn on PATH when npm_execpath points at npm-cli.js', () => {
    const invocation = resolveYarnInvocation('/somewhere/lib/node_modules/npm/bin/npm-cli.js');

    expect(invocation).toEqual({
      command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn',
      args: [],
    });
  });

  it('uses node + npm_execpath when npm_execpath points at a Yarn entrypoint', () => {
    const invocation = resolveYarnInvocation('/somewhere/lib/node_modules/yarn/bin/yarn.js');

    expect(invocation).toEqual({
      command: process.execPath,
      args: ['/somewhere/lib/node_modules/yarn/bin/yarn.js'],
    });
  });

  it('resolves plugin workspace tsconfig paths from packages/plugins/<pluginId>', () => {
    expect(resolveBundledWorkspaceTsconfigPath({ repoRoot: '/repo', workspaceName: 'plugins-acme' })).toBe(
      '/repo/packages/plugins/acme/tsconfig.json',
    );
  });

  it('orders bundled workspace builds so internal workspace dependencies compile first', () => {
    const repoRoot = createTempDirSync('happier-cli-build-shared-order-');
    try {
      mkdirSync(resolve(repoRoot, 'apps', 'cli'), { recursive: true });
      writeFileSync(
        resolve(repoRoot, 'apps', 'cli', 'package.json'),
        JSON.stringify(
          {
            bundledDependencies: [
              '@happier-dev/cli-common',
              '@happier-dev/release-runtime',
              '@happier-dev/agents',
              '@happier-dev/protocol',
            ],
          },
          null,
          2,
        ),
        'utf8',
      );

      const packageJsonByWorkspace: Record<string, Record<string, unknown>> = {
        protocol: {
          name: '@happier-dev/protocol',
        },
        agents: {
          name: '@happier-dev/agents',
          dependencies: {
            '@happier-dev/protocol': '0.0.0',
          },
        },
        'release-runtime': {
          name: '@happier-dev/release-runtime',
        },
        'cli-common': {
          name: '@happier-dev/cli-common',
          dependencies: {
            '@happier-dev/agents': '0.0.0',
            '@happier-dev/release-runtime': '0.0.0',
          },
        },
      };

      for (const [workspaceName, packageJson] of Object.entries(packageJsonByWorkspace)) {
        mkdirSync(resolve(repoRoot, 'packages', workspaceName), { recursive: true });
        writeFileSync(
          resolve(repoRoot, 'packages', workspaceName, 'package.json'),
          JSON.stringify(packageJson, null, 2),
          'utf8',
        );
        writeFileSync(resolve(repoRoot, 'packages', workspaceName, 'tsconfig.json'), '{}\n', 'utf8');
      }

      const ordered = resolveBundledWorkspaceDependencyBuildOrder({
        repoRoot,
        hostPackageDir: resolve(repoRoot, 'apps', 'cli'),
      });

      expect(ordered.indexOf('protocol')).toBeLessThan(ordered.indexOf('agents'));
      expect(ordered.indexOf('agents')).toBeLessThan(ordered.indexOf('cli-common'));
      expect(ordered.indexOf('release-runtime')).toBeLessThan(ordered.indexOf('cli-common'));
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('runs yarn.cmd through cmd.exe on Windows to avoid spawn EINVAL', () => {
    const execFileSync = vi.fn(() => undefined);

    execYarn(['-s', 'workspace', '@happier-dev/cli-common', 'build'], {
      execFileSync,
      npmExecPath: '/somewhere/lib/node_modules/npm/bin/npm-cli.js',
      platform: 'win32',
      cwd: 'C:\\repo',
      stdio: 'inherit',
    });

    const cmdCall = execFileSync.mock.calls[0] as
      | [string, string[], { cwd: string; stdio: string; windowsVerbatimArguments?: boolean }]
      | undefined;
    if (!cmdCall) throw new Error('expected execFileSync call');
    const [cmd, args, options] = cmdCall;
    expect(cmd).toBe('cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(String(args[3])).toContain('yarn.cmd');
    expect(String(args[3])).toContain('@happier-dev/cli-common');
    expect(options.cwd).toBe('C:\\repo');
    expect(options.stdio).toBe('inherit');
    expect(options.windowsVerbatimArguments).toBe(true);
  });

  it('executes the resolved native TypeScript entrypoint via Node', () => {
    const execFileSync = vi.fn(() => undefined);

    runTsc('/repo/packages/protocol/tsconfig.json', {
      execFileSync,
      tscBin: '/repo/node_modules/@typescript/native/bin/tsc',
      platform: 'darwin',
    });

    const nodeCall = execFileSync.mock.calls[0] as unknown as [string, string[]] | undefined;
    if (!nodeCall) throw new Error('expected execFileSync call');
    const [cmd, args] = nodeCall;
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(['/repo/node_modules/@typescript/native/bin/tsc', '-p', '/repo/packages/protocol/tsconfig.json']);
  });

  it('applies a timeout to the TypeScript child process when requested', () => {
    const execFileSync = vi.fn(() => undefined);

    runTsc('/repo/packages/protocol/tsconfig.json', {
      execFileSync,
      tscBin: '/repo/node_modules/@typescript/native/bin/tsc',
      platform: 'darwin',
      timeoutMs: 12_345,
    });

    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      ['/repo/node_modules/@typescript/native/bin/tsc', '-p', '/repo/packages/protocol/tsconfig.json'],
      { stdio: 'inherit', timeout: 12_345 },
    );
  });

  it('reads a targeted source-dev workspace list from the helper environment', () => {
    expect(readSourceDevSharedDepsWorkspaceNamesFromEnv({
      HAPPIER_SOURCE_DEV_SHARED_DEPS_WORKSPACES: ' plugins-opencode, @happier-dev/plugins-kiro ,, plugins-opencode ',
    })).toEqual([
      'plugins-opencode',
      'plugins-kiro',
    ]);
    expect(readSourceDevSharedDepsWorkspaceNamesFromEnv({})).toBeUndefined();
  });

  it('keeps the source dev sync preflight silent when cli-common dist helpers are missing', () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-silent-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const cliScriptsDir = resolve(cliDir, 'scripts');
      const workspaceScriptsDir = resolve(repoRoot, 'scripts', 'workspaces');
      mkdirSync(cliScriptsDir, { recursive: true });
      mkdirSync(workspaceScriptsDir, { recursive: true });
      mkdirSync(resolve(repoRoot, 'packages', 'cli-common'), { recursive: true });
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(
        resolve(cliDir, 'package.json'),
        JSON.stringify({
          name: '@happier-dev/cli',
          bundledDependencies: ['@happier-dev/cli-common'],
          dependencies: { tweetnacl: '1.0.0' },
        }),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'packages', 'cli-common', 'package.json'), '{"name":"@happier-dev/cli-common","type":"module"}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'packages', 'cli-common', 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl","main":"index.js"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'index.js'), 'module.exports = {};\n', 'utf8');

      writeFileSync(resolve(cliScriptsDir, 'buildSharedDeps.mjs'), readFileSync(resolve(process.cwd(), 'scripts', 'buildSharedDeps.mjs'), 'utf8'), 'utf8');
      writeFileSync(
        resolve(cliScriptsDir, 'optionalWorkspaceBundleLock.mjs'),
        readFileSync(resolve(process.cwd(), 'scripts', 'optionalWorkspaceBundleLock.mjs'), 'utf8'),
        'utf8',
      );
      writeFileSync(
        resolve(cliScriptsDir, 'syncSharedDepsForDev.mjs'),
        readFileSync(resolve(process.cwd(), 'scripts', 'syncSharedDepsForDev.mjs'), 'utf8'),
        'utf8',
      );
      writeFileSync(
        resolve(workspaceScriptsDir, 'execYarnCommand.mjs'),
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { resolve } from 'node:path';",
          "export function buildWindowsCmdShimInvocation(command, args) { return { command, args, windowsVerbatimArguments: false }; }",
          "export function resolveYarnInvocation() { return { command: 'yarn', args: [] }; }",
          'export function execYarn(args, options = {}) {',
          "  process.stdout.write('BUILD\\n');",
          "  const moduleDir = resolve(options.cwd, 'packages', 'cli-common', 'dist', 'workspaces');",
          '  mkdirSync(moduleDir, { recursive: true });',
          "  writeFileSync(resolve(moduleDir, 'index.js'), \"export function bundleInstalledPackageWithRuntimeDependencies() {}\\nexport function resolveWorkspaceBundlesFromPackageJson() { return []; }\\nexport function vendorBundledPackageRuntimeDependencies() {}\\n\");",
          '}',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(resolve(workspaceScriptsDir, 'prepareTypeScriptProjectBuild.mjs'), 'export function prepareTypeScriptProjectBuild() {}\n', 'utf8');
      writeFileSync(
        resolve(workspaceScriptsDir, 'resolveTypeScriptCliInvocation.mjs'),
        'export function resolveTypeScriptCliInvocation() { return { command: process.execPath, argsPrefix: [] }; }\n',
        'utf8',
      );
      writeFileSync(resolve(workspaceScriptsDir, 'syncBundledWorkspacePackages.mjs'), 'export function syncBundledWorkspacePackages() {}\nexport function vendorBundledPackageRuntimeDependenciesFallback() {}\n', 'utf8');
      writeFileSync(resolve(workspaceScriptsDir, 'resolveWorkspaceDependencyBuildOrder.mjs'), "export function resolveBundledWorkspaceDependencyBuildOrder() { return ['cli-common']; }\n", 'utf8');
      writeFileSync(
        resolve(workspaceScriptsDir, 'workspaceBundleLock.mjs'),
        [
          "import { resolve } from 'node:path';",
          "export function resolveWorkspaceBundleLockPath(repoRoot) { return resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'); }",
          'export async function withWorkspaceBundleLock(fn) { return await fn(); }',
          'export function withWorkspaceBundleLockSync(fn) { return fn(); }',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = spawnSync(process.execPath, [resolve(cliScriptsDir, 'syncSharedDepsForDev.mjs')], {
        cwd: cliDir,
        encoding: 'utf8',
      });

      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('keeps the source dev sync preflight from replacing existing bundled workspace dist directories', () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-presence-only-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const cliScriptsDir = resolve(cliDir, 'scripts');
      const workspaceScriptsDir = resolve(repoRoot, 'scripts', 'workspaces');
      mkdirSync(cliScriptsDir, { recursive: true });
      mkdirSync(workspaceScriptsDir, { recursive: true });
      mkdirSync(resolve(repoRoot, 'packages', 'cli-common'), { recursive: true });
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(
        resolve(cliDir, 'package.json'),
        JSON.stringify({
          name: '@happier-dev/cli',
          bundledDependencies: ['@happier-dev/cli-common'],
          dependencies: { tweetnacl: '1.0.0' },
        }),
        'utf8',
      );
      writeFileSync(resolve(repoRoot, 'packages', 'cli-common', 'package.json'), '{"name":"@happier-dev/cli-common","type":"module"}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'packages', 'cli-common', 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl","main":"index.js"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'index.js'), 'module.exports = {};\n', 'utf8');

      writeFileSync(resolve(cliScriptsDir, 'buildSharedDeps.mjs'), readFileSync(resolve(process.cwd(), 'scripts', 'buildSharedDeps.mjs'), 'utf8'), 'utf8');
      writeFileSync(
        resolve(cliScriptsDir, 'optionalWorkspaceBundleLock.mjs'),
        readFileSync(resolve(process.cwd(), 'scripts', 'optionalWorkspaceBundleLock.mjs'), 'utf8'),
        'utf8',
      );
      writeFileSync(
        resolve(cliScriptsDir, 'syncSharedDepsForDev.mjs'),
        readFileSync(resolve(process.cwd(), 'scripts', 'syncSharedDepsForDev.mjs'), 'utf8'),
        'utf8',
      );
      writeFileSync(
        resolve(workspaceScriptsDir, 'execYarnCommand.mjs'),
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { resolve } from 'node:path';",
          "export function buildWindowsCmdShimInvocation(command, args) { return { command, args, windowsVerbatimArguments: false }; }",
          "export function resolveYarnInvocation() { return { command: 'yarn', args: [] }; }",
          'export function execYarn(args, options = {}) {',
          "  const moduleDir = resolve(options.cwd, 'packages', 'cli-common', 'dist', 'workspaces');",
          '  mkdirSync(moduleDir, { recursive: true });',
          "  writeFileSync(resolve(moduleDir, 'index.js'), \"export function bundleInstalledPackageWithRuntimeDependencies() {}\\nexport function resolveWorkspaceBundlesFromPackageJson() { return []; }\\nexport function vendorBundledPackageRuntimeDependencies() {}\\n\");",
          '}',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(resolve(workspaceScriptsDir, 'prepareTypeScriptProjectBuild.mjs'), 'export function prepareTypeScriptProjectBuild() {}\n', 'utf8');
      writeFileSync(
        resolve(workspaceScriptsDir, 'resolveTypeScriptCliInvocation.mjs'),
        'export function resolveTypeScriptCliInvocation() { return { command: process.execPath, argsPrefix: [] }; }\n',
        'utf8',
      );
      writeFileSync(
        resolve(workspaceScriptsDir, 'syncBundledWorkspacePackages.mjs'),
        [
          'export function vendorBundledPackageRuntimeDependenciesFallback() {}',
          'export function syncBundledWorkspacePackages(options = {}) {',
          "  if (options.replaceExisting !== false) throw new Error('expected source dev preflight to preserve existing bundled dist directories');",
          '}',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(resolve(workspaceScriptsDir, 'resolveWorkspaceDependencyBuildOrder.mjs'), "export function resolveBundledWorkspaceDependencyBuildOrder() { return ['cli-common']; }\n", 'utf8');
      writeFileSync(
        resolve(workspaceScriptsDir, 'workspaceBundleLock.mjs'),
        [
          "import { resolve } from 'node:path';",
          "export function resolveWorkspaceBundleLockPath(repoRoot) { return resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock'); }",
          'export async function withWorkspaceBundleLock(fn) { return await fn(); }',
          'export function withWorkspaceBundleLockSync(fn) { return fn(); }',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = spawnSync(process.execPath, [resolve(cliScriptsDir, 'syncSharedDepsForDev.mjs')], {
        cwd: cliDir,
        encoding: 'utf8',
      });

      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('skips source dev shared-deps sync when bundled outputs already match the source signature', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-stamp-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'cli-common');
      const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', 'cli-common');
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'package.json'), '{"name":"@happier-dev/cli-common","type":"module"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'dist', 'index.js'), 'export const value = 1;\n', 'utf8');
      mkdirSync(resolve(sourcePackageDir, 'dist', 'nested'), { recursive: true });
      writeFileSync(resolve(sourcePackageDir, 'dist', 'nested', 'index.js'), 'export const nested = true;\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'dist', 'removed.js'), 'export const removed = true;\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');

      let lockCount = 0;
      const syncDist = vi.fn(() => {
        mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
        writeFileSync(resolve(destPackageDir, 'package.json'), '{"name":"@happier-dev/cli-common","type":"module"}\n', 'utf8');
        writeFileSync(
          resolve(destPackageDir, 'dist', 'index.js'),
          readFileSync(resolve(sourcePackageDir, 'dist', 'index.js'), 'utf8'),
          'utf8',
        );
        mkdirSync(resolve(destPackageDir, 'dist', 'nested'), { recursive: true });
        writeFileSync(
          resolve(destPackageDir, 'dist', 'nested', 'index.js'),
          readFileSync(resolve(sourcePackageDir, 'dist', 'nested', 'index.js'), 'utf8'),
          'utf8',
        );
        if (existsSync(resolve(sourcePackageDir, 'dist', 'removed.js'))) {
          writeFileSync(
            resolve(destPackageDir, 'dist', 'removed.js'),
            readFileSync(resolve(sourcePackageDir, 'dist', 'removed.js'), 'utf8'),
            'utf8',
          );
        }
      });
      const syncRuntimeDependencies = vi.fn(() => undefined);
      const syncCliDependencies = vi.fn(() => undefined);

      const runSync = () => syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['cli-common'],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => {
          lockCount += 1;
          return await fn();
        },
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: syncRuntimeDependencies,
        syncCliRuntimeDependenciesImpl: syncCliDependencies,
      });

      await runSync();
      await runSync();

      expect(lockCount).toBe(1);
      expect(syncDist).toHaveBeenCalledTimes(1);
      expect(syncRuntimeDependencies).toHaveBeenCalledTimes(1);
      expect(syncCliDependencies).toHaveBeenCalledTimes(1);

      writeFileSync(resolve(sourcePackageDir, 'dist', 'index.js'), 'export const value = 100;\n', 'utf8');

      await runSync();

      expect(lockCount).toBe(2);
      expect(syncDist).toHaveBeenCalledTimes(2);
      expect(syncRuntimeDependencies).toHaveBeenCalledTimes(2);
      expect(syncCliDependencies).toHaveBeenCalledTimes(2);

      rmSync(resolve(sourcePackageDir, 'dist', 'removed.js'));
      writeFileSync(resolve(sourcePackageDir, 'dist', 'index.js'), 'export const value = 200;\n', 'utf8');

      await runSync();

      expect(existsSync(resolve(destPackageDir, 'dist', 'removed.js'))).toBe(false);
      expect(lockCount).toBe(3);
      expect(syncDist).toHaveBeenCalledTimes(3);
      expect(syncRuntimeDependencies).toHaveBeenCalledTimes(3);
      expect(syncCliDependencies).toHaveBeenCalledTimes(3);

      await runSync();

      expect(lockCount).toBe(3);
      expect(syncDist).toHaveBeenCalledTimes(3);
      expect(syncRuntimeDependencies).toHaveBeenCalledTimes(3);
      expect(syncCliDependencies).toHaveBeenCalledTimes(3);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('keeps source dev current stamps target-specific across unrelated targeted syncs', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-target-stamps-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const opencodePackageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      const scmGitPackageDir = resolve(repoRoot, 'packages', 'plugins', 'scm-git');
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(opencodePackageDir, 'dist'), { recursive: true });
      mkdirSync(resolve(scmGitPackageDir, 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(opencodePackageDir, 'package.json'), '{"name":"@happier-dev/plugins-opencode","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n', 'utf8');
      writeFileSync(resolve(opencodePackageDir, 'dist', 'index.js'), 'export const opencode = true;\n', 'utf8');
      writeFileSync(resolve(scmGitPackageDir, 'package.json'), '{"name":"@happier-dev/plugins-scm-git","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n', 'utf8');
      writeFileSync(resolve(scmGitPackageDir, 'dist', 'index.js'), 'export const scmGit = true;\n', 'utf8');

      let lockCount = 0;
      const syncDist = vi.fn((opts?: { workspaceNames?: readonly string[] }) => {
        for (const workspaceName of opts?.workspaceNames ?? []) {
          const packageDir = workspaceName === 'plugins-opencode' ? opencodePackageDir : scmGitPackageDir;
          const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', workspaceName);
          mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
          writeFileSync(resolve(destPackageDir, 'package.json'), readFileSync(resolve(packageDir, 'package.json'), 'utf8'), 'utf8');
          writeFileSync(resolve(destPackageDir, 'dist', 'index.js'), readFileSync(resolve(packageDir, 'dist', 'index.js'), 'utf8'), 'utf8');
        }
      });

      const runSync = (workspaceName: string) => syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: [workspaceName],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => {
          lockCount += 1;
          return await fn();
        },
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      await runSync('plugins-opencode');
      await runSync('plugins-scm-git');
      const result = await runSync('plugins-opencode');

      expect(result).toEqual({ synced: false, reason: 'current' });
      expect(lockCount).toBe(2);
      expect(syncDist).toHaveBeenCalledTimes(2);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('treats a current superset source-dev stamp as current for targeted syncs', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-superset-stamp-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const opencodePackageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      const scmGitPackageDir = resolve(repoRoot, 'packages', 'plugins', 'scm-git');
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(opencodePackageDir, 'dist'), { recursive: true });
      mkdirSync(resolve(scmGitPackageDir, 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(opencodePackageDir, 'package.json'), '{"name":"@happier-dev/plugins-opencode","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n', 'utf8');
      writeFileSync(resolve(opencodePackageDir, 'dist', 'index.js'), 'export const opencode = true;\n', 'utf8');
      writeFileSync(resolve(scmGitPackageDir, 'package.json'), '{"name":"@happier-dev/plugins-scm-git","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n', 'utf8');
      writeFileSync(resolve(scmGitPackageDir, 'dist', 'index.js'), 'export const scmGit = true;\n', 'utf8');

      let lockCount = 0;
      const syncDist = vi.fn((opts?: { workspaceNames?: readonly string[] }) => {
        for (const workspaceName of opts?.workspaceNames ?? []) {
          const packageDir = workspaceName === 'plugins-opencode' ? opencodePackageDir : scmGitPackageDir;
          const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', workspaceName);
          mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
          writeFileSync(resolve(destPackageDir, 'package.json'), readFileSync(resolve(packageDir, 'package.json'), 'utf8'), 'utf8');
          writeFileSync(resolve(destPackageDir, 'dist', 'index.js'), readFileSync(resolve(packageDir, 'dist', 'index.js'), 'utf8'), 'utf8');
        }
      });

      const runSync = (workspaceNames: readonly string[]) => syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames,
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => {
          lockCount += 1;
          return await fn();
        },
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      await runSync(['plugins-opencode', 'plugins-scm-git']);
      const result = await runSync(['plugins-opencode']);

      expect(result).toEqual({ synced: false, reason: 'current' });
      expect(lockCount).toBe(1);
      expect(syncDist).toHaveBeenCalledTimes(1);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('trusts a current source-dev stamp after a successful no-output rebuild', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-stamp-current-after-build-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const packageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      const sourceDir = resolve(packageDir, 'src');
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(packageDir, 'dist'), { recursive: true });
      mkdirSync(sourceDir, { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(packageDir, 'package.json'), '{"name":"@happier-dev/plugins-opencode","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n', 'utf8');
      writeFileSync(resolve(packageDir, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
      writeFileSync(resolve(sourceDir, 'index.ts'), 'export const opencode = true;\n', 'utf8');
      writeFileSync(resolve(packageDir, 'dist', 'index.js'), 'export const opencode = true;\n', 'utf8');
      const oldOutputTime = new Date('2025-01-01T00:00:00.000Z');
      const newSourceTime = new Date('2025-01-02T00:00:00.000Z');
      utimesSync(resolve(packageDir, 'dist', 'index.js'), oldOutputTime, oldOutputTime);
      utimesSync(resolve(sourceDir, 'index.ts'), newSourceTime, newSourceTime);

      const runTsc = vi.fn();
      const syncDist = vi.fn((opts?: { workspaceNames?: readonly string[] }) => {
        for (const workspaceName of opts?.workspaceNames ?? []) {
          const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', workspaceName);
          mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
          writeFileSync(resolve(destPackageDir, 'package.json'), readFileSync(resolve(packageDir, 'package.json'), 'utf8'), 'utf8');
          writeFileSync(resolve(destPackageDir, 'dist', 'index.js'), readFileSync(resolve(packageDir, 'dist', 'index.js'), 'utf8'), 'utf8');
        }
      });
      const runSync = () => syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-opencode'],
        runTscImpl: runTsc,
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      await runSync();
      const result = await runSync();

      expect(result).toEqual({ synced: false, reason: 'current' });
      expect(runTsc).toHaveBeenCalledTimes(1);
      expect(syncDist).toHaveBeenCalledTimes(1);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('waits for the shared deps lock when outputs are current but another writer is active', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-current-active-lock-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', 'plugins-opencode');
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'package.json'), '{"name":"@happier-dev/plugins-opencode","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'dist', 'index.js'), 'export const opencode = true;\n', 'utf8');

      let lockCount = 0;
      const syncDist = vi.fn(() => {
        mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
        writeFileSync(resolve(destPackageDir, 'package.json'), readFileSync(resolve(sourcePackageDir, 'package.json'), 'utf8'), 'utf8');
        writeFileSync(resolve(destPackageDir, 'dist', 'index.js'), readFileSync(resolve(sourcePackageDir, 'dist', 'index.js'), 'utf8'), 'utf8');
      });

      const runSync = () => syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-opencode'],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => {
          lockCount += 1;
          return await fn();
        },
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      await runSync();
      mkdirSync(resolve(lockPath, '..'), { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), 'utf8');

      const result = await runSync();

      expect(result).toEqual({ synced: false, reason: 'current-after-lock' });
      expect(lockCount).toBe(2);
      expect(syncDist).toHaveBeenCalledTimes(1);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('compiles stale source-dev bundled workspace outputs before syncing them into the CLI runtime tree', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-stale-plugin-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', 'plugins-opencode');
      const sourceFilePath = resolve(sourcePackageDir, 'src', 'index.ts');
      const sourceDistPath = resolve(sourcePackageDir, 'dist', 'index.js');
      const destDistPath = resolve(destPackageDir, 'dist', 'index.js');
      const staleTime = new Date('2026-01-01T00:00:00.000Z');
      const freshSourceTime = new Date('2030-01-01T00:00:00.000Z');

      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'src'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'package.json'), '{"name":"@happier-dev/plugins-opencode","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(sourceFilePath, 'export const value = "fresh source";\n', 'utf8');
      writeFileSync(sourceDistPath, 'export const value = "stale dist";\n', 'utf8');
      utimesSync(sourceFilePath, freshSourceTime, freshSourceTime);
      utimesSync(sourceDistPath, staleTime, staleTime);

      const compileCalls: string[] = [];
      const syncDist = vi.fn(() => {
        mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
        writeFileSync(resolve(destPackageDir, 'package.json'), readFileSync(resolve(sourcePackageDir, 'package.json'), 'utf8'), 'utf8');
        writeFileSync(destDistPath, readFileSync(sourceDistPath, 'utf8'), 'utf8');
      });

      await syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-opencode'],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        runTscImpl: (tsconfigPath: string) => {
          compileCalls.push(tsconfigPath);
          writeFileSync(sourceDistPath, 'export const value = "compiled fresh dist";\n', 'utf8');
        },
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      expect(compileCalls).toEqual([resolve(sourcePackageDir, 'tsconfig.json')]);
      expect(syncDist).toHaveBeenCalledTimes(1);
      expect(readFileSync(destDistPath, 'utf8')).toContain('compiled fresh dist');
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('passes the targeted source-dev workspace closure to bundled dist and runtime dependency sync', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-targeted-closure-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const pluginSdkDir = resolve(repoRoot, 'packages', 'plugin-sdk');
      const openCodePackageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(pluginSdkDir, 'dist'), { recursive: true });
      mkdirSync(resolve(openCodePackageDir, 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(pluginSdkDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
      }), 'utf8');
      writeFileSync(resolve(pluginSdkDir, 'dist', 'index.js'), 'export const sdk = true;\n', 'utf8');
      writeFileSync(resolve(openCodePackageDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-opencode',
        type: 'module',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
        exports: { '.': { default: './dist/index.js' } },
      }), 'utf8');
      writeFileSync(resolve(openCodePackageDir, 'dist', 'index.js'), 'export const opencode = true;\n', 'utf8');

      const syncDist = vi.fn(() => undefined);
      const syncRuntimeDependencies = vi.fn(() => undefined);

      await syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-opencode'],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: syncRuntimeDependencies,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      const expectedWorkspaceNames = ['plugin-sdk', 'plugins-opencode'];
      expect(syncDist).toHaveBeenCalledWith(expect.objectContaining({
        workspaceNames: expectedWorkspaceNames,
      }));
      expect(syncRuntimeDependencies).toHaveBeenCalledWith(expect.objectContaining({
        workspaceNames: expectedWorkspaceNames,
      }));
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('reports bounded source-dev sync stages around lock wait and workspace dist builds', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-progress-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', 'plugins-opencode');
      const sourceFilePath = resolve(sourcePackageDir, 'src', 'index.ts');
      const sourceDistPath = resolve(sourcePackageDir, 'dist', 'index.js');
      const staleTime = new Date('2026-01-01T00:00:00.000Z');
      const freshSourceTime = new Date('2030-01-01T00:00:00.000Z');
      const progressEvents: Array<Record<string, unknown>> = [];

      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'src'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'package.json'), '{"name":"@happier-dev/plugins-opencode","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(sourceFilePath, 'export const value = "fresh source";\n', 'utf8');
      writeFileSync(sourceDistPath, 'export const value = "stale dist";\n', 'utf8');
      utimesSync(sourceFilePath, freshSourceTime, freshSourceTime);
      utimesSync(sourceDistPath, staleTime, staleTime);

      await syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-opencode'],
        reportProgress: (event: Record<string, unknown>) => {
          progressEvents.push(event);
        },
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        runTscImpl: (tsconfigPath: string) => {
          expect(tsconfigPath).toBe(resolve(sourcePackageDir, 'tsconfig.json'));
          writeFileSync(sourceDistPath, 'export const value = "compiled fresh dist";\n', 'utf8');
        },
        syncBundledWorkspaceDistImpl: () => {
          mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
          writeFileSync(resolve(destPackageDir, 'package.json'), readFileSync(resolve(sourcePackageDir, 'package.json'), 'utf8'), 'utf8');
          writeFileSync(resolve(destPackageDir, 'dist', 'index.js'), readFileSync(sourceDistPath, 'utf8'), 'utf8');
        },
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      expect(progressEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'workspace-lock', event: 'waiting' }),
        expect.objectContaining({ stage: 'workspace-lock', event: 'acquired' }),
        expect.objectContaining({
          stage: 'workspace-build',
          event: 'start',
          workspaceName: 'plugins-opencode',
          tsconfigPath: resolve(sourcePackageDir, 'tsconfig.json'),
        }),
        expect.objectContaining({
          stage: 'workspace-build',
          event: 'done',
          workspaceName: 'plugins-opencode',
        }),
        expect.objectContaining({ stage: 'bundled-dist-sync', event: 'start' }),
        expect.objectContaining({ stage: 'complete', event: 'done' }),
      ]));
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('applies the source-dev workspace build timeout to each stale workspace dist build', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-build-timeout-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', 'plugins-opencode');
      const sourceFilePath = resolve(sourcePackageDir, 'src', 'index.ts');
      const sourceDistPath = resolve(sourcePackageDir, 'dist', 'index.js');
      const staleTime = new Date('2026-01-01T00:00:00.000Z');
      const freshSourceTime = new Date('2030-01-01T00:00:00.000Z');

      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'src'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'package.json'), '{"name":"@happier-dev/plugins-opencode","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(sourceFilePath, 'export const value = "fresh source";\n', 'utf8');
      writeFileSync(sourceDistPath, 'export const value = "stale dist";\n', 'utf8');
      utimesSync(sourceFilePath, freshSourceTime, freshSourceTime);
      utimesSync(sourceDistPath, staleTime, staleTime);

      const runTscCalls: Array<{
        tsconfigPath: string;
        timeoutMs?: number;
      }> = [];
      const buildEvents: string[] = [];

      await syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-opencode'],
        workspaceBuildTimeoutMs: 12_345,
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        syncWorkspaceBundledDependenciesForBuildImpl: ({ workspaceName }: { workspaceName: string }) => {
          buildEvents.push(`sync:${workspaceName}`);
        },
        runTscImpl: (tsconfigPath: string, options?: { timeoutMs?: number }) => {
          buildEvents.push(`compile:${tsconfigPath}`);
          runTscCalls.push({
            tsconfigPath,
            timeoutMs: options?.timeoutMs,
          });
          writeFileSync(sourceDistPath, 'export const value = "compiled fresh dist";\n', 'utf8');
        },
        syncBundledWorkspaceDistImpl: () => {
          mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
          writeFileSync(resolve(destPackageDir, 'package.json'), readFileSync(resolve(sourcePackageDir, 'package.json'), 'utf8'), 'utf8');
          writeFileSync(resolve(destPackageDir, 'dist', 'index.js'), readFileSync(sourceDistPath, 'utf8'), 'utf8');
        },
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      expect(runTscCalls).toEqual([{
        tsconfigPath: resolve(sourcePackageDir, 'tsconfig.json'),
        timeoutMs: 12_345,
      }]);
      expect(buildEvents).toEqual([
        'sync:plugins-opencode',
        `compile:${resolve(sourcePackageDir, 'tsconfig.json')}`,
      ]);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('does not let newer TypeScript build metadata mask stale source-dev runtime outputs', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-tsbuildinfo-mask-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', 'plugins-opencode');
      const sourceFilePath = resolve(sourcePackageDir, 'src', 'index.ts');
      const sourceDistPath = resolve(sourcePackageDir, 'dist', 'index.js');
      const tsBuildInfoPath = resolve(sourcePackageDir, 'dist', '.tsbuildinfo');
      const staleTime = new Date('2026-01-01T00:00:00.000Z');
      const freshSourceTime = new Date('2030-01-01T00:00:00.000Z');
      const newerMetadataTime = new Date('2031-01-01T00:00:00.000Z');

      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'src'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'package.json'), '{"name":"@happier-dev/plugins-opencode","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(sourceFilePath, 'export const value = "fresh source";\n', 'utf8');
      writeFileSync(sourceDistPath, 'export const value = "stale dist";\n', 'utf8');
      writeFileSync(tsBuildInfoPath, '{"version":"newer metadata"}\n', 'utf8');
      utimesSync(sourceFilePath, freshSourceTime, freshSourceTime);
      utimesSync(sourceDistPath, staleTime, staleTime);
      utimesSync(tsBuildInfoPath, newerMetadataTime, newerMetadataTime);

      const compileCalls: string[] = [];

      await syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-opencode'],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        runTscImpl: (tsconfigPath: string) => {
          compileCalls.push(tsconfigPath);
          writeFileSync(sourceDistPath, 'export const value = "compiled fresh dist";\n', 'utf8');
        },
        syncBundledWorkspaceDistImpl: () => {
          mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
          writeFileSync(resolve(destPackageDir, 'package.json'), readFileSync(resolve(sourcePackageDir, 'package.json'), 'utf8'), 'utf8');
          writeFileSync(resolve(destPackageDir, 'dist', 'index.js'), readFileSync(sourceDistPath, 'utf8'), 'utf8');
        },
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      expect(compileCalls).toEqual([resolve(sourcePackageDir, 'tsconfig.json')]);
      expect(readFileSync(resolve(destPackageDir, 'dist', 'index.js'), 'utf8')).toContain('compiled fresh dist');
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('clears stale incremental metadata before compiling a missing output directory', () => {
    const execFileSync = vi.fn(() => undefined);
    const rmSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) => {
      const path = String(p);
      return path === '/repo/packages/plugin-sdk/tsconfig.json'
        || path === '/repo/packages/plugin-sdk/.tsbuildinfo';
    });
    const readFileSync = vi.fn((p: any) => {
      if (String(p) === '/repo/packages/plugin-sdk/tsconfig.json') {
        return JSON.stringify({
          compilerOptions: {
            outDir: 'dist',
            incremental: true,
            tsBuildInfoFile: '.tsbuildinfo',
          },
        });
      }
      throw new Error(`unexpected read: ${p}`);
    });

    runTsc('/repo/packages/plugin-sdk/tsconfig.json', {
      execFileSync,
      existsSync,
      readFileSync,
      rmSync,
      tscBin: '/repo/node_modules/@typescript/native/bin/tsc',
      platform: 'darwin',
    });

    expect(rmSync).toHaveBeenCalledWith('/repo/packages/plugin-sdk/.tsbuildinfo', { force: true });
    expect(execFileSync).toHaveBeenCalled();
  });

  it('syncs workspace dist outputs into bundled deps for local bundled hosts when present', () => {
    const cpSync = vi.fn(() => undefined);
    const rmSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) =>
      String(p).endsWith('/apps/cli/package.json') ||
      String(p).endsWith('/packages/protocol/package.json') ||
      String(p).endsWith('/packages/protocol/dist') ||
      String(p).includes('/apps/cli/node_modules/@happier-dev/protocol/'),
    );
    const mkdirSync = vi.fn(() => undefined);
    const readFileSync = vi.fn((p: any) => {
      const text = String(p);
      if (text.endsWith('/apps/cli/package.json')) {
        return JSON.stringify({
          bundledDependencies: ['@happier-dev/protocol'],
        });
      }
      if (text.endsWith('/packages/protocol/package.json')) {
        return JSON.stringify({
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        });
      }
      throw new Error(`unexpected read: ${text}`);
    });

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      mkdirSync,
      rmSync,
      readFileSync,
    });

    expect(mkdirSync.mock.calls).toEqual([
      ['/repo/apps/cli/node_modules/@happier-dev/protocol', { recursive: true }],
      ['/repo/apps/cli/node_modules/@happier-dev/protocol', { recursive: true }],
    ]);
    expect(rmSync).toHaveBeenCalled();
    expect(cpSync).toHaveBeenCalledTimes(1);
    const copyCalls = cpSync.mock.calls as unknown[];
    expect(
      copyCalls.some((call) => {
        if (!Array.isArray(call) || call.length < 3) return false;
        const [from, to, options] = call as [unknown, unknown, { recursive?: boolean; force?: boolean }];
        return from === '/repo/packages/protocol/dist'
          && typeof to === 'string'
          && to.includes('/apps/cli/node_modules/@happier-dev/protocol/')
          && options.recursive === true
          && options.force === true;
      }),
    ).toBe(true);
    expect(copyCalls.some((call) => Array.isArray(call) && String(call[1]).includes('/apps/stack/'))).toBe(false);
  });

  it('syncs only explicitly targeted bundled workspace dist outputs when workspace names are supplied', () => {
    const cpSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) =>
      String(p).endsWith('/packages/plugins/opencode/package.json') ||
      String(p).endsWith('/packages/plugins/opencode/dist') ||
      String(p).includes('/apps/cli/node_modules/@happier-dev/plugins-opencode/'),
    );
    const mkdirSync = vi.fn(() => undefined);
    const rmSync = vi.fn(() => undefined);
    const readFileSync = vi.fn((p: any) => {
      const text = String(p);
      if (text.endsWith('/packages/plugins/opencode/package.json')) {
        return JSON.stringify({
          name: '@happier-dev/plugins-opencode',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        });
      }
      throw new Error(`unexpected read: ${text}`);
    });
    const writeFileSync = vi.fn(() => undefined);

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      workspaceNames: ['plugins-opencode'],
      cpSync,
      existsSync,
      mkdirSync,
      rmSync,
      readFileSync,
      writeFileSync,
    });

    expect(cpSync).toHaveBeenCalledTimes(1);
    expect(cpSync.mock.calls[0]?.[0]).toBe('/repo/packages/plugins/opencode/dist');
  });

  it('vendors runtime dependencies only for explicitly targeted bundled workspaces', () => {
    const vendorBundledPackageRuntimeDependencies = vi.fn(() => undefined);

    syncBundledWorkspaceRuntimeDependencies({
      repoRoot: '/repo',
      workspaceNames: ['plugins-opencode'],
      resolveWorkspaceBundlesFromPackageJson: () => [
        {
          packageName: '@happier-dev/plugins-codex',
          srcDir: '/repo/packages/plugins/codex',
          destDir: '/repo/apps/cli/node_modules/@happier-dev/plugins-codex',
        },
        {
          packageName: '@happier-dev/plugins-opencode',
          srcDir: '/repo/packages/plugins/opencode',
          destDir: '/repo/apps/cli/node_modules/@happier-dev/plugins-opencode',
        },
      ],
      vendorBundledPackageRuntimeDependencies,
    });

    expect(vendorBundledPackageRuntimeDependencies).toHaveBeenCalledTimes(1);
    expect(vendorBundledPackageRuntimeDependencies).toHaveBeenCalledWith({
      srcPackageJsonPath: '/repo/packages/plugins/opencode/package.json',
      destPackageDir: '/repo/apps/cli/node_modules/@happier-dev/plugins-opencode',
    });
  });

  it('syncs bundled workspace package.json exports for local bundled hosts', () => {
    const cpSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) =>
      String(p).endsWith('/apps/cli/package.json') ||
      String(p).endsWith('/packages/protocol/package.json') ||
      String(p).includes('/apps/cli/node_modules/@happier-dev/protocol/dist') ||
      String(p).includes('/apps/stack/node_modules/@happier-dev/protocol/dist'),
    );
    const readFileSync = vi.fn((p: any) => {
      const text = String(p);
      if (text.endsWith('/apps/cli/package.json')) {
        return JSON.stringify({
          bundledDependencies: ['@happier-dev/protocol'],
        });
      }

      return JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { default: './dist/index.js' }, './installables': { default: './dist/installables.js' } },
        dependencies: { zod: '1.0.0' },
      });
    });
    const writeFileSync = vi.fn(() => undefined);
    const mkdirSync = vi.fn(() => undefined);

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      mkdirSync,
      readFileSync,
      writeFileSync,
    });

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const cliWriteCall = writeFileSync.mock.calls[0] as unknown as [string, string] | undefined;
    if (!cliWriteCall) throw new Error('expected cli package.json write');
    const [cliDestPath, cliPayload] = cliWriteCall;
    expect(cliDestPath).toBe('/repo/apps/cli/node_modules/@happier-dev/protocol/package.json');
    const cliParsed = JSON.parse(String(cliPayload));
    expect(cliParsed.exports?.['./installables']).toBeTruthy();
    expect(cliParsed.private).toBe(true);
  });

  it('derives the default bundled workspace sync set from the CLI manifest', () => {
    const cpSync = vi.fn(() => undefined);
    const existsSync = vi.fn((p: any) => {
      const text = String(p);
      return (
        text.endsWith('/apps/cli/package.json') ||
        text.endsWith('/packages/custom-bundle/package.json') ||
        text.endsWith('/packages/custom-bundle/dist') ||
        text.endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/package.json') ||
        text.endsWith('/apps/cli/node_modules/@happier-dev/custom-bundle/dist')
      );
    });
    const mkdirSync = vi.fn(() => undefined);
    const rmSync = vi.fn(() => undefined);
    const readFileSync = vi.fn((p: any) => {
      const text = String(p);
      if (text.endsWith('/apps/cli/package.json')) {
        return JSON.stringify({
          bundledDependencies: ['@happier-dev/custom-bundle', 'tweetnacl'],
        });
      }
      if (text.endsWith('/packages/custom-bundle/package.json')) {
        return JSON.stringify({
          name: '@happier-dev/custom-bundle',
          version: '0.0.0',
          type: 'module',
          exports: { '.': { default: './dist/index.js' } },
        });
      }
      throw new Error(`unexpected read: ${text}`);
    });
    const writeFileSync = vi.fn(() => undefined);

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cpSync,
      existsSync,
      mkdirSync,
      rmSync,
      readFileSync,
      writeFileSync,
    });

    const calls = cpSync.mock.calls as unknown[];
    expect(
      calls.some((call) => {
        if (!Array.isArray(call) || call.length < 3) return false;
        const [from, to, options] = call as [unknown, unknown, { recursive?: boolean; force?: boolean }];
        return from === '/repo/packages/custom-bundle/dist'
          && typeof to === 'string'
          && to.includes('/apps/cli/node_modules/@happier-dev/custom-bundle/')
          && options.recursive === true
          && options.force === true;
      }),
    ).toBe(true);
  });

  it('bundles tweetnacl into the CLI publish tree for packaged installs', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-build-shared-runtime-');

    try {
      writeRuntimeDependencyStub({
        repoRoot,
        packageName: 'tweetnacl',
        manifestOverrides: {
          version: '1.0.3',
          main: 'nacl-fast.js',
        },
        files: {
          'nacl-fast.js': 'module.exports = {};\n',
        },
      });
      writeCliBundledHostPackage({
        happyCliDir,
        dependencies: {
          tweetnacl: '^1.0.3',
        },
      });

      syncCliRuntimeDependencies({ repoRoot });

      expect(existsSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'tweetnacl', 'package.json'))).toBe(true);
      expect(existsSync(resolve(repoRoot, 'apps', 'cli', 'node_modules', 'tweetnacl', 'nacl-fast.js'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('serializes concurrent shared-deps builds through a single lock', async () => {
    const rootDir = createTempDirSync('happy-build-shared-lock-');
    try {
      const lockPath = resolve(rootDir, 'cli-shared-deps-build.lock');
      const events: string[] = [];
      let releaseFirst: (() => void) | null = null;

      const first = withBuildSharedDepsLock(async () => {
        events.push('first:start');
        await new Promise<void>((resolvePromise) => {
          releaseFirst = resolvePromise;
        });
        events.push('first:end');
      }, {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(['first:start']);

      const second = withBuildSharedDepsLock(async () => {
        events.push('second:start');
      }, {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(['first:start']);

      releaseFirst?.();
      await Promise.all([first, second]);

      expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    } finally {
      removeTempDirSync(rootDir);
    }
  });
});
