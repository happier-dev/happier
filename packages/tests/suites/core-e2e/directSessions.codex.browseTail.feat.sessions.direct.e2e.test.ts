import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
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

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return jsonlLine({ type: 'response_item', timestamp: params.timestamp, payload: params.payload });
}

describe('core e2e: direct Codex sessions browse/link/tail', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('lists provider-backed Codex sessions, links one idempotently, and tails appended rollout lines', async () => {
    const testDir = run.testDir('direct-sessions-codex-browse-tail');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const codexHomeDir = resolve(join(testDir, '.codex'));
    const rolloutFile = resolve(
      join(codexHomeDir, 'sessions', '2026', '03', '06', 'rollout-2026-03-06T00-00-00-11111111-1111-1111-1111-111111111111.jsonl'),
    );
    const remoteSessionId = '11111111-1111-1111-1111-111111111111';

    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(resolve(join(codexHomeDir, 'sessions', '2026', '03', '06')), { recursive: true });
    await writeFile(
      rolloutFile,
      [
        jsonlLine({
          type: 'session_meta',
          payload: {
            id: remoteSessionId,
            timestamp: '2026-03-06T00:00:00.000Z',
            cwd: '/tmp/direct-codex-core-project',
          },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:01.000Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'first direct codex message' }] },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:02.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'latest direct codex reply' }] },
        }),
      ].join(''),
      'utf8',
    );

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const machineKey = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliDataKeyAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
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
        HAPPIER_SERVER_URL: server.baseUrl,
        CODEX_HOME: codexHomeDir,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000, context: 'socket connected for codex direct sessions e2e' });

    const machineRpc = createDataKeyRpcClient(ui, machineKey);

    let candidatesResult: any = null;
    await waitFor(
      async () => {
        const res = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST}`, {
          machineId: seeded.machineId,
          providerId: 'codex',
          source: { kind: 'codexHome', home: 'user' },
          limit: 20,
        });
        if (!res.ok) return false;
        candidatesResult = res.result;
        if ((candidatesResult as { ok?: unknown })?.ok === false) {
          throw new Error(`direct codex candidates rpc returned ${JSON.stringify(candidatesResult)}`);
        }
        return Array.isArray((candidatesResult as any)?.candidates)
          && (candidatesResult as any).candidates.some((candidate: any) => candidate?.remoteSessionId === remoteSessionId);
      },
      { timeoutMs: 30_000, context: 'direct Codex candidates available' },
    );

    expect(candidatesResult).toEqual(expect.objectContaining({
      ok: true,
      candidates: expect.arrayContaining([
        expect.objectContaining({
          remoteSessionId,
          details: expect.objectContaining({
            cwd: '/tmp/direct-codex-core-project',
          }),
        }),
      ]),
    }));

    const status = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET}`, {
      machineId: seeded.machineId,
      sessionId: 'sess_placeholder',
      providerId: 'codex',
      remoteSessionId,
      source: { kind: 'codexHome', home: 'user' },
    });
    const statusResult = unwrapDataKeyRpcResult(status, 'direct Codex session status');
    expect(statusResult).toEqual(expect.objectContaining({
      ok: true,
      machineOnline: true,
      runnerActive: false,
      canTakeOverDirect: true,
      canTakeOverPersist: false,
    }));

    const firstLink = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
      machineId: seeded.machineId,
      providerId: 'codex',
      remoteSessionId,
      source: { kind: 'codexHome', home: 'user' },
    });
    const firstLinkResult = unwrapDataKeyRpcResult(firstLink, 'direct Codex first link');
    expect(firstLinkResult).toEqual(expect.objectContaining({
      ok: true,
      created: true,
    }));

    const secondLink = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
      machineId: seeded.machineId,
      providerId: 'codex',
      remoteSessionId,
      source: { kind: 'codexHome', home: 'user' },
    });
    const secondLinkResult = unwrapDataKeyRpcResult(secondLink, 'direct Codex second link');
    expect((secondLinkResult as any)?.sessionId).toBe((firstLinkResult as any)?.sessionId);
    expect(secondLinkResult).toEqual(expect.objectContaining({
      ok: true,
      created: false,
    }));

    const page = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE}`, {
      machineId: seeded.machineId,
      providerId: 'codex',
      remoteSessionId,
      source: { kind: 'codexHome', home: 'user' },
      direction: 'older',
    });
    const pageResult = unwrapDataKeyRpcResult(page, 'direct Codex transcript page');
    expect(pageResult).toEqual(expect.objectContaining({
      ok: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          raw: expect.objectContaining({
            role: 'user',
            content: expect.objectContaining({
              text: 'first direct codex message',
            }),
          }),
        }),
      ]),
    }));
    expect(((pageResult as any).items as any[]).some((item) => item?.raw?.content?.data?.message === 'latest direct codex reply')).toBe(true);

    const tailStart = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER}`, {
      machineId: seeded.machineId,
      providerId: 'codex',
      remoteSessionId,
      source: { kind: 'codexHome', home: 'user' },
      cursor: 'tail',
    });
    const tailStartResult = unwrapDataKeyRpcResult(tailStart, 'direct Codex transcript tail start');
    expect(tailStartResult).toEqual(expect.objectContaining({
      ok: true,
      items: [],
    }));

    await appendFile(
      rolloutFile,
      responseItemLine({
        timestamp: '2026-03-06T00:00:03.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'appended direct codex message' }] },
      }),
      'utf8',
    );

    let tailResult: any = null;
    await waitFor(
      async () => {
        const res = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER}`, {
          machineId: seeded.machineId,
          providerId: 'codex',
          remoteSessionId,
          source: { kind: 'codexHome', home: 'user' },
          cursor: (tailStartResult as any)?.nextCursor ?? 'tail',
        });
        if (!res.ok) return false;
        tailResult = unwrapDataKeyRpcResult(res, 'direct Codex transcript tail read_after');
        return Array.isArray((tailResult as any)?.items)
          && (tailResult as any).items.some((item: any) => item?.raw?.content?.text === 'appended direct codex message');
      },
      { timeoutMs: 20_000, context: 'direct Codex tail catches appended line' },
    );

    expect(tailResult).toEqual(expect.objectContaining({
      ok: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          raw: expect.objectContaining({
            role: 'user',
            content: expect.objectContaining({
              text: 'appended direct codex message',
            }),
          }),
        }),
      ]),
    }));

    ui.close();
  }, 120_000);
});
