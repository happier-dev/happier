import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { startTestDaemon } from './daemon';

describe('startTestDaemon startup diagnostics', () => {
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
    expect(error.message).toContain('Bearer <redacted>');
    expect(error.message).toContain('controlToken');
    expect(error.message).toContain('controlToken=<redacted>');
    expect(error.message).toContain('controlToken status is unavailable');
    expect(error.message).not.toContain('private-access-token');
    expect(error.message).not.toContain('private-control-token');
    expect(error.message).not.toContain('private-unquoted-control-token');
    expect(error.message.length).toBeLessThan(12_000);
  });
});
