import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureFileExists, type RunCommand } from './commands.js';
import type { BinaryTarget } from './targets.js';

/**
 * The one native process-custody runtime. Its Go module (`apps/cli/native/processcustody`)
 * is built per target by the canonical daemon-support payload owner and staged
 * into `tools/unpacked` beside the CLIProxyAPI managed wrapper. Release callers
 * may supply an exact prebuilt from their native matrix, but omission is never
 * permission to publish an incomplete payload: the owner builds from current
 * source and fails closed if the Go toolchain is unavailable.
 */
const PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME = 'happier-process-custody';
const GO_BUILD_FLAGS = ['build', '-trimpath', '-buildvcs=false'];

function buildEnvironment(target: BinaryTarget): NodeJS.ProcessEnv {
  return { ...process.env, CGO_ENABLED: '0', GOOS: target.os,
    GOARCH: target.arch === 'x64' ? 'amd64' : target.arch };
}

/** Input identity for this producer's module, flags and effective toolchain. */
export async function readProcessCustodyRuntimeInputIdentity(repoRoot: string, target: BinaryTarget): Promise<string> {
  const cwd = join(repoRoot, 'apps', 'cli', 'native', 'processcustody');
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ recipe: GO_BUILD_FLAGS, os: target.os, arch: target.arch,
    go: execFileSync('go', ['env', '-json', 'GOVERSION', 'GOFLAGS', 'GOEXPERIMENT', 'GOAMD64', 'GOARM', 'GOARM64'],
      { cwd, env: buildEnvironment(target), encoding: 'utf8' }) }));
  async function visit(directory: string, prefix = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = `${prefix}${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, `${relativePath}/`);
      else hash.update(relativePath).update('\0').update(await readFile(path)).update('\0');
    }
  }
  await visit(cwd);
  return hash.digest('hex');
}

export function resolveProcessCustodyRuntimeExecutableName(target: BinaryTarget): string {
  return `${PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME}${target.exeExt}`;
}

export async function stageProcessCustodyRuntime({
  repoRoot,
  payloadDir,
  target,
  runCommand,
  prebuiltExecutablePath,
}: {
  repoRoot: string;
  payloadDir: string;
  target: BinaryTarget;
  runCommand: RunCommand;
  prebuiltExecutablePath?: string;
}): Promise<{ executablePath: string }> {
  const toolsDir = join(payloadDir, 'tools', 'unpacked');
  const executablePath = join(toolsDir, resolveProcessCustodyRuntimeExecutableName(target));
  await mkdir(toolsDir, { recursive: true });
  if (prebuiltExecutablePath) {
    await ensureFileExists(prebuiltExecutablePath);
    // A previous test can still be executing the published helper. Copying
    // over that inode fails with ETXTBSY on Linux; publish a complete replacement.
    // Metro watches source payloads: removing a transient directory there can
    // race its directory watcher. Keep build scratch outside the checkout.
    const stagingDir = await mkdtemp(join(tmpdir(), '.process-custody-'));
    const stagedExecutable = join(stagingDir, resolveProcessCustodyRuntimeExecutableName(target));
    try {
      await cp(prebuiltExecutablePath, stagedExecutable);
      if (target.os !== 'windows') await chmod(stagedExecutable, 0o755);
      try {
        await rename(stagedExecutable, executablePath);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EXDEV') throw error;
        // OS temp may be on another volume. A sibling file guarantees the final
        // rename stays on the destination filesystem without overwriting a live
        // inode. Metro's existing .tmp.* publication exclusion covers this file
        // even when the payload lives in watched source; no directory is added.
        const replacement = join(toolsDir, `.tmp.process-custody-${randomUUID()}`);
        // copyFile removes a partial destination on failure. EXCL ensures this
        // invocation owns the file before the rename/cleanup below.
        await copyFile(stagedExecutable, replacement, constants.COPYFILE_EXCL);
        try {
          await rename(replacement, executablePath);
        } finally {
          await rm(replacement, { force: true });
        }
      }
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  } else {
    await runCommand('go', [
      ...GO_BUILD_FLAGS,
      '-o',
      executablePath,
      '.',
    ], {
      cwd: join(repoRoot, 'apps', 'cli', 'native', 'processcustody'),
      env: buildEnvironment(target),
    });
  }
  if (target.os !== 'windows' && !prebuiltExecutablePath) {
    await chmod(executablePath, 0o755);
  }
  await ensureFileExists(executablePath);
  return { executablePath };
}
