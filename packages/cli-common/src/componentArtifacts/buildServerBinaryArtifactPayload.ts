import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SERVER_BINARY_TARGETS, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, type RunCommand } from './commands.js';
import { resolveRequestedServerDbProviders, resolveServerBinarySidecarEntries, type ServerDbProvider } from './serverSidecars.js';

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

export async function buildServerBinaryArtifactPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS }),
  entrypoint = join(repoRoot, 'apps', 'server', 'sources', 'main.light.ts'),
  externals = ['redis'],
  buildDbProviders,
  env = process.env,
  runCommand = execOrThrow,
  commandProbe = commandExists,
  compileBinary = compileBunBinary,
  copyPath = defaultCopyPath,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  entrypoint?: string;
  externals?: string[];
  buildDbProviders?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  compileBinary?: typeof compileBunBinary;
  copyPath?: (entry: { sourcePath: string; destPath: string; recursive: boolean }, fallbackCopyPath: typeof defaultCopyPath) => Promise<void>;
}): Promise<{ executableName: string; entrypoint: string }> {
  const bunCommand = resolveBunCommand({ commandProbe, processEnv: env });
  if (!bunCommand) {
    throw new Error('[component-artifacts] bun is required to build server binary artifacts');
  }

  await ensureFileExists(entrypoint);
  const sidecarEntries = await resolveServerBinarySidecarEntries({
    repoRoot,
    target,
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

  for (const entry of sidecarEntries) {
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
    buildDbProviders: String(buildDbProviders ?? 'all').trim() || 'all',
  });

  return {
    executableName,
    entrypoint: executableName,
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
