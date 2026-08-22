import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { resolveWorkspaceBundlesFromPackageJson } from '../../../../packages/cli-common/src/workspaces/index.js';
import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';
import {
  syncBundledWorkspaceRuntimeDependencies,
  syncSharedDepsForSourceDev,
} from '../buildSharedDeps.mjs';

const INTERNAL_PACKAGE_PREFIX = '@happier-dev/';
const PLUGINS_PACKAGE_PREFIX = '@happier-dev/plugins-';
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CLI_DIR = resolve(REPO_ROOT, 'apps', 'cli');
const CLI_PACKAGE_JSON_PATH = resolve(CLI_DIR, 'package.json');

type PackageJsonShape = Readonly<{
  name?: unknown;
  bundledDependencies?: unknown;
  dependencies?: Readonly<Record<string, unknown>>;
  optionalDependencies?: Readonly<Record<string, unknown>>;
}>;

function readPackageJson(path: string): PackageJsonShape {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJsonShape;
}

function toWorkspaceName(packageName: string): string {
  return packageName.slice(INTERNAL_PACKAGE_PREFIX.length);
}

function isPluginPackageName(packageName: string): boolean {
  return packageName.startsWith(PLUGINS_PACKAGE_PREFIX);
}

/** Mirrors the source-dev resolver's package-name -> workspace-directory rule. */
function resolveRealWorkspaceDir(repoRoot: string, packageName: string): string {
  if (isPluginPackageName(packageName)) {
    return resolve(repoRoot, 'packages', 'plugins', packageName.slice(PLUGINS_PACKAGE_PREFIX.length));
  }
  return resolve(repoRoot, 'packages', toWorkspaceName(packageName));
}

/** The real `apps/cli` bundled internal workspaces, read from the checked-in package.json. */
function readDeclaredBundledWorkspaceNames(): readonly string[] {
  const raw = readPackageJson(CLI_PACKAGE_JSON_PATH).bundledDependencies;
  return (Array.isArray(raw) ? raw.map((value) => String(value)) : [])
    .filter((packageName) => packageName.startsWith(INTERNAL_PACKAGE_PREFIX))
    .sort((left, right) => left.localeCompare(right));
}

/** The real runtime (non-dev) internal dependency edges of a workspace, read from its own package.json. */
function readRealInternalRuntimeDependencyNames(packageName: string): readonly string[] {
  const packageJson = readPackageJson(resolve(resolveRealWorkspaceDir(REPO_ROOT, packageName), 'package.json'));
  const names = new Set<string>();
  for (const deps of [packageJson.dependencies, packageJson.optionalDependencies]) {
    if (!deps || typeof deps !== 'object') continue;
    for (const dependencyName of Object.keys(deps)) {
      if (dependencyName.startsWith(INTERNAL_PACKAGE_PREFIX)) names.add(dependencyName);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * A declared workspace another declared workspace depends on at runtime. Dropping it from
 * `bundledDependencies` leaves the real closure reaching a package the host no longer bundles,
 * which is the exact omission this guard exists to fail on.
 */
function findDeclaredWorkspaceRequiredByAnotherBundle(declaredNames: readonly string[]): string | null {
  const requiredNames = new Set<string>();
  for (const packageName of declaredNames) {
    for (const dependencyName of readRealInternalRuntimeDependencyNames(packageName)) {
      if (dependencyName !== packageName) requiredNames.add(dependencyName);
    }
  }
  return declaredNames.find((packageName) => requiredNames.has(packageName)) ?? null;
}

/** Drives the source-dev bundled-workspace resolver read-only and reports the packages it resolved. */
function resolveSourceDevBundledPackageNames(overrides: Readonly<{
  readFileSyncImpl?: typeof readFileSync;
}> = {}): readonly string[] {
  const resolvedPackageNames: string[] = [];
  syncBundledWorkspaceRuntimeDependencies({
    repoRoot: REPO_ROOT,
    ...(overrides.readFileSyncImpl ? { readFileSync: overrides.readFileSyncImpl } : {}),
    // Read-only probe: the resolver under test runs, the copying side effect does not.
    vendorBundledPackageRuntimeDependencies: ({ srcPackageJsonPath }: { srcPackageJsonPath: string }) => {
      resolvedPackageNames.push(String(readPackageJson(srcPackageJsonPath).name));
    },
  });
  return resolvedPackageNames.sort((left, right) => left.localeCompare(right));
}

describe('CLI source-dev bundled plugin closure', () => {
  it('resolves the real apps/cli bundled closure from the real workspace packages', () => {
    const declaredNames = readDeclaredBundledWorkspaceNames();
    expect(declaredNames.length).toBeGreaterThan(0);
    expect(declaredNames.filter(isPluginPackageName).length).toBeGreaterThan(0);

    // Each resolved name is read back out of the package.json the resolver pointed at, so a
    // package-name -> directory mapping error fails here instead of silently vendoring the wrong tree.
    const resolvedNames = resolveSourceDevBundledPackageNames();

    expect(resolvedNames).toEqual([...declaredNames]);
    expect(resolvedNames).toEqual(
      resolveWorkspaceBundlesFromPackageJson({ repoRoot: REPO_ROOT, hostPackageDir: CLI_DIR })
        .map((bundle) => bundle.packageName)
        .sort((left, right) => left.localeCompare(right)),
    );
  });

  it('fails when a workspace the real closure reaches is missing from apps/cli bundledDependencies', () => {
    const declaredNames = readDeclaredBundledWorkspaceNames();
    const omittedPackageName = findDeclaredWorkspaceRequiredByAnotherBundle(declaredNames);
    // Without such a workspace the omission above is unreachable and the guard cannot discriminate.
    expect(omittedPackageName).not.toBeNull();

    const readFileSyncWithOmittedBundle = ((path: Parameters<typeof readFileSync>[0], ...rest: unknown[]) => {
      if (typeof path === 'string' && resolve(path) === CLI_PACKAGE_JSON_PATH) {
        const cliPackageJson = JSON.parse(readFileSync(CLI_PACKAGE_JSON_PATH, 'utf8')) as Record<string, unknown>;
        return JSON.stringify({
          ...cliPackageJson,
          bundledDependencies: (cliPackageJson.bundledDependencies as unknown[]).filter(
            (value) => String(value) !== omittedPackageName,
          ),
        });
      }
      return (readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof readFileSync;

    let thrown: unknown = null;
    try {
      resolveSourceDevBundledPackageNames({ readFileSyncImpl: readFileSyncWithOmittedBundle });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('Missing bundled internal workspace dependencies');
    expect((thrown as Error).message).toContain(`- ${omittedPackageName}`);
  });

  it('does not expand a plugin-sdk bootstrap into unrelated generated-registry plugins', async () => {
    // The fixture repo mirrors the real bundled membership and the real internal dependency edges;
    // only the built outputs are stubbed, so the fan-out question is asked against real membership.
    const declaredNames = readDeclaredBundledWorkspaceNames();
    const declaredNameSet = new Set(declaredNames);
    const pluginWorkspaceNames = declaredNames.filter(isPluginPackageName).map(toWorkspaceName);
    expect(pluginWorkspaceNames.length).toBeGreaterThan(0);
    expect(declaredNameSet.has('@happier-dev/plugin-sdk')).toBe(true);

    const repoRoot = createTempDirSync('happier-cli-source-dev-generated-registry-closure-');
    try {
      const cliDir = resolve(repoRoot, 'apps', 'cli');
      const packageJsonByWorkspaceName = new Map<string, string>();

      mkdirSync(resolve(cliDir, 'node_modules', 'tweetnacl'), { recursive: true });
      writeFileSync(resolve(repoRoot, 'package.json'), JSON.stringify({
        private: true,
        workspaces: ['apps/*', 'packages/*', 'packages/plugins/*'],
      }), 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# fixture\n', 'utf8');
      writeFileSync(resolve(cliDir, 'package.json'), JSON.stringify({
        name: '@happier-dev/cli',
        bundledDependencies: [...declaredNames],
      }), 'utf8');
      writeFileSync(
        resolve(cliDir, 'node_modules', 'tweetnacl', 'package.json'),
        '{"name":"tweetnacl"}\n',
        'utf8',
      );

      for (const packageName of declaredNames) {
        const workspaceName = toWorkspaceName(packageName);
        const isPlugin = isPluginPackageName(packageName);
        const packageDir = resolveRealWorkspaceDir(repoRoot, packageName);
        const internalDependencyNames = readRealInternalRuntimeDependencyNames(packageName)
          .filter((dependencyName) => declaredNameSet.has(dependencyName));
        const packageJson = JSON.stringify({
          name: packageName,
          type: 'module',
          exports: {
            '.': { default: './dist/index.js' },
            ...(isPlugin ? { './manifest': { default: './dist/manifest.js' } } : {}),
          },
          ...(internalDependencyNames.length > 0
            ? {
                dependencies: Object.fromEntries(
                  internalDependencyNames.map((dependencyName) => [dependencyName, '0.0.0']),
                ),
              }
            : {}),
        });
        packageJsonByWorkspaceName.set(workspaceName, packageJson);
        mkdirSync(resolve(packageDir, 'dist'), { recursive: true });
        writeFileSync(resolve(packageDir, 'package.json'), packageJson, 'utf8');
        writeFileSync(resolve(packageDir, 'tsconfig.json'), '{}\n', 'utf8');
        writeFileSync(resolve(packageDir, 'dist', 'index.js'), `export const workspace = ${JSON.stringify(workspaceName)};\n`, 'utf8');
        if (isPlugin) {
          writeFileSync(resolve(packageDir, 'dist', 'manifest.js'), `export const manifest = ${JSON.stringify(workspaceName)};\n`, 'utf8');
        }
      }

      const publicationEvents: string[] = [];
      const publishBundledPluginArtifacts = vi.fn(async () => {
        publicationEvents.push('publish');
        return true;
      });
      const syncBundledWorkspaceDist = vi.fn((options: { workspaceNames: readonly string[] }) => {
        publicationEvents.push(`sync:${options.workspaceNames.join(',')}`);
        for (const workspaceName of options.workspaceNames) {
          const packageJson = packageJsonByWorkspaceName.get(workspaceName);
          if (!packageJson) throw new Error(`unexpected workspace ${workspaceName}`);
          const destinationDir = resolve(cliDir, 'node_modules', '@happier-dev', workspaceName);
          mkdirSync(resolve(destinationDir, 'dist'), { recursive: true });
          writeFileSync(resolve(destinationDir, 'package.json'), packageJson, 'utf8');
          writeFileSync(resolve(destinationDir, 'dist', 'index.js'), `export const workspace = ${JSON.stringify(workspaceName)};\n`, 'utf8');
          if (workspaceName.startsWith('plugins-')) {
            writeFileSync(resolve(destinationDir, 'dist', 'manifest.js'), `export const manifest = ${JSON.stringify(workspaceName)};\n`, 'utf8');
          }
        }
      });

      await syncSharedDepsForSourceDev({
        repoRoot,
        workspaceNames: ['plugin-sdk'],
        withBuildSharedDepsLockImpl: async (run: () => Promise<unknown> | unknown) => await run(),
        publishBundledPluginArtifactsImpl: publishBundledPluginArtifacts,
        syncBundledWorkspaceDistImpl: syncBundledWorkspaceDist,
        syncBundledWorkspaceRuntimeDependenciesImpl: () => undefined,
        syncCliRuntimeDependenciesImpl: () => undefined,
      });

      const syncedWorkspaceNames = syncBundledWorkspaceDist.mock.calls.flatMap(
        ([options]) => [...options.workspaceNames],
      );
      expect(syncedWorkspaceNames).toContain('plugin-sdk');
      expect(syncedWorkspaceNames.filter((workspaceName) => workspaceName.startsWith('plugins-'))).toEqual([]);
      expect(publicationEvents.filter((event) => event === 'publish')).toEqual([]);
      expect(publishBundledPluginArtifacts).not.toHaveBeenCalled();
      for (const pluginWorkspaceName of pluginWorkspaceNames) {
        expect(existsSync(resolve(
          cliDir,
          'node_modules',
          '@happier-dev',
          pluginWorkspaceName,
          'dist',
          'manifest.js',
        ))).toBe(false);
      }
    } finally {
      removeTempDirSync(repoRoot);
    }
  });
});
