import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { waitForRegexInFile } from '../../src/testkit/waitForRegexInFile';

const run = createRunDirs({ runLabel: 'core' });

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

describe('core e2e: daemon machine socket auth handling', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('treats invalid auth as terminal and does not loop machine registration retries', async () => {
    const testDir = run.testDir('daemon-machine-socket-auth-invalid');
    const cliHome = resolve(join(testDir, 'cli-home'));
    const daemonDir = resolve(join(testDir, 'daemon'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(daemonDir, { recursive: true });

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
    });

    await seedCliAuthForServer({
      cliHome,
      serverUrl: server.baseUrl,
      token: 'invalid-daemon-token',
      secret: Uint8Array.from(randomBytes(32)),
    });

    daemon = await startTestDaemon({
      testDir: daemonDir,
      happyHomeDir: cliHome,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: cliHome,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS: '250',
      },
    });

    const daemonLogPath = daemon.state.daemonLogPath;
    if (typeof daemonLogPath !== 'string' || daemonLogPath.trim().length === 0) {
      throw new Error('Expected daemonLogPath to be present in daemon state');
    }

    await waitForRegexInFile({
      path: daemonLogPath,
      regex: /Machine registration rejected \(non-retryable\); giving up/,
      timeoutMs: 60_000,
      context: 'non-retryable machine registration rejection',
    });

    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const log = await readFile(daemonLogPath, 'utf8');
    expect(countOccurrences(log, 'Machine registration rejected (non-retryable); giving up')).toBe(1);
    expect(countOccurrences(log, 'Machine registration unavailable; retrying')).toBe(0);
  }, 180_000);
});
