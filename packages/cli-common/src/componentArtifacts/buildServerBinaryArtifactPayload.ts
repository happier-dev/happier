import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SERVER_BINARY_TARGETS, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, type RunCommand } from './commands.js';
import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';
import { compilePrismaMigrateBinary } from './compilePrismaMigrateBinary.js';
import {
  resolveRequestedServerDbProviders,
  resolveServerBinarySidecarEntries,
  resolveServerRuntimeSupportBuildDbProviders,
  type ServerComponent,
  type StageEntry,
} from './serverSidecars.js';

export const SERVER_BINARY_DEFAULT_EXTERNALS = Object.freeze(['redis']);

function resolvePrismaEngineFileNameForTarget(target: BinaryTarget): string {
  const key = `${target.os}-${target.arch}`;
  switch (key) {
    case 'linux-x64':
      return 'libquery_engine-debian-openssl-3.0.x.so.node';
    case 'linux-arm64':
      return 'libquery_engine-linux-arm64-openssl-3.0.x.so.node';
    case 'darwin-x64':
      return 'libquery_engine-darwin.dylib.node';
    case 'darwin-arm64':
      return 'libquery_engine-darwin-arm64.dylib.node';
    case 'windows-x64':
      return 'query_engine-windows.dll.node';
    default:
      throw new Error(`[component-artifacts] unsupported Prisma binary target: ${key}`);
  }
}

async function ensureFile(path: string, message: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(message);
  }
}

async function validateServerPrismaEnginesForTarget({
  payloadDir,
  target,
  buildDbProviders,
}: {
  payloadDir: string;
  target: BinaryTarget;
  buildDbProviders: string;
}): Promise<void> {
  const targetKey = `${target.os}-${target.arch}`;
  const engineFileName = resolvePrismaEngineFileNameForTarget(target);
  await ensureFile(
    join(payloadDir, 'node_modules', '.prisma', 'client', engineFileName),
    `[component-artifacts] missing postgres Prisma query engine for ${targetKey}: node_modules/.prisma/client/${engineFileName}`,
  );

  for (const provider of resolveRequestedServerDbProviders(buildDbProviders)) {
    await ensureFile(
      join(payloadDir, 'generated', `${provider}-client`, engineFileName),
      `[component-artifacts] missing ${provider} Prisma query engine for ${targetKey}: generated/${provider}-client/${engineFileName}`,
    );
  }
}

export async function copyServerRuntimeSupportEntries({
  payloadDir,
  entries,
  target,
  buildDbProviders,
  copyPath = defaultCopyPath,
}: {
  payloadDir: string;
  entries: readonly StageEntry[];
  target: BinaryTarget;
  buildDbProviders: string;
  copyPath?: (entry: { sourcePath: string; destPath: string; recursive: boolean }, fallbackCopyPath: typeof defaultCopyPath) => Promise<void>;
}): Promise<void> {
  for (const entry of entries) {
    await mkdir(join(payloadDir, entry.targetPath, '..'), { recursive: true });
    await copyPathWithRetry({
      sourcePath: entry.sourcePath,
      destPath: join(payloadDir, entry.targetPath),
      recursive: true,
      copyPath,
    });
  }
  await validateServerPrismaEnginesForTarget({
    payloadDir,
    target,
    buildDbProviders,
  });
}

export async function buildServerRuntimeSupportPayload({
  repoRoot,
  payloadDir,
  entries,
  target,
  buildDbProviders,
  serverComponent = 'happier-server-light',
  env = process.env,
  runCommand = execOrThrow,
  commandProbe = commandExists,
  compilePrismaBinary = compilePrismaMigrateBinary,
  copyPath = defaultCopyPath,
}: {
  repoRoot?: string;
  payloadDir: string;
  entries: readonly StageEntry[];
  target: BinaryTarget;
  buildDbProviders: string;
  serverComponent?: ServerComponent;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  compilePrismaBinary?: typeof compilePrismaMigrateBinary;
  copyPath?: (entry: { sourcePath: string; destPath: string; recursive: boolean }, fallbackCopyPath: typeof defaultCopyPath) => Promise<void>;
}): Promise<void> {
  await rm(payloadDir, { recursive: true, force: true });
  await mkdir(payloadDir, { recursive: true });
  await copyServerRuntimeSupportEntries({
    payloadDir,
    entries,
    target,
    buildDbProviders,
    copyPath,
  });
  if (serverComponent === 'happier-server') {
    const resolvedRepoRoot = String(repoRoot ?? '').trim();
    if (!resolvedRepoRoot) {
      throw new Error('[component-artifacts] full-server runtime support requires a repository root for Prisma migrate.');
    }
    const bunCommand = resolveBunCommand({ commandProbe, processEnv: env });
    if (!bunCommand) {
      throw new Error('[component-artifacts] bun is required to build full-server Prisma migration support');
    }
    await compilePrismaBinary({
      repoRoot: resolvedRepoRoot,
      target,
      outfile: join(payloadDir, 'runtime', resolveExecutableName({ baseName: 'prisma-migrate', target })),
      bunCommand,
      runCommand,
    });
  }
  await finalizeRuntimeArtifactPayload(payloadDir);
}

export async function buildServerBinaryArtifactPayload({
  repoRoot,
  payloadDir,
  uiWebDistPath,
  includeRuntimeSupport = true,
  target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS }),
  serverComponent = 'happier-server-light',
  entrypoint = join(repoRoot, 'apps', 'server', 'sources', 'main.light.ts'),
  externals = [...SERVER_BINARY_DEFAULT_EXTERNALS],
  buildDbProviders,
  env = process.env,
  runCommand = execOrThrow,
  commandProbe = commandExists,
  compileBinary = compileBunBinary,
  compilePrismaBinary = compilePrismaMigrateBinary,
  copyPath = defaultCopyPath,
}: {
  repoRoot: string;
  payloadDir: string;
  uiWebDistPath?: string;
  includeRuntimeSupport?: boolean;
  target?: BinaryTarget;
  serverComponent?: ServerComponent;
  entrypoint?: string;
  externals?: string[];
  buildDbProviders?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  compileBinary?: typeof compileBunBinary;
  compilePrismaBinary?: typeof compilePrismaMigrateBinary;
  copyPath?: (entry: { sourcePath: string; destPath: string; recursive: boolean }, fallbackCopyPath: typeof defaultCopyPath) => Promise<void>;
}): Promise<{ executableName: string; entrypoint: string; migrationEntrypoint?: string }> {
  const bunCommand = resolveBunCommand({ commandProbe, processEnv: env });
  if (!bunCommand) {
    throw new Error('[component-artifacts] bun is required to build server binary artifacts');
  }

  await ensureFileExists(entrypoint);
  const expectedEntrypointName = serverComponent === 'happier-server' ? 'main.ts' : 'main.light.ts';
  if (entrypoint !== join(repoRoot, 'apps', 'server', 'sources', expectedEntrypointName)) {
    throw new Error(`[component-artifacts] ${serverComponent} requires apps/server/sources/${expectedEntrypointName}`);
  }
  await runCommand(
    process.execPath,
    ['apps/server/scripts/buildSharedDeps.mjs', '--quiet'],
    { cwd: repoRoot, env },
  );
  const effectiveBuildDbProviders = resolveServerRuntimeSupportBuildDbProviders({
    serverComponent,
    buildDbProviders,
    env,
  });
  const sidecarEntries = includeRuntimeSupport
    ? await resolveServerBinarySidecarEntries({
        repoRoot,
        uiWebDistPath: String(uiWebDistPath ?? '').trim(),
        target,
        serverComponent,
        buildDbProviders: effectiveBuildDbProviders,
        env,
        runCommand,
        commandProbe,
      })
    : [];

  await rm(payloadDir, { recursive: true, force: true });
  await mkdir(payloadDir, { recursive: true });

  const executableName = resolveExecutableName({ baseName: 'happier-server', target });
  await compileBinary({
    entrypoint,
    bunTarget: target.bunTarget,
    outfile: join(payloadDir, executableName),
    cwd: repoRoot,
    externals,
    bunCommand,
    runCommand,
    buildRunnerEntrypoint: join(repoRoot, 'packages', 'cli-common', 'scripts', 'buildServerBunBinary.mjs'),
  });

  let migrationEntrypoint: string | undefined;
  if (serverComponent === 'happier-server') {
    const migrationSourceEntrypoint = join(repoRoot, 'apps', 'server', 'scripts', 'runtime', 'migrateFullRuntime.ts');
    await ensureFileExists(migrationSourceEntrypoint);
    migrationEntrypoint = resolveExecutableName({ baseName: 'happier-server-migrate', target });
    await compileBinary({
      entrypoint: migrationSourceEntrypoint,
      bunTarget: target.bunTarget,
      outfile: join(payloadDir, migrationEntrypoint),
      cwd: repoRoot,
      externals: [],
      bunCommand,
      runCommand,
    });
    if (includeRuntimeSupport) {
      await mkdir(join(payloadDir, 'runtime'), { recursive: true });
      await compilePrismaBinary({
        repoRoot,
        target,
        outfile: join(payloadDir, 'runtime', resolveExecutableName({ baseName: 'prisma-migrate', target })),
        bunCommand,
        runCommand,
      });
    }
  }

  if (includeRuntimeSupport) {
    await copyServerRuntimeSupportEntries({
      payloadDir,
      entries: sidecarEntries,
      target,
      buildDbProviders: effectiveBuildDbProviders,
      copyPath,
    });
  }
  await finalizeRuntimeArtifactPayload(payloadDir);

  return {
    executableName,
    entrypoint: executableName,
    ...(migrationEntrypoint ? { migrationEntrypoint } : {}),
  };
}

async function defaultCopyPath({
  sourcePath,
  destPath,
  recursive,
}: {
  sourcePath: string;
  destPath: string;
  recursive: boolean;
}): Promise<void> {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await cp(sourcePath, destPath, { recursive });
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : '';
      if (code === 'ENOENT' && attempt < 4) {
        lastError = error;
        await delay(100);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function copyPathWithRetry({
  sourcePath,
  destPath,
  recursive,
  copyPath,
}: {
  sourcePath: string;
  destPath: string;
  recursive: boolean;
  copyPath: (entry: { sourcePath: string; destPath: string; recursive: boolean }, fallbackCopyPath: typeof defaultCopyPath) => Promise<void>;
}): Promise<void> {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await copyPath({ sourcePath, destPath, recursive }, defaultCopyPath);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : '';
      if (code === 'ENOENT' && attempt < 4) {
        lastError = error;
        await delay(100);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
