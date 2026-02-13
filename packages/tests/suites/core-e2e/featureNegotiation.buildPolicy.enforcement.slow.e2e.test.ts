import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { withTestDaemon } from '../../src/testkit/daemon/daemon';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: build-policy enforcement', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('hard-disables automations in the daemon when build policy denies the feature', async () => {
    const testDir = run.testDir('feature-negotiation-build-policy-deny-automations');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const daemonDir = resolve(join(testDir, 'daemon'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(daemonDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

    await withTestDaemon({
      testDir: daemonDir,
      happyHomeDir: cliHome,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_HOME_DIR: cliHome,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        // Ensure local policy is not the blocking axis.
        HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
        // The behavior under test.
        HAPPIER_BUILD_FEATURES_DENY: 'automations',
      },
      run: async (daemon) => {
        const daemonLogPath = daemon.state.daemonLogPath;
        if (typeof daemonLogPath !== 'string' || daemonLogPath.trim().length === 0) {
          throw new Error('Expected daemonLogPath to be present in daemon state');
        }

        await waitFor(
          async () => {
            const log = await readFile(daemonLogPath, 'utf8').catch(() => '');
            return log.includes('Automation worker disabled');
          },
          { timeoutMs: 45_000, context: 'daemon automation worker disabled log' },
        );

        const log = await readFile(daemonLogPath, 'utf8');
        expect(log).toContain('Automation worker disabled');
      },
    });
  }, 180_000);
});
