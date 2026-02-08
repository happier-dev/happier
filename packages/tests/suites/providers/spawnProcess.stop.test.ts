import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { spawnLoggedProcess } from '../../src/testkit/process/spawnProcess';

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForText(path: string, timeoutMs = 3_000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim();
      if (text.length > 0) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return '';
}

describe('providers: spawn process stop', () => {
  it('terminates spawned child process trees', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-spawn-stop-'));
    const stdoutPath = join(dir, 'stdout.log');
    const stderrPath = join(dir, 'stderr.log');

    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'process.stdout.write(String(child.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n');

    const proc = spawnLoggedProcess({
      command: process.execPath,
      args: ['-e', script],
      cwd: dir,
      stdoutPath,
      stderrPath,
    });

    let grandchildPid = 0;
    try {
      const text = await waitForText(stdoutPath);
      grandchildPid = Number.parseInt(text, 10);
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);

      await proc.stop();

      expect(isProcessAlive(proc.child.pid ?? -1)).toBe(false);
      expect(isProcessAlive(grandchildPid)).toBe(false);
    } finally {
      if (grandchildPid > 0 && isProcessAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  });
});
