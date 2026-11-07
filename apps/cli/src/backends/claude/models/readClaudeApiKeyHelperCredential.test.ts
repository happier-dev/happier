import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import type { NativeCatalogCleanup } from '@/capabilities/probes/catalogProbeLifecycle';

import { readClaudeApiKeyHelperCredential } from './readClaudeApiKeyHelperCredential';

let claudeConfigDir: string;

async function writeUserSettings(settings: unknown): Promise<void> {
  await writeFile(join(claudeConfigDir, 'settings.json'), JSON.stringify(settings), 'utf8');
}

describe('readClaudeApiKeyHelperCredential', () => {
  beforeEach(async () => {
    claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-api-key-helper-'));
  });

  afterEach(async () => {
    await rm(claudeConfigDir, { recursive: true, force: true });
  });

  it('runs the apiKeyHelper from the Claude user settings and uses its trimmed output', async () => {
    await writeUserSettings({ apiKeyHelper: 'echo helper-token' });

    await expect(readClaudeApiKeyHelperCredential({ claudeConfigDir, env: process.env, timeoutMs: 5_000 }))
      .resolves.toEqual({ status: 'ok', value: 'helper-token' });
  });

  it('runs a relative credential command in the selected session directory', async () => {
    await writeFile(join(claudeConfigDir, 'session-key'), 'selected-session-token');
    const script = join(claudeConfigDir, 'relative-key.cjs');
    await writeFile(script, "process.stdout.write(require('node:fs').readFileSync('session-key', 'utf8'))");
    await writeUserSettings({ apiKeyHelper: `"${process.execPath}" "${script}"` });
    const params = { claudeConfigDir, cwd: claudeConfigDir, env: process.env, timeoutMs: 5_000 };

    await expect(readClaudeApiKeyHelperCredential(params))
      .resolves.toEqual({ status: 'ok', value: 'selected-session-token' });
  });

  it('passes the session environment to the helper', async () => {
    await writeUserSettings({
      apiKeyHelper: process.platform === 'win32' ? 'echo %HELPER_TOKEN%' : 'echo "$HELPER_TOKEN"',
    });

    await expect(readClaudeApiKeyHelperCredential({
      claudeConfigDir,
      env: { ...process.env, HELPER_TOKEN: 'from-session-env' },
      timeoutMs: 5_000,
    })).resolves.toEqual({ status: 'ok', value: 'from-session-env' });
  });

  it('skips absent or invalid JSON settings while retaining configured helper failures', async () => {
    const read = () => readClaudeApiKeyHelperCredential({ claudeConfigDir, env: process.env, timeoutMs: 5_000 });
    await expect(read()).resolves.toEqual({ status: 'absent' });
    await writeUserSettings({ theme: 'dark' });
    await expect(read()).resolves.toEqual({ status: 'absent' });
    await writeFile(join(claudeConfigDir, 'settings.json'), '{ not json', 'utf8');
    await expect(read()).resolves.toEqual({ status: 'absent' });
    for (const apiKeyHelper of ['exit 3', 'exit 0', 'echo first & echo second']) {
      await writeUserSettings({ apiKeyHelper });
      await expect(read()).resolves.toEqual({ status: 'failed' });
    }
  });

  it('does not run the user command after caller cancellation', async () => {
    const marker = join(claudeConfigDir, 'executed');
    const script = join(claudeConfigDir, 'key.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('key')`);
    await writeUserSettings({ apiKeyHelper: `"${process.execPath}" "${script}"` });
    const controller = new AbortController();
    controller.abort();
    await expect(readClaudeApiKeyHelperCredential({ claudeConfigDir, env: process.env, timeoutMs: 5_000,
      signal: controller.signal })).resolves.toEqual({ status: 'failed' });
    await expect(import('node:fs/promises').then(fs => fs.stat(marker))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('terminates the owned helper process when the caller cancels while it is running', async () => {
    const marker = join(claudeConfigDir, 'pid');
    const script = join(claudeConfigDir, 'waiting.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => process.exit(0), 2000)`);
    await writeUserSettings({ apiKeyHelper: `"${process.execPath}" "${script}"` });
    const controller = new AbortController();
    const reading = readClaudeApiKeyHelperCredential({ claudeConfigDir, env: process.env, timeoutMs: 5_000,
      signal: controller.signal });
    let pid = 0;
    try {
      await vi.waitFor(async () => { pid = Number(await readFile(marker, 'utf8')); expect(pid).toBeGreaterThan(0); });
      controller.abort();
      await expect(reading).resolves.toEqual({ status: 'failed' });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await reading;
    }
  });

  it('settles helper failure while retaining an observable denied-signal cleanup error', async () => {
    const marker = join(claudeConfigDir, 'denied-pids.json');
    const script = join(claudeConfigDir, 'denied.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.ppid, process.pid])); setInterval(() => {}, 1000)`);
    const afterScript = process.platform === 'win32' ? ' & rem fixture' : '; :';
    await writeUserSettings({ apiKeyHelper: `"${process.execPath}" "${script}"${afterScript}` });
    const ownedPids = async () => {
      try {
        const value: unknown = JSON.parse(await readFile(marker, 'utf8'));
        if (!Array.isArray(value) || value.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) {
          throw new Error('Invalid owned helper PIDs');
        }
        return value as number[];
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      }
    };
    let pids: number[] = [];
    const realKill = process.kill.bind(process);
    const signals = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal !== 0 && pids.includes(pid)) {
        throw Object.assign(new Error('fixture signal denied'), { code: 'EPERM' });
      }
      return realKill(pid, signal);
    });
    const controller = new AbortController();
    // Runner-owned teardown also runs on timeout and never awaits the reader under test.
    onTestFinished(async () => {
      signals.mockRestore();
      controller.abort();
      for (const pid of pids) {
        try { realKill(pid, 0); } catch { continue; }
        await killProcessTree({ pid });
      }
    });
    let cleanup: NativeCatalogCleanup | undefined;
    const reading = readClaudeApiKeyHelperCredential({ claudeConfigDir, env: process.env,
      timeoutMs: 10_000, signal: controller.signal, onNativeCleanup: next => { cleanup = next; } });
    await vi.waitFor(async () => { pids = await ownedPids(); expect(pids).toHaveLength(2); });
    controller.abort();
    await expect(reading).resolves.toEqual({ status: 'failed' });
    for (const pid of pids) expect(() => realKill(pid, 0)).not.toThrow();
    await expect(cleanup?.()).rejects.toMatchObject({ code: 'process_tree_termination_incomplete' });
  });

  it('settles cancellation after the shell exits while a background child retains stdout', async () => {
    const marker = join(claudeConfigDir, 'background.json');
    const script = join(claudeConfigDir, 'background.cjs');
    await writeFile(script, `const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 3000)'], { stdio: ['ignore', 'inherit', 'ignore'] });
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ shellPid: process.ppid, childPid: child.pid }));
      child.unref();`);
    // A second command keeps shells from replacing themselves with the script process.
    const afterScript = process.platform === 'win32' ? ' & rem fixture' : '; :';
    await writeUserSettings({ apiKeyHelper: `"${process.execPath}" "${script}"${afterScript}` });
    const controller = new AbortController();
    let settled = false;
    const reading = readClaudeApiKeyHelperCredential({ claudeConfigDir, env: process.env, timeoutMs: 5_000,
      signal: controller.signal }).then(result => { settled = true; return result; });
    let childPid = 0;
    try {
      await vi.waitFor(async () => {
        const fixture: { shellPid: number; childPid: number } = JSON.parse(await readFile(marker, 'utf8'));
        childPid = fixture.childPid;
        expect(() => process.kill(fixture.shellPid, 0)).toThrow();
      });
      controller.abort();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
      await expect(reading).resolves.toEqual({ status: 'failed' });
    } finally {
      controller.abort();
      // Only this fixture's recorded child is ours to stop; the exited shell no longer owns its PID.
      if (childPid) { try { process.kill(childPid); } catch {} }
      await reading;
    }
  });

  it('rejects an invalid header credential and accepts the documented maximum token length', async () => {
    const read = () => readClaudeApiKeyHelperCredential({ claudeConfigDir, env: process.env, timeoutMs: 5_000 });
    for (const token of ['a b', 'a\\nb']) {
      await writeUserSettings({ apiKeyHelper: `"${process.execPath}" -e "process.stdout.write('${token}')"` });
      await expect(read()).resolves.toEqual({ status: 'failed' });
    }
    // Use a script file so Windows command-line length does not become the tested boundary.
    const script = join(claudeConfigDir, 'key.cjs');
    await writeFile(script, "process.stdout.write('a'.repeat(16384) + '\\r\\n')");
    await writeUserSettings({ apiKeyHelper: `"${process.execPath}" "${script}"` });
    await expect(read()).resolves.toEqual({ status: 'ok', value: 'a'.repeat(16_384) });
    await writeFile(script, "process.stdout.write('a'.repeat(16385))");
    await expect(read()).resolves.toEqual({ status: 'failed' });
  });
});
