import { chmod, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureFileExists } from './commands.js';
import type { BinaryTarget } from './targets.js';

/**
 * The one native process-custody runtime. Its Go module (`apps/cli/native/processcustody`)
 * is built per target by the release native matrix — the same producer shape as the
 * CLIProxyAPI managed wrapper — and staged into `tools/unpacked` beside the other
 * runtime support binaries. The daemon-support payload builder never invokes a
 * Go toolchain itself: provisioning is a prebuilt-path input, and absence is
 * coherent (the support identity records it, and runtime custody fails closed
 * for Windows managed spawns without the staged helper).
 */
const PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME = 'happier-process-custody';

export function resolveProcessCustodyRuntimeExecutableName(target: BinaryTarget): string {
  return `${PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME}${target.exeExt}`;
}

export async function stageProcessCustodyRuntime({
  payloadDir,
  target,
  prebuiltExecutablePath,
}: {
  repoRoot: string;
  payloadDir: string;
  target: BinaryTarget;
  prebuiltExecutablePath?: string;
}): Promise<{ executablePath: string } | null> {
  if (!prebuiltExecutablePath) return null;
  await ensureFileExists(prebuiltExecutablePath);
  const toolsDir = join(payloadDir, 'tools', 'unpacked');
  const executablePath = join(toolsDir, resolveProcessCustodyRuntimeExecutableName(target));
  await mkdir(toolsDir, { recursive: true });
  await cp(prebuiltExecutablePath, executablePath);
  if (target.os !== 'windows') {
    await chmod(executablePath, 0o755);
  }
  await ensureFileExists(executablePath);
  return { executablePath };
}
