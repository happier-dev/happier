import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { windowsSystemToolCommand } from '@happier-dev/cli-common/process';

const execFileAsync = promisify(execFile);

/** `taskkill` exits 128 when the pid is not present — the one benign, idempotent outcome. */
const TASKKILL_PROCESS_NOT_FOUND_EXIT_CODE = 128;

/** Process-spawn boundary; injected in tests so no real `taskkill` is ever invoked. */
export type TaskkillExecFile = (command: string, args: readonly string[]) => Promise<unknown>;

export async function taskkillWindowsProcessTree(input: Readonly<{
  pid: number;
  force: boolean;
  execFile?: TaskkillExecFile;
}>): Promise<void> {
  const args = ['/PID', String(input.pid), '/T', ...(input.force ? ['/F'] : [])];
  const run = input.execFile ?? ((command, commandArgs) => execFileAsync(command, [...commandArgs]));
  try {
    await run(windowsSystemToolCommand('taskkill.exe'), args);
  } catch (error) {
    // Classify on the EXIT CODE, as a number. The previous test was
    // `/not found|128/.test(stderr)` — a substring match against text that carries the pid, so
    // `PID 1284` reported an access-denied refusal as an idempotent success, and any localized
    // Windows lost the `not found` branch entirely. An exit code is neither positional nor
    // translated. Everything except 128 — including exit 1 for access denied — surfaces.
    const code = (error as { code?: unknown }).code;
    if (code === TASKKILL_PROCESS_NOT_FOUND_EXIT_CODE) return;
    throw error;
  }
}
