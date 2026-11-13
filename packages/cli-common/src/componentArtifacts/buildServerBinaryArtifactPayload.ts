import { copyFile, cp, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { SERVER_BINARY_TARGETS, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, type RunCommand } from './commands.js';
import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';
import { compilePrismaMigrateBinary } from './compilePrismaMigrateBinary.js';
import { stageIrohNativeReleaseEvidence } from './stageIrohNativeReleaseEvidence.js';
import { writePersonalHomeServerArtifactCapability } from '../firstPartyRuntime/personalHome/artifactContract.js';
import { resolveServerRuntimePrismaEngineFileName } from '../firstPartyRuntime/serverRuntimeArtifactLayout.js';
import {
  isServerRuntimeSupportPayloadPath,
  resolveRequestedServerDbProviders,
  resolveServerBinarySidecarEntries,
  resolveServerRuntimeSupportBuildDbProviders,
  serverRuntimeSupportNeedsPackagedMigration,
  type ServerComponent,
  type StageEntry,
} from './serverSidecars.js';

export const SERVER_BINARY_DEFAULT_EXTERNALS = Object.freeze(['redis']);

export type PublicProfileAssetFile = Readonly<{ filename: string; sourcePath: string }>;

/** The server owns the face list; the esbuild and source runtimes stage from the same module. */
async function readServerPublicProfileAssetFiles(repoRoot: string): Promise<readonly PublicProfileAssetFile[]> {
  const owner = pathToFileURL(join(repoRoot, 'apps', 'server', 'scripts', 'publicProfileAssetFiles.mjs')).href;
  const { readPublicProfileAssetFiles } = await import(owner) as {
    readPublicProfileAssetFiles: (input: { projectDir: string }) => Promise<readonly PublicProfileAssetFile[]>;
  };
  return await readPublicProfileAssetFiles({ projectDir: join(repoRoot, 'apps', 'server') });
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
  const engineFileName = resolveServerRuntimePrismaEngineFileName({
    platform: target.os,
    arch: target.arch,
  });
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
  void serverComponent;
  await mkdir(join(payloadDir, 'runtime'), { recursive: true });
  if (serverRuntimeSupportNeedsPackagedMigration(buildDbProviders)) {
    const resolvedRepoRoot = String(repoRoot ?? '').trim();
    if (!resolvedRepoRoot) {
      throw new Error('[component-artifacts] server runtime support requires a repository root for Prisma migrate.');
    }
    await compilePrismaBinary({
      repoRoot: resolvedRepoRoot,
      target,
      outfile: join(payloadDir, 'runtime', resolveExecutableName({ baseName: 'prisma-migrate', target })),
      env,
      commandProbe,
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
  includeIrohNativeReleaseEvidence = false,
  readPublicProfileAssetFiles = readServerPublicProfileAssetFiles,
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
  includeIrohNativeReleaseEvidence?: boolean;
  readPublicProfileAssetFiles?: (repoRoot: string) => Promise<readonly PublicProfileAssetFile[]>;
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
    repoRoot,
    entrypoint,
    bunTarget: target.bunTarget,
    outfile: join(payloadDir, executableName),
    cwd: repoRoot,
    externals,
    bunCommand,
    runCommand,
    buildRunnerEntrypoint: join(repoRoot, 'packages', 'cli-common', 'scripts', 'buildServerBunBinary.mjs'),
  });

  // The compiled executable's import.meta.url is Bun's virtual /$bunfs root, so the server
  // reads public-profile faces beside the executable (publicProfileFonts.ts).
  const publicProfileAssetsDir = join(payloadDir, 'assets', 'public-profile');
  await mkdir(publicProfileAssetsDir, { recursive: true });
  for (const { filename, sourcePath } of await readPublicProfileAssetFiles(repoRoot)) {
    await copyFile(sourcePath, join(publicProfileAssetsDir, filename));
  }

  let migrationEntrypoint: string | undefined;
  if (serverRuntimeSupportNeedsPackagedMigration(effectiveBuildDbProviders)) {
    const migrationSourceEntrypoint = join(repoRoot, 'apps', 'server', 'scripts', 'runtime', 'migrateFullRuntime.ts');
    await ensureFileExists(migrationSourceEntrypoint);
    migrationEntrypoint = resolveExecutableName({ baseName: 'happier-server-migrate', target });
    await compileBinary({
      repoRoot,
      entrypoint: migrationSourceEntrypoint,
      bunTarget: target.bunTarget,
      outfile: join(payloadDir, migrationEntrypoint),
      cwd: repoRoot,
      externals: [],
      bunCommand,
      runCommand,
      buildRunnerEntrypoint: join(repoRoot, 'packages', 'cli-common', 'scripts', 'buildServerBunBinary.mjs'),
    });
  }
  if (includeRuntimeSupport && migrationEntrypoint) {
    await mkdir(join(payloadDir, 'runtime'), { recursive: true });
    await compilePrismaBinary({
      repoRoot,
      target,
      outfile: join(payloadDir, 'runtime', resolveExecutableName({ baseName: 'prisma-migrate', target })),
      bunCommand,
      runCommand,
      env,
    });
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
  await stageIrohNativeReleaseEvidence({
    repoRoot,
    payloadDir,
    required: includeIrohNativeReleaseEvidence,
    runCommand,
  });
  await writePersonalHomeServerArtifactCapability(payloadDir);
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
      await cp(sourcePath, destPath, { recursive, filter: isServerRuntimeSupportPayloadPath });
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
