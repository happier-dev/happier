import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { startTestDaemon, waitForDaemonState } from './daemon';

describe('startTestDaemon startup diagnostics', () => {
  it('requires acknowledged Machine control when enrollment requests it, while retaining local-control startup', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-readiness-'));
    const statePath = join(homeDir, 'daemon.state.json');
    const listeningState = { pid: process.pid, httpPort: 12345, machineControlReady: false };
    try {
      await writeFile(statePath, JSON.stringify(listeningState));
      expect(await waitForDaemonState(homeDir)).toMatchObject(listeningState);
      await expect(waitForDaemonState(homeDir, { timeoutMs: 1, requireMachineControlReady: true }))
        .rejects.toThrow('Timed out waiting for daemon.state.json');
      await writeFile(statePath, JSON.stringify({ ...listeningState, machineControlReady: true }));
      expect(await waitForDaemonState(homeDir, { requireMachineControlReady: true }))
        .toMatchObject({ machineControlReady: true });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('retains bounded redacted child output after failed-start cleanup removes the log files', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-startup-diagnostics-'));
    const homeDir = resolve(testDir, 'home');
    const fakeDaemonPath = resolve(testDir, 'failed-daemon.mjs');
    await mkdir(homeDir, { recursive: true });
    await writeFile(
      fakeDaemonPath,
      [
        `process.stdout.write('${'x'.repeat(5_000)}stdout-cause\\n');`,
        "process.stderr.write('Bearer private-access-token\\n');",
        "process.stderr.write('{\"controlToken\":\"private-control-token\"}\\n');",
        "process.stderr.write('controlToken=private-unquoted-control-token\\n');",
        "process.stderr.write('controlToken status is unavailable\\n');",
        "process.stderr.write('stderr-cause\\n');",
        'process.exit(1);',
      ].join('\n'),
      'utf8',
    );

    const error = await startTestDaemon({
      testDir,
      happyHomeDir: homeDir,
      env: {},
      startupTimeoutMs: 1_000,
      cliLaunchSpec: {
        command: process.execPath,
        args: [fakeDaemonPath],
        cwd: testDir,
        env: {},
      },
    }).then(
      async (daemon) => {
        await daemon.stop();
        return new Error('Expected daemon startup to fail');
      },
      (startupError: unknown) => (
        startupError instanceof Error
          ? startupError
          : new Error(String(startupError))
      ),
    );

    await rm(testDir, { recursive: true, force: true });

    expect(error.message).toContain('stdout-cause');
    expect(error.message).toContain('stderr-cause');
    expect(error.message).toContain('Bearer ');
    expect(error.message).toContain('controlToken');
    expect(error.message).toContain('controlToken=<redacted>');
    expect(error.message).toContain('controlToken status is unavailable');
    expect(error.message).not.toContain('private-access-token');
    expect(error.message).not.toContain('private-control-token');
    expect(error.message).not.toContain('private-unquoted-control-token');
    expect(error.message.length).toBeLessThan(12_000);
  });
});
