import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';
import { resolveBundledWorkspaceDependencyBuildOrder } from '../../../../scripts/workspaces/resolveWorkspaceDependencyBuildOrder.mjs';
import {
  resolveBundledWorkspaceTsconfigPath,
  readSourceDevSharedDepsWorkspaceNamesFromArgv,
  readSourceDevSharedDepsWorkspaceNamesFromEnv,
  syncSharedDepsForSourceDev,
  syncBundledWorkspaceDist,
  syncBundledWorkspaceRuntimeDependencies,
  syncCliRuntimeDependencies,
  withBuildSharedDepsLock,
  buildBundledWorkspaceDependenciesForCli,
  computeSourceDevSharedDepsSignature,
  inspectSourceDevSharedDepsForSourceDev,
  main,
  publishSourceDevReadinessAfterRuntimeBuild,
  resolveCliCommonWorkspacesHelpersAfterBuild,
} from '../buildSharedDeps.mjs';
import {
  createPackageLayoutSandbox,
  writeCliBundledHostPackage,
  writeRuntimeDependencyStub,
} from './testkit/packageLayoutSandbox';

const cliScriptsSourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceScriptsSourceDir = resolve(cliScriptsSourceDir, '..', '..', '..', 'scripts', 'workspaces');
const sourceRepoRoot = resolve(cliScriptsSourceDir, '..', '..', '..');

function materializeWorkspaceRuntimeDependencyOwner(repoRoot: string): void {
  const cliCommonDir = resolve(repoRoot, 'packages', 'cli-common');
  mkdirSync(cliCommonDir, { recursive: true });
  cpSync(
    resolve(sourceRepoRoot, 'packages', 'cli-common', 'workspaceRuntimeDependencies.mjs'),
    resolve(cliCommonDir, 'workspaceRuntimeDependencies.mjs'),
  );
  cpSync(
    resolve(sourceRepoRoot, 'packages', 'cli-common', 'workspaceChildBuildEnv.mjs'),
    resolve(cliCommonDir, 'workspaceChildBuildEnv.mjs'),
  );
  mkdirSync(resolve(repoRoot, 'node_modules'), { recursive: true });
  cpSync(
    resolve(sourceRepoRoot, 'node_modules', 'semver'),
    resolve(repoRoot, 'node_modules', 'semver'),
    { recursive: true },
  );
}

function materializeCliCommonWorkspacesLoader(repoRoot: string): void {
  cpSync(
    resolve(workspaceScriptsSourceDir, 'loadCliCommonWorkspacesModule.mjs'),
    resolve(repoRoot, 'scripts', 'workspaces', 'loadCliCommonWorkspacesModule.mjs'),
  );
}

function createWorkspaceBuildOwner(
  buildPackage: (context: {
    repoRoot: string;
    packageName: string;
    workspaceName: string;
    timeoutMs?: number | null;
  }) => void | Promise<void>,
) {
  return async (
    repoRoot: string,
    packageNames: string[],
    options: {
      beforePackageBuild?: (context: { packageName: string; packageDir: string }) => void | Promise<void>;
      onPackageBuildStart?: (context: { packageName: string; packageDir: string }) => void | Promise<void>;
      onPackageBuildDone?: (context: { packageName: string; packageDir: string }) => void | Promise<void>;
      timeoutMs?: number | null;
    } = {},
  ) => {
    const built: string[] = [];
    for (const packageName of packageNames) {
      const workspaceName = packageName.replace(/^@happier-dev\//, '');
      const packageDir = workspaceName.startsWith('plugins-')
        ? resolve(repoRoot, 'packages', 'plugins', workspaceName.slice('plugins-'.length))
        : resolve(repoRoot, 'packages', workspaceName);
      await options.beforePackageBuild?.({ packageName, packageDir });
      await options.onPackageBuildStart?.({ packageName, packageDir });
      await buildPackage({
        repoRoot,
        packageName,
        workspaceName,
        timeoutMs: options.timeoutMs,
      });
      await options.onPackageBuildDone?.({ packageName, packageDir });
      built.push(packageName);
    }
    return { ok: true, built, skipped: [] };
  };
}

describe('buildSharedDeps', () => {
  it('routes declaration admission through the stale-aware source owner without runtime materialization', async () => {
    const syncDeclarations = vi.fn(async () => ({ synced: false, reason: 'current' }));
    const fullRuntimeLock = vi.fn(async () => {
      throw new Error('full runtime materialization must not run');
    });

    await expect(main({
      mode: 'declarations',
      syncSharedDepsForSourceDevImpl: syncDeclarations,
      withBuildSharedDepsLockImpl: fullRuntimeLock,
    })).resolves.toEqual({ synced: false, reason: 'current' });
    expect(syncDeclarations).toHaveBeenCalledOnce();
    expect(syncDeclarations).toHaveBeenCalledWith(expect.objectContaining({ includeRuntimeDependencies: false }));
    expect(fullRuntimeLock).not.toHaveBeenCalled();
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

  it('keeps test-only workspace dependencies out of default CLI build and publication selection', async () => {
    const repoRoot = createTempDirSync('happier-cli-runtime-only-shared-deps-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const protocolDir = resolve(repoRoot, 'packages', 'protocol');
      const piDir = resolve(repoRoot, 'packages', 'plugins', 'pi');
      const testsDir = resolve(repoRoot, 'packages', 'tests');
      for (const packageDir of [cliDir, protocolDir, piDir, testsDir]) {
        mkdirSync(resolve(packageDir, 'src'), { recursive: true });
      }
      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({
        private: true,
        workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'],
      }), 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: ['@happier-dev/plugins-pi'],
      }), 'utf8');
      writeFileSync(resolve(protocolDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/protocol',
        exports: { '.': './dist/index.js' },
      }), 'utf8');
      writeFileSync(resolve(piDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-pi',
        exports: { '.': './dist/index.js' },
        dependencies: { '@happier-dev/protocol': '0.0.0' },
        devDependencies: { '@happier-dev/tests': '0.0.0' },
      }), 'utf8');
      writeFileSync(resolve(testsDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/tests',
        private: true,
        exports: {
          './testkit/tls/ephemeralTlsServerFixture':
            './src/testkit/tls/ephemeralTlsServerFixture.mjs',
        },
      }), 'utf8');
      for (const packageDir of [protocolDir, piDir, testsDir]) {
        writeFileSync(resolve(packageDir, 'tsconfig.json'), '{}\n', 'utf8');
        writeFileSync(resolve(packageDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
      }

      const buildSelections: string[][] = [];
      const publicationSelections: string[][] = [];
      await syncSharedDepsForSourceDev({
        repoRoot,
        includeRuntimeDependencies: false,
        stampPath: resolve(repoRoot, '.project', 'tmp', 'runtime-only-stamp.json'),
        withBuildSharedDepsLockImpl: async (run: () => Promise<unknown>) => await run(),
        ensureWorkspacePackagesBuiltByNameImpl: async (
          _root: string,
          packageNames: string[],
          options: { includeDevDependencies?: boolean },
        ) => {
          buildSelections.push(packageNames);
          expect(options.includeDevDependencies).toBe(false);
          return { ok: true, built: [], skipped: packageNames };
        },
        syncWorkspaceBundledDependenciesForBuildImpl: () => undefined,
        syncBundledWorkspaceDistImpl: ({ workspaceNames }: { workspaceNames: string[] }) => {
          publicationSelections.push(workspaceNames);
        },
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      expect(buildSelections).toEqual([[
        '@happier-dev/protocol',
        '@happier-dev/plugins-pi',
      ]]);
      expect(publicationSelections).toEqual([[
        'protocol',
        'plugins-pi',
      ]]);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('syncs each workspace bundled dependency closure before the canonical owner builds that workspace', async () => {
    const events: string[] = [];

    const names = await buildBundledWorkspaceDependenciesForCli({
      repoRoot: '/repo',
      workspaceNames: ['protocol', 'agents', 'plugin-sdk'],
      syncWorkspaceBundledDependenciesForBuildImpl: ({ workspaceName }: { workspaceName: string }) => {
        events.push(`sync:${workspaceName}`);
      },
      ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(({ workspaceName }) => {
        events.push(`build:${workspaceName}`);
      }),
    });

    expect(names).toEqual(['protocol', 'agents', 'plugin-sdk']);
    expect(events).toEqual([
      'sync:protocol',
      'build:protocol',
      'sync:agents',
      'build:agents',
      'sync:plugin-sdk',
      'build:plugin-sdk',
    ]);
  });

  it('rebuilds declared UI artifacts before source-dev sync when TypeScript outputs are current but the generated graph is missing', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-missing-plugin-ui-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'plugins', 'inspector');
      const sourceDistPath = resolve(sourcePackageDir, 'dist', 'index.js');
      const generatedGraphPath = resolve(
        sourcePackageDir,
        'dist',
        'happier-plugin-ui',
        'ui-artifacts.json',
      );
      const oldSourceTime = new Date('2026-01-01T00:00:00.000Z');
      const currentDistTime = new Date('2030-01-01T00:00:00.000Z');
      const events: string[] = [];

      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'src'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-inspector',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
        scripts: { 'build:ui': 'happier-plugin-build-ui' },
      }), 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'src', 'index.ts'), 'export const inspector = true;\n', 'utf8');
      writeFileSync(sourceDistPath, 'export const inspector = true;\n', 'utf8');
      utimesSync(resolve(sourcePackageDir, 'src', 'index.ts'), oldSourceTime, oldSourceTime);
      utimesSync(sourceDistPath, currentDistTime, currentDistTime);

      await syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-inspector'],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        syncWorkspaceBundledDependenciesForBuildImpl: () => undefined,
        ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(() => {
          events.push('typescript');
          events.push('ui');
          mkdirSync(resolve(generatedGraphPath, '..'), { recursive: true });
          writeFileSync(generatedGraphPath, '{"version":1,"entries":[]}\n', 'utf8');
        }),
        syncBundledWorkspaceDistImpl: () => {
          events.push(existsSync(generatedGraphPath) ? 'sync:with-ui' : 'sync:without-ui');
        },
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      expect(events).toEqual(['typescript', 'ui', 'sync:with-ui']);

      rmSync(resolve(generatedGraphPath, '..'), { recursive: true, force: true });
      events.length = 0;
      await syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-inspector'],
        includeRuntimeDependencies: false,
        stampPath: resolve(repoRoot, '.project', 'tmp', 'declarations-stamp.json'),
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        syncWorkspaceBundledDependenciesForBuildImpl: () => undefined,
        ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(() => {
          events.push('typescript');
          events.push('ui');
        }),
        syncBundledWorkspaceDistImpl: () => {
          events.push('sync:declarations');
        },
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });
      expect(events).toEqual(['sync:declarations']);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('does not trust a current source-dev stamp when a bundled package is missing a declared export', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-missing-declared-export-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'plugins', 'codex');
      const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', 'plugins-codex');
      const relativeExportPath = join('dist', 'agent', 'cli', 'auth', 'environment.js');
      const sourceExportPath = resolve(sourcePackageDir, relativeExportPath);
      const destExportPath = resolve(destPackageDir, relativeExportPath);
      const packageJson = {
        name: '@happier-dev/plugins-codex',
        type: 'module',
        exports: {
          '.': { default: './dist/index.js' },
          './agent/cli/auth/environment': {
            default: './dist/agent/cli/auth/environment.js',
          },
        },
      };

      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'src'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });
      mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'src', 'index.ts'), 'export const codex = true;\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'dist', 'index.js'), 'export const codex = true;\n', 'utf8');
      writeFileSync(resolve(destPackageDir, 'package.json'), JSON.stringify(packageJson), 'utf8');
      writeFileSync(resolve(destPackageDir, 'dist', 'index.js'), 'export const codex = true;\n', 'utf8');

      const signature = computeSourceDevSharedDepsSignature({
        repoRoot,
        workspaceNames: ['plugins-codex'],
      });
      const stampPath = resolve(repoRoot, '.project', 'tmp', 'cli-source-dev-shared-deps-sync.json');
      mkdirSync(dirname(stampPath), { recursive: true });
      writeFileSync(stampPath, JSON.stringify({
        version: 4,
        entries: {
          [JSON.stringify(signature.workspaceNames)]: {
            signature,
            syncedAtMs: Date.now(),
          },
        },
      }), 'utf8');

      const build = vi.fn(() => {
        mkdirSync(dirname(sourceExportPath), { recursive: true });
        writeFileSync(sourceExportPath, 'export const environment = true;\n', 'utf8');
      });
      const syncDist = vi.fn(() => {
        mkdirSync(dirname(destExportPath), { recursive: true });
        writeFileSync(destExportPath, readFileSync(sourceExportPath, 'utf8'), 'utf8');
      });

      await syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-codex'],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(build),
        syncWorkspaceBundledDependenciesForBuildImpl: () => undefined,
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      expect(build).toHaveBeenCalledOnce();
      expect(syncDist).toHaveBeenCalledOnce();
      expect(readFileSync(destExportPath, 'utf8')).toContain('environment');
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('rebuilds the full artifact closure after bootstrapping cli-common helpers', async () => {
    const compiled: string[] = [];

    const names = await buildBundledWorkspaceDependenciesForCli({
      repoRoot: '/repo',
      workspaceNames: ['protocol', 'agents', 'cli-common', 'plugin-sdk'],
      alreadyBuiltWorkspaceNames: new Set(['protocol', 'agents', 'cli-common']),
      syncWorkspaceBundledDependenciesForBuildImpl: () => undefined,
      ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(({ workspaceName }) => {
        compiled.push(`/repo/packages/${workspaceName}/tsconfig.json`);
      }),
    });

    expect(names).toEqual(['protocol', 'agents', 'cli-common', 'plugin-sdk']);
    expect(compiled).toEqual([
      '/repo/packages/protocol/tsconfig.json',
      '/repo/packages/agents/tsconfig.json',
      '/repo/packages/cli-common/tsconfig.json',
      '/repo/packages/plugin-sdk/tsconfig.json',
    ]);
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

  it('reads a targeted source-dev workspace list from explicit helper arguments', () => {
    expect(readSourceDevSharedDepsWorkspaceNamesFromArgv([
      ' plugin-sdk ',
      '@happier-dev/plugin-sdk',
      'agents',
    ])).toEqual([
      'plugin-sdk',
      'agents',
    ]);
    expect(readSourceDevSharedDepsWorkspaceNamesFromArgv(['--check'])).toBeUndefined();
    expect(readSourceDevSharedDepsWorkspaceNamesFromArgv([])).toBeUndefined();
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
      materializeWorkspaceRuntimeDependencyOwner(repoRoot);
      materializeCliCommonWorkspacesLoader(repoRoot);
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl","version":"1.0.0","main":"index.js"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'index.js'), 'module.exports = {};\n', 'utf8');

      writeFileSync(resolve(cliScriptsDir, 'buildSharedDeps.mjs'), readFileSync(resolve(cliScriptsSourceDir, 'buildSharedDeps.mjs'), 'utf8'), 'utf8');
      writeFileSync(
        resolve(cliScriptsDir, 'optionalWorkspaceBundleLock.mjs'),
        readFileSync(resolve(cliScriptsSourceDir, 'optionalWorkspaceBundleLock.mjs'), 'utf8'),
        'utf8',
      );
      writeFileSync(
        resolve(cliScriptsDir, 'syncSharedDepsForDev.mjs'),
        readFileSync(resolve(cliScriptsSourceDir, 'syncSharedDepsForDev.mjs'), 'utf8'),
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
        resolve(workspaceScriptsDir, 'workspaceChildBuildEnv.mjs'),
        readFileSync(resolve(workspaceScriptsSourceDir, 'workspaceChildBuildEnv.mjs'), 'utf8'),
        'utf8',
      );
      writeFileSync(
        resolve(workspaceScriptsDir, 'resolveTypeScriptCliInvocation.mjs'),
        'export function resolveTypeScriptCliInvocation() { return { command: process.execPath, argsPrefix: [] }; }\n',
        'utf8',
      );
      writeFileSync(resolve(workspaceScriptsDir, 'syncBundledWorkspacePackages.mjs'), 'export function syncBundledWorkspacePackages() {}\nexport function vendorBundledPackageRuntimeDependenciesFallback() {}\n', 'utf8');
      writeFileSync(resolve(workspaceScriptsDir, 'resolveWorkspaceDependencyBuildOrder.mjs'), "export function resolveBundledWorkspaceDependencyBuildOrder() { return ['cli-common']; }\n", 'utf8');
      writeFileSync(
        resolve(workspaceScriptsDir, 'ensureWorkspacePackagesBuilt.mjs'),
        'export async function ensureWorkspacePackagesBuiltByName() { return { ok: true, built: [], skipped: [] }; }\n',
        'utf8',
      );
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
      materializeWorkspaceRuntimeDependencyOwner(repoRoot);
      materializeCliCommonWorkspacesLoader(repoRoot);
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl","version":"1.0.0","main":"index.js"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'index.js'), 'module.exports = {};\n', 'utf8');

      writeFileSync(resolve(cliScriptsDir, 'buildSharedDeps.mjs'), readFileSync(resolve(cliScriptsSourceDir, 'buildSharedDeps.mjs'), 'utf8'), 'utf8');
      writeFileSync(
        resolve(cliScriptsDir, 'optionalWorkspaceBundleLock.mjs'),
        readFileSync(resolve(cliScriptsSourceDir, 'optionalWorkspaceBundleLock.mjs'), 'utf8'),
        'utf8',
      );
      writeFileSync(
        resolve(cliScriptsDir, 'syncSharedDepsForDev.mjs'),
        readFileSync(resolve(cliScriptsSourceDir, 'syncSharedDepsForDev.mjs'), 'utf8'),
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
        resolve(workspaceScriptsDir, 'workspaceChildBuildEnv.mjs'),
        readFileSync(resolve(workspaceScriptsSourceDir, 'workspaceChildBuildEnv.mjs'), 'utf8'),
        'utf8',
      );
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
        resolve(workspaceScriptsDir, 'ensureWorkspacePackagesBuilt.mjs'),
        'export async function ensureWorkspacePackagesBuiltByName() { return { ok: true, built: [], skipped: [] }; }\n',
        'utf8',
      );
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
      mkdirSync(resolve(sourcePackageDir, 'src'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'package.json'), '{"name":"@happier-dev/cli-common","type":"module"}\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'src', 'index.ts'), 'export const source = true;\n', 'utf8');
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
      const syncCliDependencies = vi.fn(() => {
        writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      });

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
      expect(inspectSourceDevSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['cli-common'],
      })).toEqual({ current: true, reason: 'current' });
      await runSync();

      expect(lockCount).toBe(1);
      expect(syncDist).toHaveBeenCalledTimes(1);
      expect(syncRuntimeDependencies).toHaveBeenCalledTimes(1);
      expect(syncCliDependencies).toHaveBeenCalledTimes(1);

      mkdirSync(resolve(sourcePackageDir, 'src', '__tests__'), { recursive: true });
      writeFileSync(
        resolve(sourcePackageDir, 'src', '__tests__', 'currentness.test.ts'),
        'export const testOnly = true;\n',
        'utf8',
      );
      expect(inspectSourceDevSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['cli-common'],
      })).toEqual({ current: true, reason: 'current' });

      writeFileSync(resolve(sourcePackageDir, 'dist', 'index.js'), 'export const value = 100;\n', 'utf8');
      expect(inspectSourceDevSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['cli-common'],
      })).toEqual({ current: false, reason: 'not-current' });

      await runSync();
      expect(inspectSourceDevSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['cli-common'],
      })).toEqual({ current: true, reason: 'current' });

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

      rmSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'));
      expect(inspectSourceDevSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['cli-common'],
      })).toEqual({ current: false, reason: 'not-current' });
      await runSync();

      expect(syncDist).toHaveBeenCalledTimes(3);
      expect(syncRuntimeDependencies).toHaveBeenCalledTimes(3);
      expect(syncCliDependencies).toHaveBeenCalledTimes(4);
      expect(existsSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'))).toBe(true);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('publishes source-child readiness from an already-built canonical runtime closure', async () => {
    const repoRoot = createTempDirSync('happy-cli-runtime-source-dev-readiness-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'cli-common');
      const bundledPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', 'cli-common');
      const sourcePath = resolve(sourcePackageDir, 'src', 'index.ts');
      const sourceDistPath = resolve(sourcePackageDir, 'dist', 'index.js');

      mkdirSync(resolve(sourcePackageDir, 'src'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });
      mkdirSync(resolve(bundledPackageDir, 'dist'), { recursive: true });
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(
        resolve(sourcePackageDir, 'package.json'),
        '{"name":"@happier-dev/cli-common","exports":{".":"./dist/index.js"}}\n',
        'utf8',
      );
      writeFileSync(resolve(sourcePackageDir, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
      writeFileSync(sourceDistPath, 'export const value = 1;\n', 'utf8');
      writeFileSync(
        resolve(bundledPackageDir, 'package.json'),
        '{"name":"@happier-dev/cli-common","exports":{".":"./dist/index.js"}}\n',
        'utf8',
      );
      writeFileSync(
        resolve(bundledPackageDir, 'dist', 'index.js'),
        'export const value = 1;\n',
        'utf8',
      );
      writeFileSync(
        resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'),
        '{"name":"tweetnacl"}\n',
        'utf8',
      );
      const sourceTime = new Date('2026-01-01T00:00:00.000Z');
      const outputTime = new Date('2026-01-01T00:00:01.000Z');
      utimesSync(resolve(sourcePackageDir, 'package.json'), sourceTime, sourceTime);
      utimesSync(resolve(sourcePackageDir, 'tsconfig.json'), sourceTime, sourceTime);
      utimesSync(sourcePath, sourceTime, sourceTime);
      utimesSync(resolve(sourcePackageDir, 'src'), sourceTime, sourceTime);
      utimesSync(sourceDistPath, outputTime, outputTime);

      const module = await import('../buildSharedDeps.mjs') as unknown as Record<string, unknown>;
      const publishRuntimeClosure =
        module.publishSourceDevReadinessFromRuntimeClosure as
          | ((options: Readonly<{
              repoRoot: string;
              workspaceNames: string[];
              nowMs: number;
            }>) => Readonly<{ stamped: boolean }>)
          | undefined;

      expect(typeof publishRuntimeClosure).toBe('function');
      if (!publishRuntimeClosure) return;
      expect(publishRuntimeClosure({
        repoRoot,
        workspaceNames: ['cli-common'],
        nowMs: 123,
      })).toEqual({ stamped: true });
      expect(inspectSourceDevSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['cli-common'],
      })).toEqual({ current: true, reason: 'current' });
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('preserves a completed runtime build when newer source prevents a source-child readiness stamp', () => {
    const publishReadiness = vi.fn(() => ({
      stamped: false,
      reason: 'stale-workspace-builds',
      workspaceNames: ['plugin-sdk'],
    }));

    expect(publishSourceDevReadinessAfterRuntimeBuild({
      repoRoot: '/repo',
      workspaceNames: ['plugin-sdk'],
      publishSourceDevReadinessFromRuntimeClosureImpl: publishReadiness,
    })).toEqual({
      stamped: false,
      reason: 'stale-workspace-builds',
      workspaceNames: ['plugin-sdk'],
    });
    expect(publishReadiness).toHaveBeenCalledWith({
      repoRoot: '/repo',
      workspaceNames: ['plugin-sdk'],
    });
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

      const buildWorkspace = vi.fn();
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
        ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(buildWorkspace),
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      await runSync();
      const result = await runSync();

      expect(result).toEqual({ synced: false, reason: 'current' });
      expect(buildWorkspace).toHaveBeenCalledTimes(1);
      expect(syncDist).toHaveBeenCalledTimes(1);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('keeps current declaration admission read-only while another writer lock is active', async () => {
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

      expect(result).toEqual({ synced: false, reason: 'current' });
      expect(lockCount).toBe(1);
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
        ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(({ workspaceName }) => {
          compileCalls.push(resolve(sourcePackageDir, 'tsconfig.json'));
          expect(workspaceName).toBe('plugins-opencode');
          writeFileSync(sourceDistPath, 'export const value = "compiled fresh dist";\n', 'utf8');
        }),
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

  it('does not publish any bundled workspace when a required artifact build fails', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-artifact-failure-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'plugins', 'inspector');
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
      writeFileSync(
        resolve(sourcePackageDir, 'package.json'),
        '{"name":"@happier-dev/plugins-inspector","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n',
        'utf8',
      );
      writeFileSync(resolve(sourcePackageDir, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(sourceFilePath, 'export const value = "fresh source";\n', 'utf8');
      writeFileSync(sourceDistPath, 'export const value = "stale dist";\n', 'utf8');
      utimesSync(sourceFilePath, freshSourceTime, freshSourceTime);
      utimesSync(sourceDistPath, staleTime, staleTime);

      const syncDist = vi.fn();
      const syncRuntimeDependencies = vi.fn();
      const syncCliDependencies = vi.fn();

      await expect(syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-inspector'],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        syncWorkspaceBundledDependenciesForBuildImpl: () => undefined,
        ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(() => {
          throw new Error('generated UI graph failed');
        }),
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: syncRuntimeDependencies,
        syncCliRuntimeDependenciesImpl: syncCliDependencies,
      })).rejects.toThrow('generated UI graph failed');

      expect(syncDist).not.toHaveBeenCalled();
      expect(syncRuntimeDependencies).not.toHaveBeenCalled();
      expect(syncCliDependencies).not.toHaveBeenCalled();
      expect(existsSync(resolve(cliDir, 'node_modules', '@happier-dev', 'plugins-inspector'))).toBe(false);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('refreshes bundled dependencies of a current workspace before compiling its stale dependent', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-current-dependency-bundle-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const pluginSdkDir = resolve(repoRoot, 'packages', 'plugin-sdk');
      const deepseekDir = resolve(repoRoot, 'packages', 'plugins', 'deepseek');
      const pluginSdkInputPaths = [
        resolve(pluginSdkDir, 'src', 'index.ts'),
        resolve(pluginSdkDir, 'package.json'),
        resolve(pluginSdkDir, 'tsconfig.json'),
      ];
      const pluginSdkDistPath = resolve(pluginSdkDir, 'dist', 'index.js');
      const deepseekSourcePath = resolve(deepseekDir, 'src', 'index.ts');
      const deepseekDistPath = resolve(deepseekDir, 'dist', 'index.js');
      const oldInputTime = new Date('2025-01-01T00:00:00.000Z');
      const currentDistTime = new Date('2030-01-01T00:00:00.000Z');
      const staleDependentSourceTime = new Date('2031-01-01T00:00:00.000Z');

      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(pluginSdkDir, 'src'), { recursive: true });
      mkdirSync(resolve(pluginSdkDir, 'dist'), { recursive: true });
      mkdirSync(resolve(deepseekDir, 'src'), { recursive: true });
      mkdirSync(resolve(deepseekDir, 'dist'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(resolve(pluginSdkDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        type: 'module',
        exports: { '.': { default: './dist/index.js' } },
      }), 'utf8');
      writeFileSync(resolve(pluginSdkDir, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(resolve(pluginSdkDir, 'src', 'index.ts'), 'export const sdk = true;\n', 'utf8');
      writeFileSync(pluginSdkDistPath, 'export const sdk = true;\n', 'utf8');
      writeFileSync(resolve(deepseekDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-deepseek',
        type: 'module',
        dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
        exports: { '.': { default: './dist/index.js' } },
      }), 'utf8');
      writeFileSync(resolve(deepseekDir, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(deepseekSourcePath, 'export const deepseek = "fresh source";\n', 'utf8');
      writeFileSync(deepseekDistPath, 'export const deepseek = "stale dist";\n', 'utf8');

      for (const inputPath of pluginSdkInputPaths) {
        utimesSync(inputPath, oldInputTime, oldInputTime);
      }
      utimesSync(pluginSdkDistPath, currentDistTime, currentDistTime);
      utimesSync(deepseekDistPath, currentDistTime, currentDistTime);
      utimesSync(deepseekSourcePath, staleDependentSourceTime, staleDependentSourceTime);

      const buildEvents: string[] = [];
      await syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-deepseek'],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        syncWorkspaceBundledDependenciesForBuildImpl: ({ workspaceName }: { workspaceName: string }) => {
          buildEvents.push(`sync:${workspaceName}`);
        },
        ensureWorkspacePackagesBuiltByNameImpl: async (
          root: string,
          packageNames: string[],
          options: { beforePackageBuild?: (context: { packageName: string; packageDir: string }) => void | Promise<void> },
        ) => {
          await options.beforePackageBuild?.({
            packageName: '@happier-dev/plugin-sdk',
            packageDir: pluginSdkDir,
          });
          await options.beforePackageBuild?.({
            packageName: packageNames[0],
            packageDir: deepseekDir,
          });
          buildEvents.push(`compile:${resolve(deepseekDir, 'tsconfig.json')}`);
          writeFileSync(deepseekDistPath, 'export const deepseek = "compiled fresh dist";\n', 'utf8');
          return { ok: true, built: packageNames, skipped: [] };
        },
        syncBundledWorkspaceDistImpl: () => undefined,
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      expect(buildEvents).toEqual([
        'sync:plugin-sdk',
        'sync:plugins-deepseek',
        `compile:${resolve(deepseekDir, 'tsconfig.json')}`,
      ]);
    } finally {
      removeTempDirSync(repoRoot);
    }
  });

  it('passes the dev-inclusive targeted source-dev workspace closure to bundled dist and runtime dependency sync', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-targeted-closure-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const pluginSdkDir = resolve(repoRoot, 'packages', 'plugin-sdk');
      const openCodePackageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      const testsPackageDir = resolve(repoRoot, 'packages', 'tests');
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(pluginSdkDir, 'dist'), { recursive: true });
      mkdirSync(resolve(openCodePackageDir, 'dist'), { recursive: true });
      mkdirSync(testsPackageDir, { recursive: true });

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
        devDependencies: { '@happier-dev/tests': '0.0.0' },
        exports: { '.': { default: './dist/index.js' } },
      }), 'utf8');
      writeFileSync(resolve(openCodePackageDir, 'dist', 'index.js'), 'export const opencode = true;\n', 'utf8');
      writeFileSync(resolve(testsPackageDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/tests',
        private: true,
      }), 'utf8');

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

      const expectedWorkspaceNames = ['plugin-sdk', 'tests', 'plugins-opencode'];
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

  it('resyncs only changed or missing source-dev workspace outputs when a compatible stamp exists', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-changed-subset-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const packageDirs = new Map([
        ['plugin-sdk', resolve(repoRoot, 'packages', 'plugin-sdk')],
        ['plugins-opencode', resolve(repoRoot, 'packages', 'plugins', 'opencode')],
      ]);
      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });

      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');

      for (const [workspaceName, packageDir] of packageDirs) {
        mkdirSync(resolve(packageDir, 'dist'), { recursive: true });
        writeFileSync(resolve(packageDir, 'package.json'), JSON.stringify({
          name: `@happier-dev/${workspaceName}`,
          type: 'module',
          ...(workspaceName === 'plugins-opencode'
            ? { dependencies: { '@happier-dev/plugin-sdk': '0.0.0' } }
            : {}),
          exports: { '.': { default: './dist/index.js' } },
        }), 'utf8');
        writeFileSync(resolve(packageDir, 'dist', 'index.js'), `export const value = '${workspaceName}';\n`, 'utf8');
      }
      writeFileSync(
        resolve(packageDirs.get('plugins-opencode')!, 'dist', 'removed.js'),
        'export const removed = true;\n',
        'utf8',
      );

      const syncDist = vi.fn((opts?: { workspaceNames?: readonly string[] }) => {
        for (const workspaceName of opts?.workspaceNames ?? []) {
          const packageDir = packageDirs.get(workspaceName);
          if (!packageDir) throw new Error(`unexpected workspace: ${workspaceName}`);
          const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', workspaceName);
          mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
          writeFileSync(resolve(destPackageDir, 'package.json'), readFileSync(resolve(packageDir, 'package.json'), 'utf8'), 'utf8');
          for (const fileName of ['index.js', 'removed.js']) {
            const sourcePath = resolve(packageDir, 'dist', fileName);
            if (existsSync(sourcePath)) {
              writeFileSync(resolve(destPackageDir, 'dist', fileName), readFileSync(sourcePath, 'utf8'), 'utf8');
            }
          }
        }
      });
      const syncRuntimeDependencies = vi.fn(() => undefined);
      const runSync = () => syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugins-opencode'],
        withBuildSharedDepsLockImpl: async (fn: () => Promise<unknown> | unknown) => await fn(),
        syncBundledWorkspaceDistImpl: syncDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: syncRuntimeDependencies,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      await runSync();
      expect(syncDist).toHaveBeenLastCalledWith(expect.objectContaining({
        workspaceNames: ['plugin-sdk', 'plugins-opencode'],
      }));

      syncDist.mockClear();
      syncRuntimeDependencies.mockClear();
      rmSync(resolve(packageDirs.get('plugins-opencode')!, 'dist', 'removed.js'));
      writeFileSync(
        resolve(packageDirs.get('plugins-opencode')!, 'dist', 'index.js'),
        'export const value = "changed opencode output with a different size";\n',
        'utf8',
      );
      await runSync();

      expect(syncDist).toHaveBeenCalledOnce();
      expect(syncDist).toHaveBeenCalledWith(expect.objectContaining({ workspaceNames: ['plugins-opencode'] }));
      expect(syncRuntimeDependencies).toHaveBeenCalledWith(expect.objectContaining({
        workspaceNames: ['plugins-opencode'],
      }));
      expect(existsSync(resolve(cliDir, 'node_modules', '@happier-dev', 'plugins-opencode', 'dist', 'removed.js'))).toBe(false);

      syncDist.mockClear();
      syncRuntimeDependencies.mockClear();
      rmSync(resolve(cliDir, 'node_modules', '@happier-dev', 'plugin-sdk', 'package.json'));
      await runSync();
      expect(syncDist).toHaveBeenCalledWith(expect.objectContaining({ workspaceNames: ['plugin-sdk'] }));

      syncDist.mockClear();
      syncRuntimeDependencies.mockClear();
      writeFileSync(
        resolve(repoRoot, '.project', 'tmp', 'cli-source-dev-shared-deps-sync.json'),
        '{"version":999,"entries":{}}\n',
        'utf8',
      );
      await runSync();
      expect(syncDist).toHaveBeenCalledWith(expect.objectContaining({
        workspaceNames: ['plugin-sdk', 'plugins-opencode'],
      }));

      syncDist.mockClear();
      syncRuntimeDependencies.mockClear();
      expect(await runSync()).toEqual({ synced: false, reason: 'current' });
      expect(syncDist).not.toHaveBeenCalled();
      expect(syncRuntimeDependencies).not.toHaveBeenCalled();
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
        ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(({ workspaceName }) => {
          expect(workspaceName).toBe('plugins-opencode');
          writeFileSync(sourceDistPath, 'export const value = "compiled fresh dist";\n', 'utf8');
        }),
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
      expect(progressEvents.filter((event) => event.stage === 'stale-scan' && String(event.event).includes('start'))).toEqual([
        expect.objectContaining({ event: 'start-after-lock' }),
      ]);
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

      const workspaceBuildCalls: Array<{
        workspaceName: string;
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
        ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(({ workspaceName, timeoutMs }) => {
          buildEvents.push(`build:${workspaceName}`);
          workspaceBuildCalls.push({
            workspaceName,
            timeoutMs: timeoutMs ?? undefined,
          });
          writeFileSync(sourceDistPath, 'export const value = "compiled fresh dist";\n', 'utf8');
        }),
        syncBundledWorkspaceDistImpl: () => {
          mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
          writeFileSync(resolve(destPackageDir, 'package.json'), readFileSync(resolve(sourcePackageDir, 'package.json'), 'utf8'), 'utf8');
          writeFileSync(resolve(destPackageDir, 'dist', 'index.js'), readFileSync(sourceDistPath, 'utf8'), 'utf8');
        },
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      expect(workspaceBuildCalls).toEqual([{
        workspaceName: 'plugins-opencode',
        timeoutMs: 12_345,
      }]);
      expect(buildEvents).toEqual([
        'sync:plugins-opencode',
        'build:plugins-opencode',
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
        ensureWorkspacePackagesBuiltByNameImpl: createWorkspaceBuildOwner(({ workspaceName }) => {
          compileCalls.push(resolve(sourcePackageDir, 'tsconfig.json'));
          expect(workspaceName).toBe('plugins-opencode');
          writeFileSync(sourceDistPath, 'export const value = "compiled fresh dist";\n', 'utf8');
        }),
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

  it('treats intentionally omitted TypeScript build metadata as current after source-dev publication', async () => {
    const repoRoot = createTempDirSync('happy-cli-dev-sync-omitted-tsbuildinfo-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const sourcePackageDir = resolve(repoRoot, 'packages', 'plugins', 'opencode');
      const destPackageDir = resolve(cliDir, 'node_modules', '@happier-dev', 'plugins-opencode');
      const sourceDistPath = resolve(sourcePackageDir, 'dist', 'index.js');
      const destDistPath = resolve(destPackageDir, 'dist', 'index.js');

      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      mkdirSync(resolve(sourcePackageDir, 'dist'), { recursive: true });
      writeFileSync(resolve(repoRoot, 'package.json'), '{"private":true}\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# lock\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf8');
      writeFileSync(resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'), '{"name":"tweetnacl"}\n', 'utf8');
      writeFileSync(
        resolve(sourcePackageDir, 'package.json'),
        '{"name":"@happier-dev/plugins-opencode","type":"module","exports":{".":{"default":"./dist/index.js"}}}\n',
        'utf8',
      );
      writeFileSync(sourceDistPath, 'export const value = true;\n', 'utf8');
      writeFileSync(resolve(sourcePackageDir, 'dist', '.tsbuildinfo'), '{"version":"cache-only"}\n', 'utf8');

      let lockCount = 0;
      const syncDist = vi.fn(() => {
        mkdirSync(resolve(destPackageDir, 'dist'), { recursive: true });
        writeFileSync(
          resolve(destPackageDir, 'package.json'),
          readFileSync(resolve(sourcePackageDir, 'package.json'), 'utf8'),
          'utf8',
        );
        writeFileSync(destDistPath, readFileSync(sourceDistPath, 'utf8'), 'utf8');
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

      expect(await runSync()).toEqual({ synced: true, stamped: true });
      expect(await runSync()).toEqual({ synced: false, reason: 'current' });
      expect(lockCount).toBe(1);
      expect(syncDist).toHaveBeenCalledTimes(1);
      expect(existsSync(resolve(destPackageDir, 'dist', '.tsbuildinfo'))).toBe(false);
    } finally {
      removeTempDirSync(repoRoot);
    }
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

  it('forwards the admitted cli-common helpers into bundled workspace publication', () => {
    const readBundledWorkspacePackageNames = vi.fn(() => []);
    const cliCommonWorkspacesModule = {
      readBundledWorkspacePackageNames,
    };

    syncBundledWorkspaceDist({
      repoRoot: '/repo',
      cliCommonWorkspacesModule,
      existsSync: (path: string) => path === '/repo/apps/cli/package.json',
      readFileSync: () => JSON.stringify({
        bundledDependencies: ['@happier-dev/protocol'],
      }),
    });

    expect(readBundledWorkspacePackageNames).toHaveBeenCalledWith({
      bundledDependencies: ['@happier-dev/protocol'],
    });
  });

  it('loads the rebuilt transitive cli-common helper graph for primary publication in the same process', async () => {
    const repoRoot = createTempDirSync('happy-cli-common-primary-publication-');
    const packageDir = resolve(repoRoot, 'packages', 'cli-common');
    const entryPath = resolve(packageDir, 'dist', 'workspaces', 'index.js');
    const helperPath = resolve(packageDir, 'workspaceRuntimeDependencies.mjs');
    const ensureWorkspacePackagesBuiltByNameImpl = vi.fn(async () => ({
      ok: true,
      built: [],
      skipped: ['@happier-dev/cli-common'],
    }));

    try {
      mkdirSync(dirname(entryPath), { recursive: true });
      writeFileSync(resolve(packageDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli-common',
        type: 'module',
      }));
      writeFileSync(entryPath, [
        "export { helperGeneration } from '../../workspaceRuntimeDependencies.mjs';",
        '',
      ].join('\n'));
      writeFileSync(helperPath, 'export const helperGeneration = 1;\n');

      const first = await resolveCliCommonWorkspacesHelpersAfterBuild({
        repoRoot,
        ensureWorkspacePackagesBuiltByNameImpl,
      });
      writeFileSync(helperPath, 'export const helperGeneration = 2;\n');
      const second = await resolveCliCommonWorkspacesHelpersAfterBuild({
        repoRoot,
        ensureWorkspacePackagesBuiltByNameImpl,
      });

      expect(first.helperGeneration).toBe(1);
      expect(second.helperGeneration).toBe(2);
      expect(ensureWorkspacePackagesBuiltByNameImpl).toHaveBeenCalledTimes(2);
      expect(ensureWorkspacePackagesBuiltByNameImpl).toHaveBeenNthCalledWith(
        1,
        repoRoot,
        ['@happier-dev/cli-common'],
        expect.objectContaining({
          includeDevDependencies: false,
        }),
      );
      expect(ensureWorkspacePackagesBuiltByNameImpl.mock.calls[0]?.[2]).not.toHaveProperty('force');
    } finally {
      removeTempDirSync(repoRoot);
    }
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
      dereferenceRootDir: '/repo',
    });
  });

  it('syncs bundled workspace package.json exports for local bundled hosts', () => {
    const repoRoot = createTempDirSync('happy-cli-bundled-exports-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const protocolDir = resolve(repoRoot, 'packages', 'protocol');
      mkdirSync(resolve(protocolDir, 'dist'), { recursive: true });
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(
        resolve(cliDir, 'package.json'),
        JSON.stringify({ bundledDependencies: ['@happier-dev/protocol'] }),
        'utf8',
      );
      writeFileSync(
        resolve(protocolDir, 'package.json'),
        JSON.stringify({
          name: '@happier-dev/protocol',
          version: '0.0.0',
          type: 'module',
          exports: {
            '.': { default: './dist/index.js' },
            './installables': { default: './dist/installables.js' },
          },
        }),
        'utf8',
      );
      writeFileSync(resolve(protocolDir, 'dist', 'index.js'), 'export const protocol = true;\n', 'utf8');
      writeFileSync(resolve(protocolDir, 'dist', 'installables.js'), 'export const installables = true;\n', 'utf8');

      syncBundledWorkspaceDist({ repoRoot });

      const bundledProtocolDir = resolve(cliDir, 'node_modules', '@happier-dev', 'protocol');
      const bundledManifest = JSON.parse(readFileSync(resolve(bundledProtocolDir, 'package.json'), 'utf8'));
      expect(bundledManifest.exports?.['./installables']).toEqual({ default: './dist/installables.js' });
      expect(bundledManifest.private).toBe(true);
      expect(readFileSync(resolve(bundledProtocolDir, 'dist', 'installables.js'), 'utf8')).toContain('installables');
    } finally {
      removeTempDirSync(repoRoot);
    }
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

  it('materializes a pack-sandbox dependency link without deleting its selected source', () => {
    const { repoRoot, happyCliDir, cleanup } = createPackageLayoutSandbox('happy-build-shared-runtime-link-');

    try {
      const installedPackageDir = writeRuntimeDependencyStub({
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
      const bundledPackageDir = resolve(happyCliDir, 'node_modules', 'tweetnacl');
      mkdirSync(dirname(bundledPackageDir), { recursive: true });
      symlinkSync(
        installedPackageDir,
        bundledPackageDir,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      syncCliRuntimeDependencies({ repoRoot });

      expect(readFileSync(resolve(installedPackageDir, 'nacl-fast.js'), 'utf8')).toBe('module.exports = {};\n');
      expect(readFileSync(resolve(bundledPackageDir, 'nacl-fast.js'), 'utf8')).toBe('module.exports = {};\n');
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
