import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: direct OpenCode sessions browse/link/tail', () => {
  let appServer: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let fakeOpenCodeServer: Server | null = null;
  let fakeOpenCodeBaseUrl = '';

  const openCodeMessages: Array<Record<string, unknown>> = [];
  const openCodeSessions: Array<Record<string, unknown>> = [];
  let openCodeStatuses: Record<string, { type?: string }> = {};

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    if (fakeOpenCodeServer) {
      await new Promise<void>((resolveClose, rejectClose) => {
        fakeOpenCodeServer?.close((error) => (error ? rejectClose(error) : resolveClose()));
      }).catch(() => {});
    }
    fakeOpenCodeServer = null;
    fakeOpenCodeBaseUrl = '';
    openCodeMessages.length = 0;
    openCodeSessions.length = 0;
    openCodeStatuses = {};
    await appServer?.stop().catch(() => {});
    appServer = null;
  });

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await appServer?.stop().catch(() => {});
    if (fakeOpenCodeServer) {
      await new Promise<void>((resolveClose) => {
        fakeOpenCodeServer?.close(() => resolveClose());
      }).catch(() => {});
    }
  });

  it('lists provider-backed OpenCode sessions, links one idempotently, and tails appended server messages', async () => {
    const testDir = run.testDir('direct-sessions-opencode-browse-tail');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));

    await mkdir(daemonHomeDir, { recursive: true });

    openCodeSessions.push({
      id: 'sess-opencode-direct-core',
      title: 'OpenCode direct core session',
      directory: '/tmp/opencode-direct-core-project',
      createdAt: '2026-03-05T10:00:00.000Z',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
    openCodeMessages.push(
      {
        id: 'oc-user-1',
        role: 'user',
        content: 'older opencode direct message',
        createdAt: '2026-03-05T10:00:01.000Z',
      },
      {
        id: 'oc-agent-1',
        role: 'assistant',
        content: 'older opencode direct reply',
        createdAt: '2026-03-05T10:00:02.000Z',
      },
      {
        id: 'oc-user-2',
        role: 'user',
        content: 'latest opencode direct message',
        createdAt: '2026-03-05T10:00:03.000Z',
      },
      {
        id: 'oc-agent-2',
        role: 'assistant',
        content: 'latest opencode direct reply',
        createdAt: '2026-03-05T10:00:04.000Z',
      },
    );
    openCodeStatuses = {
      'sess-opencode-direct-core': { type: 'running' },
    };

    fakeOpenCodeServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/global/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ healthy: true, version: 'fake-opencode-1' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/session') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(openCodeSessions));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/session/status') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(openCodeStatuses));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/session/sess-opencode-direct-core/message') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(openCodeMessages));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolveListen) => {
      fakeOpenCodeServer!.listen(0, '127.0.0.1', () => resolveListen());
    });
    const fakeAddress = fakeOpenCodeServer.address();
    if (!fakeAddress || typeof fakeAddress === 'string') {
      throw new Error('Failed to resolve fake OpenCode server address');
    }
    fakeOpenCodeBaseUrl = `http://127.0.0.1:${fakeAddress.port}`;

    appServer = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      },
    });
    const auth = await createTestAuth(appServer.baseUrl);

    const machineKey = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliDataKeyAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: appServer.baseUrl,
      token: auth.token,
      machineKey,
    });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: appServer.baseUrl,
        HAPPIER_OPENCODE_SERVER_URL: fakeOpenCodeBaseUrl,
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    const ui = createUserScopedSocketCollector(appServer.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000, context: 'socket connected for direct OpenCode sessions e2e' });

    const machineRpc = createDataKeyRpcClient(ui, machineKey);

    let candidatesResult: any = null;
    await waitFor(
      async () => {
        const res = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST}`, {
          machineId: seeded.machineId,
          providerId: 'opencode',
          source: { kind: 'opencodeServer', baseUrl: null, directory: null },
          limit: 20,
        });
        if (!res.ok) return false;
        candidatesResult = res.result;
        if ((candidatesResult as { ok?: unknown })?.ok === false) {
          throw new Error(`direct OpenCode candidates rpc returned ${JSON.stringify(candidatesResult)}`);
        }
        return Array.isArray((candidatesResult as any)?.candidates) && (candidatesResult as any).candidates.length > 0;
      },
      { timeoutMs: 30_000, context: 'direct OpenCode candidates available' },
    );

    expect(candidatesResult).toEqual(expect.objectContaining({
      ok: true,
      candidates: expect.arrayContaining([
        expect.objectContaining({
          remoteSessionId: 'sess-opencode-direct-core',
          title: 'OpenCode direct core session',
          activity: 'running',
        }),
      ]),
    }));

    const firstLink = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
      machineId: seeded.machineId,
      providerId: 'opencode',
      remoteSessionId: 'sess-opencode-direct-core',
      titleHint: 'OpenCode direct core session',
      directoryHint: '/tmp/opencode-direct-core-project',
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
    });
    const firstLinkResult = unwrapDataKeyRpcResult(firstLink, 'direct OpenCode first link');
    expect(firstLinkResult).toEqual(expect.objectContaining({
      ok: true,
      created: true,
    }));

    const secondLink = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
      machineId: seeded.machineId,
      providerId: 'opencode',
      remoteSessionId: 'sess-opencode-direct-core',
      titleHint: 'OpenCode direct core session',
      directoryHint: '/tmp/opencode-direct-core-project',
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
    });
    const secondLinkResult = unwrapDataKeyRpcResult(secondLink, 'direct OpenCode second link');
    expect((secondLinkResult as any)?.sessionId).toBe((firstLinkResult as any)?.sessionId);
    expect(secondLinkResult).toEqual(expect.objectContaining({
      ok: true,
      created: false,
    }));

    const page = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE}`, {
      machineId: seeded.machineId,
      providerId: 'opencode',
      remoteSessionId: 'sess-opencode-direct-core',
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      direction: 'older',
    });
    const pageResult = unwrapDataKeyRpcResult(page, 'direct OpenCode transcript page');
    expect(pageResult).toEqual(expect.objectContaining({
      ok: true,
      hasMore: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          raw: expect.objectContaining({
            role: 'user',
          }),
        }),
      ]),
    }));
    expect(((pageResult as any).items as any[]).some((item) => item?.raw?.content?.text === 'latest opencode direct message')).toBe(true);

    const tailStart = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER}`, {
      machineId: seeded.machineId,
      providerId: 'opencode',
      remoteSessionId: 'sess-opencode-direct-core',
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      cursor: 'tail',
    });
    const tailStartResult = unwrapDataKeyRpcResult(tailStart, 'direct OpenCode transcript tail start');
    expect(tailStartResult).toEqual(expect.objectContaining({
      ok: true,
      items: [],
    }));

    openCodeMessages.push({
      id: 'oc-user-3',
      role: 'user',
      content: 'appended opencode direct message',
      createdAt: '2026-03-05T10:00:05.000Z',
    });

    let tailResult: any = null;
    await waitFor(
      async () => {
        const res = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER}`, {
          machineId: seeded.machineId,
          providerId: 'opencode',
          remoteSessionId: 'sess-opencode-direct-core',
          source: { kind: 'opencodeServer', baseUrl: null, directory: null },
          cursor: (tailStartResult as any)?.nextCursor ?? 'tail',
        });
        if (!res.ok) return false;
        tailResult = unwrapDataKeyRpcResult(res, 'direct OpenCode transcript tail read_after');
        return Array.isArray((tailResult as any)?.items) && (tailResult as any).items.some((item: any) => item?.raw?.content?.text === 'appended opencode direct message');
      },
      { timeoutMs: 20_000, context: 'direct OpenCode tail catches appended message' },
    );

    expect(tailResult).toEqual(expect.objectContaining({
      ok: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          raw: expect.objectContaining({
            role: 'user',
            content: expect.objectContaining({
              text: 'appended opencode direct message',
            }),
          }),
        }),
      ]),
    }));

    ui.close();
  }, 300_000);
});
