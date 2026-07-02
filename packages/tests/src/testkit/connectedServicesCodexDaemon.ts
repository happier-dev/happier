import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';

import { buildConnectedServiceCredentialRecord, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { createTestAuth, type TestAuth } from './auth';
import { seedCliAuthForServer, seedCliDataKeyAuthForServer } from './cliAuth';
import { daemonControlPostJson } from './daemon/controlServerClient';
import { startTestDaemon, type StartedDaemon } from './daemon/daemon';
import { fetchJson } from './http';
import { writeTestManifestForServer } from './manifestForServer';
import { repoRootDir } from './paths';
import { ensureCliSharedDepsBuilt } from './process/cliDist';
import { startServerLight, type StartedServer } from './process/serverLight';
import { waitFor } from './timing';

export type FakeTokenServerRequest = Readonly<{
  path: string;
  method: string;
  body: string;
}>;

export async function startFakeTokenServer(params: Readonly<{
  respond: (request: FakeTokenServerRequest) => Readonly<{ status: number; body: unknown }>;
}>): Promise<Readonly<{
  tokenUrl: string;
  requests: () => readonly FakeTokenServerRequest[];
  stop: () => Promise<void>;
}>> {
  const requests: FakeTokenServerRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const request = { path: url.pathname, method: req.method ?? 'GET', body };
      requests.push(request);
      const response = params.respond(request);
      res.statusCode = response.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response.body));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('fake token server missing address');

  return {
    tokenUrl: `http://127.0.0.1:${address.port}/oauth/token`,
    requests: () => [...requests],
    stop: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

export type StartedConnectedServicesCodexDaemonFixture = Readonly<{
  server: StartedServer;
  serverBaseUrl: string;
  daemonServerBaseUrl: string;
  auth: TestAuth;
  accountSecret: Uint8Array;
  machineId: string;
  machineKey: Uint8Array | null;
  daemon: StartedDaemon;
  daemonHomeDir: string;
  workspaceDir: string;
  serverId: string;
  daemonPort: number;
  controlToken: string | undefined;
  acpStubProvider: string;
}>;

export async function startConnectedServicesCodexDaemon(params: Readonly<{
  testDir: string;
  testName: string;
  tokenUrl: string;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: number;
  authMode?: 'legacy' | 'dataKey';
  serverExtraEnv?: NodeJS.ProcessEnv;
  daemonExtraEnv?: Readonly<Record<string, string>>;
  resolveDaemonServerBaseUrl?: (serverBaseUrl: string) => Promise<string>;
}>): Promise<StartedConnectedServicesCodexDaemonFixture> {
  const startedAt = new Date().toISOString();
  const server = await startServerLight({
    testDir: params.testDir,
    dbProvider: 'sqlite',
    extraEnv: params.serverExtraEnv,
  });
  const serverBaseUrl = server.baseUrl;
  const auth = await createTestAuth(serverBaseUrl);
  const daemonServerBaseUrl = params.resolveDaemonServerBaseUrl
    ? await params.resolveDaemonServerBaseUrl(serverBaseUrl)
    : serverBaseUrl;
  const daemonHomeDir = resolve(join(params.testDir, 'daemon-home'));
  const workspaceDir = resolve(join(params.testDir, 'workspace'));
  await mkdir(daemonHomeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const authMode = params.authMode ?? 'legacy';
  const secret = Uint8Array.from(randomBytes(32));
  let machineKey: Uint8Array | null = null;
  const seeded = await (async () => {
    if (authMode === 'dataKey') {
      machineKey = Uint8Array.from(randomBytes(32));
      return await seedCliDataKeyAuthForServer({
        cliHome: daemonHomeDir,
        serverUrl: daemonServerBaseUrl,
        token: auth.token,
        machineKey,
      });
    }

    return await seedCliAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: daemonServerBaseUrl,
      token: auth.token,
      secret,
    });
  })();
  const { serverId, machineId } = seeded;

  writeTestManifestForServer({
    testDir: params.testDir,
    server,
    startedAt,
    runId: params.testName,
    testName: params.testName,
    sessionIds: [],
    env: {
      CI: process.env.CI,
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: daemonServerBaseUrl,
      HAPPIER_WEBAPP_URL: daemonServerBaseUrl,
    },
  });

  const now = Date.now();
  const record = buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: params.expiresAt,
    oauth: {
      accessToken: params.accessToken,
      refreshToken: params.refreshToken,
      idToken: params.idToken,
      scope: null,
      tokenType: null,
      providerAccountId: 'acct-1',
      providerEmail: 'user@example.test',
    },
  });
  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: machineKey ? { type: 'dataKey', machineKey } : { type: 'legacy', secret },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });
  const putHolder: {
    current: Awaited<ReturnType<typeof fetchJson<{ success?: boolean }>>> | null;
  } = { current: null };
  await waitFor(async () => {
    try {
      putHolder.current = await fetchJson<{ success?: boolean }>(`${serverBaseUrl}/v2/connect/openai-codex/profiles/work/credential`, {
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
      return putHolder.current.status === 200 && putHolder.current.data?.success === true;
    } catch {
      return false;
    }
  }, { timeoutMs: 30_000 });
  const put = putHolder.current;
  if (!put) throw new Error('failed to seed connected service credential');

  const acpStubProvider = resolve(
    join(repoRootDir(), 'packages', 'tests', 'fixtures', 'acp-stub-provider', 'acp-stub-provider.mjs'),
  );
  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_HOME_DIR: daemonHomeDir,
    HAPPIER_SERVER_URL: daemonServerBaseUrl,
    HAPPIER_WEBAPP_URL: daemonServerBaseUrl,
    HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
    HAPPIER_CODEX_ACP_BIN: acpStubProvider,
    HAPPIER_DAEMON_HEARTBEAT_INTERVAL: '5000',
    HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '1',
    HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS: '300000',
    HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: params.tokenUrl,
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    ...params.daemonExtraEnv,
  };

  await ensureCliSharedDepsBuilt({ testDir: params.testDir, env: daemonEnv });
  const daemon = await startTestDaemon({ testDir: params.testDir, happyHomeDir: daemonHomeDir, env: daemonEnv });
  const daemonPort = daemon.state.httpPort;
  const controlToken = daemon.state.controlToken;
  await waitFor(async () => {
    const res = await daemonControlPostJson({ port: daemonPort, path: '/list', body: {}, controlToken });
    return res.status === 200;
  }, { timeoutMs: 20_000 });

  return {
    server,
    serverBaseUrl,
    daemonServerBaseUrl,
    auth,
    accountSecret: secret,
    machineId,
    machineKey,
    daemon,
    daemonHomeDir,
    workspaceDir,
    serverId,
    daemonPort,
    controlToken,
    acpStubProvider,
  };
}

export async function spawnConnectedCodexSession(
  fixture: StartedConnectedServicesCodexDaemonFixture,
  sessionId: string,
  opts?: Readonly<{ environmentVariables?: NodeJS.ProcessEnv }>,
) {
  return await daemonControlPostJson<{ success?: boolean; sessionId?: string; error?: string; errorCode?: string }>({
    port: fixture.daemonPort,
    path: '/spawn-session',
    controlToken: fixture.controlToken,
    body: {
      directory: fixture.workspaceDir,
      agent: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      sessionId,
      terminal: { mode: 'plain' },
      experimentalCodexAcp: true,
      environmentVariables: {
        HAPPIER_HOME_DIR: fixture.daemonHomeDir,
        HAPPIER_SERVER_URL: fixture.daemonServerBaseUrl,
        HAPPIER_WEBAPP_URL: fixture.daemonServerBaseUrl,
        HAPPIER_VARIANT: 'dev',
        HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
        HAPPIER_CODEX_ACP_BIN: fixture.acpStubProvider,
        ...(opts?.environmentVariables ?? {}),
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        },
      },
    },
    timeoutMs: 150_000,
  });
}

export function codexAuthPath(fixture: StartedConnectedServicesCodexDaemonFixture): string {
  return resolve(
    join(
      fixture.daemonHomeDir,
      'servers',
      fixture.serverId,
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      'work',
      'codex',
      'codex-home',
      'auth.json',
    ),
  );
}
