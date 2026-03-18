import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SERVER_BINARY_TARGETS, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, type RunCommand } from './commands.js';
import { resolveServerBinarySidecarEntries } from './serverSidecars.js';

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
