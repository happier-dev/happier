import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SERVER_BINARY_TARGETS, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, type RunCommand } from './commands.js';
import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';
import { compilePrismaMigrateBinary } from './compilePrismaMigrateBinary.js';
import { resolveRequestedServerDbProviders, resolveServerBinarySidecarEntries, type ServerComponent } from './serverSidecars.js';

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

// Prisma client directories are always staged before pruning runs (resolveServerBinarySidecarEntries
// asserts their existence), so a missing directory here is not itself an error worth failing the
// build over -- but any other readdir failure (permission denied, path is actually a file, ...) must
// not be silently treated as "nothing to prune": that would let foreign-platform engines, unreachable
// WASM engines, or sourcemaps survive into the release artifact while validateServerPrismaEnginesForTarget
// still passes (it only checks that the *kept* engine file exists, not that pruning actually ran).
async function readdirOrEmptyIfMissing(directoryPath: string): Promise<Dirent<string>[]> {
  return readdir(directoryPath, { withFileTypes: true, encoding: 'utf8' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

// Each generated Prisma client directory (generated/*-client, node_modules/.prisma/client) ships a
// native query-engine file per platform (binaryTargets in schema.prisma lists all 5: linux-x64,
// linux-arm64, darwin-x64, darwin-arm64, windows-x64), but a single-platform release payload only
// ever runs on the one platform it was built for. Keep only that target's engine file.
async function pruneNonTargetPrismaEngineFiles(directoryPath: string, target: BinaryTarget): Promise<void> {
  const keepFileName = resolvePrismaEngineFileNameForTarget(target);
  const entries = await readdirOrEmptyIfMissing(directoryPath);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isEngineFile = entry.name.startsWith('libquery_engine-') || entry.name.startsWith('query_engine-');
    if (isEngineFile && entry.name !== keepFileName) {
      await rm(join(directoryPath, entry.name), { force: true });
    }
  }
}

// @prisma/client's runtime/ directory bundles WASM query engines for every database Prisma
// supports (postgresql, mysql, sqlite, cockroachdb, sqlserver) plus .map sourcemaps for every
// bundled format, regardless of which providers this build actually generated clients for.
// ServerDbProvider (serverSidecars.ts) is only ever 'sqlite' | 'mysql', and a postgres client is
// always generated as the default -- cockroachdb and sqlserver are never reachable, and
// sourcemaps are never needed by a production binary. Delete both classes unconditionally.
const PRISMA_RUNTIME_NEVER_REACHABLE_PROVIDER_MARKERS = ['.cockroachdb.', '.sqlserver.'];

async function pruneUnreachablePrismaRuntimeFiles(runtimeDirectoryPath: string): Promise<void> {
  const entries = await readdirOrEmptyIfMissing(runtimeDirectoryPath);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isNeverReachableProviderFile = PRISMA_RUNTIME_NEVER_REACHABLE_PROVIDER_MARKERS.some(
      (marker) => entry.name.includes(marker),
    );
    const isSourceMap = entry.name.endsWith('.map');
    if (isNeverReachableProviderFile || isSourceMap) {
      await rm(join(runtimeDirectoryPath, entry.name), { force: true });
    }
  }
}

export async function pruneServerPrismaArtifactsForTarget({
  payloadDir,
  target,
}: {
  payloadDir: string;
  target: BinaryTarget;
}): Promise<void> {
  await pruneNonTargetPrismaEngineFiles(join(payloadDir, 'node_modules', '.prisma', 'client'), target);

  const generatedDir = join(payloadDir, 'generated');
  const generatedEntries = await readdirOrEmptyIfMissing(generatedDir);
  for (const entry of generatedEntries) {
    if (entry.isDirectory() && entry.name.endsWith('-client')) {
      await pruneNonTargetPrismaEngineFiles(join(generatedDir, entry.name), target);
    }
  }

  await pruneUnreachablePrismaRuntimeFiles(join(payloadDir, 'node_modules', '@prisma', 'client', 'runtime'));
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

export async function buildServerBinaryArtifactPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS }),
  serverComponent = 'happier-server-light',
  entrypoint = join(repoRoot, 'apps', 'server', 'sources', 'main.light.ts'),
  externals = ['redis'],
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
  const sidecarEntries = await resolveServerBinarySidecarEntries({
    repoRoot,
    target,
    serverComponent,
    buildDbProviders,
    env,
    runCommand,
    commandProbe,
  });

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
    await mkdir(join(payloadDir, 'runtime'), { recursive: true });
    await compilePrismaBinary({
      repoRoot,
      target,
      outfile: join(payloadDir, 'runtime', resolveExecutableName({ baseName: 'prisma-migrate', target })),
      bunCommand,
      runCommand,
    });
  }

  for (const entry of sidecarEntries) {
    await mkdir(join(payloadDir, entry.targetPath, '..'), { recursive: true });
    await copyPathWithRetry({
      sourcePath: entry.sourcePath,
      destPath: join(payloadDir, entry.targetPath),
      recursive: true,
      copyPath,
    });
  }

  await pruneServerPrismaArtifactsForTarget({ payloadDir, target });

  await validateServerPrismaEnginesForTarget({
    payloadDir,
    target,
    buildDbProviders: serverComponent === 'happier-server'
      ? 'mysql'
      : String(buildDbProviders ?? 'all').trim() || 'all',
  });
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
