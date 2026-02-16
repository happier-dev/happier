import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { buildConnectedServiceCredentialRecord, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { repoRootDir } from '../../src/testkit/paths';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { yarnCommand } from '../../src/testkit/process/commands';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: connected services v2 materialize codex auth.json on spawn', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('seals a credential to cloud and materializes CODEX_HOME/auth.json on daemon spawn', async () => {
    const testDir = run.testDir('connected-services-v2-codex-materialize');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'connected-services-v2-codex-materialize',
      sessionIds: [],
      env: {
        CI: process.env.CI,
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
      },
    });

    await runLoggedCommand({
      command: yarnCommand(),
      args: ['-s', 'workspace', '@happier-dev/cli', 'build'],
      cwd: repoRootDir(),
      env: { ...process.env, CI: '1' },
      stdoutPath: resolve(join(testDir, 'cli.build.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.build.stderr.log')),
      timeoutMs: 240_000,
    });

    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken: 'e2e-access',
        refreshToken: 'e2e-refresh',
        idToken: 'e2e-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-1',
        providerEmail: 'user@example.test',
      },
    });

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const put = await fetchJson<{ success?: boolean }>(`${serverBaseUrl}/v2/connect/openai-codex/profiles/work/credential`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.test',
          providerAccountId: 'acct-1',
          expiresAt: record.expiresAt,
        },
      }),
      timeoutMs: 20_000,
    });
    expect(put.status).toBe(200);
    expect(put.data?.success).toBe(true);

    const acpStubProvider = resolve(
      join(repoRootDir(), 'packages', 'tests', 'fixtures', 'acp-stub-provider', 'acp-stub-provider.mjs'),
    );

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
        HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
        HAPPIER_CODEX_ACP_NPX_MODE: 'never',
        HAPPIER_CODEX_ACP_BIN: acpStubProvider,
        HAPPIER_DAEMON_HEARTBEAT_INTERVAL: '5000',
        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0',
      },
    });

    const daemonPort = daemon.state.httpPort;
    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

    await waitFor(async () => {
      const res = await daemonControlPostJson({ port: daemonPort, path: '/list', body: {}, controlToken });
      return res.status === 200;
    }, { timeoutMs: 20_000 });

    const materializationKey = 'connected-services-e2e-1';
    const spawnRes = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: daemonPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        agent: 'codex',
        sessionId: materializationKey,
        terminal: { mode: 'plain' },
        experimentalCodexAcp: true,
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
          HAPPIER_CODEX_ACP_NPX_MODE: 'never',
          HAPPIER_CODEX_ACP_BIN: acpStubProvider,
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', profileId: 'work' },
          },
        },
      },
      timeoutMs: 60_000,
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data?.success).toBe(true);
    expect(typeof spawnRes.data?.sessionId).toBe('string');

    const authPath = resolve(
      join(
        daemonHomeDir,
        'daemon',
        'connected-services',
        'materialized',
        materializationKey,
        'codex',
        'codex-home',
        'auth.json',
      ),
    );

    await waitFor(async () => {
      const raw = await readFile(authPath, 'utf8');
      const parsed = JSON.parse(raw) as any;
      return typeof parsed?.access_token === 'string' && parsed.access_token.length > 0;
    }, { timeoutMs: 20_000 });

    const materialized = JSON.parse(await readFile(authPath, 'utf8')) as any;
    expect(materialized).toEqual({
      access_token: 'e2e-access',
      refresh_token: 'e2e-refresh',
      id_token: 'e2e-id',
      account_id: 'acct-1',
    });

    await daemonControlPostJson({
      port: daemonPort,
      path: '/stop-session',
      body: { sessionId: spawnRes.data.sessionId },
      controlToken,
      timeoutMs: 30_000,
    }).catch(() => {});
  }, 240_000);
});

