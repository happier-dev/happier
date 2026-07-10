import { cpSync, existsSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createTempDirSync, removeTempDirSync } from '../../../src/testkit/fs/tempDir';
import { ensureDirectorySync, writeTextFileSync } from '../../../src/testkit/fs/fileHelpers';

const runtimeBinFiles = [
  'happier.mjs',
  '_resolveRuntimeEntrypoint.mjs',
  '_prepareRuntimeEntrypoint.mjs',
  '_importRuntimeEntrypoint.mjs',
];

function resolveRepoRootForWorkspaceScripts(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(resolve(dir, 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs'))) {
      return dir;
    }

    const parent = resolve(dir, '..');
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return startDir;
}

export function createCliBinPreflightSandbox(prefix: string): { rootDir: string; cleanup: () => void } {
  const rootDir = createTempDirSync(prefix);

  return {
    rootDir,
    cleanup() {
      removeTempDirSync(rootDir);
    },
  };
}

export function copyCliBinRuntimeFiles(options: {
  binDir: string;
  repoRoot?: string;
  cliRoot?: string;
}): void {
  const cliRoot = options.cliRoot ?? (options.repoRoot ? resolve(options.repoRoot, 'apps', 'cli') : process.cwd());
  const repoRoot = options.repoRoot ?? resolve(cliRoot, '..', '..');
  const runtimeBinDir = resolve(cliRoot, 'bin');

  ensureDirectorySync(options.binDir);

  for (const file of runtimeBinFiles) {
    cpSync(resolve(runtimeBinDir, file), join(options.binDir, file));
  }

  copyCliCommonBuildLockRuntimeFile({
    packageDir: resolve(options.binDir, '..', 'node_modules', '@happier-dev', 'cli-common'),
    repoRoot,
  });
}

function copyCliCommonBuildLockRuntimeFile(options: {
  packageDir: string;
  repoRoot: string;
}): void {
  writeSandboxPackage({
    packageDir: options.packageDir,
    manifest: {
      name: '@happier-dev/cli-common',
      version: '0.0.0',
      type: 'module',
      exports: {
        './jsonOwnerBuildLockState': './jsonOwnerBuildLockState.cjs',
      },
    },
  });
  cpSync(
    resolve(options.repoRoot, 'packages', 'cli-common', 'jsonOwnerBuildLockState.cjs'),
    join(options.packageDir, 'jsonOwnerBuildLockState.cjs'),
  );
}

export function copyCliWorkspaceSyncRuntimeFiles(options: {
  scriptsDir: string;
  repoRoot?: string;
}): void {
  const repoRoot = options.repoRoot ?? resolveRepoRootForWorkspaceScripts(process.cwd());
  const workspaceScriptsDir = resolve(repoRoot, 'scripts', 'workspaces');

  ensureDirectorySync(options.scriptsDir);

  for (const file of ['syncBundledWorkspacePackages.mjs', 'vendorBundledWorkspaceRuntimeDependenciesFallback.mjs']) {
    cpSync(resolve(workspaceScriptsDir, file), join(options.scriptsDir, file));
  }
}

export function runHappierBin(options: {
  binDir: string;
  cwd: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(options.binDir, 'happier.mjs'), ...(options.args ?? [])], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    timeout: options.timeout,
  });
}

export function writeSandboxTextFile(path: string, content: string): void {
  writeTextFileSync(path, content);
}

export function writeSandboxJsonFile(path: string, value: unknown): void {
  writeSandboxTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeSandboxPackage(options: {
  packageDir: string;
  manifest?: unknown;
  files?: Readonly<Record<string, string>>;
}): void {
  ensureDirectorySync(options.packageDir);

  if (options.manifest !== undefined) {
    writeSandboxJsonFile(join(options.packageDir, 'package.json'), options.manifest);
  }

  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    writeSandboxTextFile(join(options.packageDir, relativePath), content);
  }
}

export function writeCliProjectFixture(options: {
  projectRoot: string;
  entrypointDir: 'dist' | 'package-dist';
  entrypointContent: string;
}): { binDir: string } {
  const binDir = join(options.projectRoot, 'bin');

  ensureDirectorySync(binDir);
  ensureDirectorySync(join(options.projectRoot, options.entrypointDir));
  writeSandboxJsonFile(join(options.projectRoot, 'package.json'), { name: '@happier-dev/cli' });
  writeSandboxTextFile(join(options.projectRoot, options.entrypointDir, 'index.mjs'), options.entrypointContent);

  return { binDir };
}

export function writeProtocolBundleStub(options: {
  packageDir: string;
  exportsMap?: Readonly<Record<string, string>>;
  distFiles?: Readonly<Record<string, string>>;
}): void {
  writeSandboxPackage({
    packageDir: options.packageDir,
    manifest: {
      name: '@happier-dev/protocol',
      version: '0.0.0',
      type: 'module',
      main: './dist/index.js',
      exports: options.exportsMap ?? {
        '.': './dist/index.js',
      },
    },
    files: {
      'dist/index.js': 'export {};\n',
      ...(options.distFiles ?? {}),
    },
  });
}

export function writeNodeModuleStub(options: {
  packageDir: string;
  manifest?: unknown;
  files?: Readonly<Record<string, string>>;
}): void {
  writeSandboxPackage(options);
}
