import { chmod, cp, mkdir } from 'node:fs/promises';
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
    await cp(prebuiltExecutablePath, executablePath);
  } else {
    const goArch = target.arch === 'x64' ? 'amd64' : target.arch;
    await runCommand('go', [
      'build',
      '-trimpath',
      '-buildvcs=false',
      '-o',
      executablePath,
      '.',
    ], {
      cwd: join(repoRoot, 'apps', 'cli', 'native', 'processcustody'),
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: target.os,
        GOARCH: goArch,
      },
    });
  }
  if (target.os !== 'windows') {
    await chmod(executablePath, 0o755);
  }
  await ensureFileExists(executablePath);
  return { executablePath };
}
