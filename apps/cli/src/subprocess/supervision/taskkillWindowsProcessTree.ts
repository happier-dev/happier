import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function taskkillWindowsProcessTree(input: Readonly<{
  pid: number;
  force: boolean;
}>): Promise<void> {
  const args = ['/PID', String(input.pid), '/T', ...(input.force ? ['/F'] : [])];
  try {
    await execFileAsync('taskkill', args);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    // 128 / "not found" means the process already exited — idempotent success.
    if (/not found|128/u.test(stderr)) return;
    throw error;
  }
}
