import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import {
  replaceTestDaemonWithoutStoppingSessions,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { fetchSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: direct OpenCode sessions browse/link/tail', () => {
  let appServer: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let retiredDaemon: StartedDaemon | null = null;
  let fakeOpenCodeServer: Server | null = null;
  let fakeOpenCodeBaseUrl = '';
  const daemonStartupTimeoutMs = 90_000;

  const openCodeMessages: Array<Record<string, unknown>> = [];
  const openCodeSessions: Array<Record<string, unknown>> = [];
  let openCodeStatuses: Record<string, { type?: string }> = {};
  const openCodeSseClients = new Set<ServerResponse>();
  let openCodeObserverConnectionCount = 0;
  let openCodeMessageReadCount = 0;
  let holdNextOpenCodeMessageRead: Promise<void> | null = null;

  const emitOpenCodeEvent = (event: Record<string, unknown>) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of openCodeSseClients) client.write(frame);
  };

  const closeFakeOpenCodeServer = async (): Promise<void> => {
    const server = fakeOpenCodeServer;
    fakeOpenCodeServer = null;
    for (const client of openCodeSseClients) client.end();
    openCodeSseClients.clear();
    if (!server) return;
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
  };

  afterEach(async () => {
    const cleanupErrors: Error[] = [];
    await daemon?.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    daemon = null;
    await retiredDaemon?.proc.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    retiredDaemon = null;
    await closeFakeOpenCodeServer().catch(() => {});
    fakeOpenCodeBaseUrl = '';
    openCodeMessages.length = 0;
    openCodeSessions.length = 0;
    openCodeStatuses = {};
    openCodeObserverConnectionCount = 0;
    openCodeMessageReadCount = 0;
    holdNextOpenCodeMessageRead = null;
    await appServer?.stop().catch(() => {});
    appServer = null;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'OpenCode restart teardown failed');
  });

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await retiredDaemon?.proc.stop().catch(() => {});
    await appServer?.stop().catch(() => {});
    await closeFakeOpenCodeServer().catch(() => {});
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

    const seeded = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: appServer.baseUrl,
      auth,
      mode: 'dataKey',
    });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      startupTimeoutMs: daemonStartupTimeoutMs,
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

    const machineRpc = createDataKeyRpcClient(ui, auth.accountMachineKey);

    let candidatesResult: any = null;
    await waitFor(
      async () => {
        const res = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST}`, {
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
          activity: 'active_recently',
        }),
      ]),
    }));

    const firstLink = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`, {
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

    const secondLink = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`, {
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

    const page = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE}`, {
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

    const tailStart = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER}`, {
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
        const res = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER}`, {
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

  it('drops an in-flight pre-restart observation read and restores one current OpenCode demand before applying a bounded refresh', async () => {
    const testDir = run.testDir('direct-sessions-opencode-observation-restart-refresh');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const remoteSessionId = 'sess-opencode-observation-restart';
    const directory = '/tmp/opencode-observation-restart-project';
    await mkdir(daemonHomeDir, { recursive: true });

    openCodeSessions.push({
      id: remoteSessionId,
      title: 'OpenCode observation restart fixture',
      directory,
      createdAt: '2026-07-25T10:00:00.000Z',
      updatedAt: '2026-07-25T10:00:00.000Z',
    });
    openCodeMessages.push({
      id: 'oc-observe-seed',
      role: 'assistant',
      content: 'OpenCode observation seed',
      createdAt: '2026-07-25T10:00:00.000Z',
    });
    openCodeStatuses = { [remoteSessionId]: { type: 'idle' } };

    fakeOpenCodeServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/global/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ healthy: true, version: 'fake-opencode-observation' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/global/event') {
        res.writeHead(200, {
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'content-type': 'text/event-stream',
        });
        openCodeSseClients.add(res);
        openCodeObserverConnectionCount += 1;
        res.write('data: {"payload":{"type":"server.connected","properties":{}}}\n\n');
        req.once('close', () => openCodeSseClients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(openCodeSessions));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/session/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(openCodeStatuses));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/session/${remoteSessionId}/message`) {
        openCodeMessageReadCount += 1;
        const hold = holdNextOpenCodeMessageRead;
        holdNextOpenCodeMessageRead = null;
        if (hold) await hold;
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(openCodeMessages));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveListen) => {
      fakeOpenCodeServer!.listen(0, '127.0.0.1', resolveListen);
    });
    const fakeAddress = fakeOpenCodeServer.address();
    if (!fakeAddress || typeof fakeAddress === 'string') throw new Error('Missing fake OpenCode address');
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
    const seeded = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: appServer.baseUrl,
      auth,
      mode: 'dataKey',
    });
    const daemonEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: appServer.baseUrl,
      HAPPIER_OPENCODE_SERVER_URL: fakeOpenCodeBaseUrl,
      HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      startupTimeoutMs: daemonStartupTimeoutMs,
      env: daemonEnv,
    });
    const originalDaemonPid = daemon.state.pid;
    const ui = createUserScopedSocketCollector(appServer.baseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000, context: 'OpenCode observation socket connected' });
      const machineRpc = createDataKeyRpcClient(ui, auth.accountMachineKey);
      const route = (method: string) => `${seeded.machineId}:${method}`;
      const source = { kind: 'opencodeServer', baseUrl: null, directory: null } as const;
      const link = unwrapDataKeyRpcResult(await machineRpc.call(route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE), {
        machineId: seeded.machineId,
        providerId: 'opencode',
        remoteSessionId,
        titleHint: 'OpenCode observation restart fixture',
        directoryHint: directory,
        source,
      }), 'OpenCode observation restart link') as { ok: boolean; sessionId: string };
      expect(link).toEqual(expect.objectContaining({ ok: true }));

      const attach = unwrapDataKeyRpcResult(await machineRpc.call(route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH), {
        machineId: seeded.machineId,
        sessionId: link.sessionId,
        providerId: 'opencode',
        remoteSessionId,
        source,
        ttlMs: 60_000,
      }), 'OpenCode observation restart attach') as { ok: boolean; leaseId: string };
      expect(attach).toEqual(expect.objectContaining({ ok: true }));
      await waitFor(() => openCodeSseClients.size === 1, { timeoutMs: 20_000, context: 'one pooled OpenCode observer acquired' });

      const enableBackground = unwrapDataKeyRpcResult(await machineRpc.call(route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET), {
        machineId: seeded.machineId,
        sessionId: link.sessionId,
        providerId: 'opencode',
        remoteSessionId,
        source,
        enabled: true,
      }), 'OpenCode observation restart background demand') as { ok: boolean; enabled: boolean };
      expect(enableBackground).toEqual(expect.objectContaining({ ok: true, enabled: true }));

      const readCountAfterBaseline = openCodeMessageReadCount;
      let releaseOldRead: (() => void) | undefined;
      holdNextOpenCodeMessageRead = new Promise<void>((resolveHold) => { releaseOldRead = resolveHold; });
      openCodeMessages.push({
        id: 'oc-observe-stale',
        role: 'assistant',
        content: 'must not apply after restart',
        createdAt: '2026-07-25T10:00:01.000Z',
      });
      emitOpenCodeEvent({
        directory,
        payload: { type: 'message.part.updated', properties: { sessionID: remoteSessionId } },
      });
      await waitFor(() => openCodeMessageReadCount === readCountAfterBaseline + 1, {
        timeoutMs: 20_000,
        context: 'pre-restart authoritative OpenCode read entered flight',
      });

      const replacement = await replaceTestDaemonWithoutStoppingSessions({
        testDir,
        happyHomeDir: daemonHomeDir,
        env: daemonEnv,
        originalDaemon: daemon,
      });
      retiredDaemon = daemon;
      daemon = replacement;
      expect(replacement.state.pid).not.toBe(originalDaemonPid);
      releaseOldRead?.();

      await waitFor(() => openCodeObserverConnectionCount === 2 && openCodeSseClients.size === 1, {
        timeoutMs: 30_000,
        context: 'restart restores exactly one current pooled OpenCode observer',
      });
      let relinkResult: { ok?: unknown; created?: unknown; sessionId?: unknown } | null = null;
      await waitFor(async () => {
        const relink = await machineRpc.call(route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE), {
          machineId: seeded.machineId,
          providerId: 'opencode',
          remoteSessionId,
          titleHint: 'OpenCode observation restart fixture',
          directoryHint: directory,
          source,
        });
        if (!relink.ok) return false;
        relinkResult = unwrapDataKeyRpcResult(relink, 'OpenCode observation restart relink') as typeof relinkResult;
        return relinkResult?.ok === true;
      }, { timeoutMs: 30_000, context: 'restarted daemon relinks the current OpenCode session' });
      expect(relinkResult).toEqual(expect.objectContaining({
        ok: true,
        created: false,
        sessionId: link.sessionId,
      }));
      const metadataBeforeCurrentEvent = await fetchSessionMetadataV2({
        baseUrl: appServer.baseUrl,
        token: auth.token,
        sessionId: link.sessionId,
        machineKeys: [auth.accountMachineKey],
      });
      const metadataBeforeCurrentEventJson = JSON.stringify(metadataBeforeCurrentEvent);
      expect(metadataBeforeCurrentEventJson).not.toContain('must not apply after restart');
      expect(metadataBeforeCurrentEventJson).not.toContain('1753437601000');

      openCodeMessages.push({
        id: 'oc-observe-current',
        role: 'assistant',
        content: 'current bounded authoritative refresh',
        createdAt: '2026-07-25T10:00:02.000Z',
      });
      const readsBeforeCurrentEvent = openCodeMessageReadCount;
      emitOpenCodeEvent({ directory, payload: { type: 'message.part.updated', properties: { sessionID: remoteSessionId } } });
      emitOpenCodeEvent({ directory, payload: { type: 'message.part.updated', properties: { sessionID: remoteSessionId } } });
      await waitFor(() => openCodeMessageReadCount === readsBeforeCurrentEvent + 1, {
        timeoutMs: 30_000,
        context: 'coalesced current OpenCode event causes one bounded readAfter',
      });
      await waitFor(async () => {
        const metadata = await fetchSessionMetadataV2({
          baseUrl: appServer!.baseUrl,
          token: auth.token,
          sessionId: link.sessionId,
          machineKeys: [auth.accountMachineKey],
        });
        return JSON.stringify(metadata).includes('1753437602000');
      }, { timeoutMs: 30_000, context: 'current bounded read advances only current observation progress' });
    } finally {
      ui.close();
    }
  }, 300_000);
});
