import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { ensureCliSharedDepsBuilt } from '../../src/testkit/process/cliDist';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: manual connected-service auth switch', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('exposes the shared daemon switch path with a structured missing-session response', async () => {
    const testDir = run.testDir(`connected-services-manual-auth-switch-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
      },
    });

    const auth = await createTestAuth(server.baseUrl);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    await mkdir(daemonHomeDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    const { serverId } = await seedCliAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret,
    });
    writeTestManifestForServer({
      testDir,
      server,
      runId: run.runId,
      testName: 'connected-services-manual-auth-switch',
      sessionIds: [],
      env: {
        CI: process.env.CI,
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_ACTIVE_SERVER_ID: serverId,
      },
    });

    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_ACTIVE_SERVER_ID: serverId,
      HAPPIER_DAEMON_HEARTBEAT_INTERVAL: '5000',
      HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };

    await ensureCliSharedDepsBuilt({ testDir, env: daemonEnv });
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });

    await waitFor(async () => {
      const list = await daemonControlPostJson({
        port: daemon!.state.httpPort,
        path: '/list',
        controlToken: daemon!.state.controlToken,
      });
      return list.status === 200;
    }, { timeoutMs: 20_000 });

    const switchResult = await daemonControlPostJson<{
      ok?: boolean;
      result?: { ok?: boolean; errorCode?: string };
    }>({
      port: daemon.state.httpPort,
      path: '/connected-service-auth/session/switch',
      controlToken: daemon.state.controlToken,
      body: {
        sessionId: `missing-${randomUUID()}`,
        agentId: 'claude',
        expectedGroupGenerationByServiceId: {},
        bindings: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
          },
        },
      },
      timeoutMs: 90_000,
    });

    expect(switchResult.status).toBe(200);
    expect(switchResult.data).toMatchObject({
      ok: true,
      result: {
        ok: false,
        errorCode: 'session_not_found',
      },
    });
  }, 240_000);
});
