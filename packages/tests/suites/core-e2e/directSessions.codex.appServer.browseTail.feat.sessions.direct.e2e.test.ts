import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
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

function nativeMessage(id: string, text: string, role: 'user' | 'agent') {
  return {
    turnId: `turn-${id}`,
    startedAtMs: 1_000,
    completedAtMs: 2_000,
    item: role === 'user' ? { id, type: 'userMessage', content: [{ type: 'text', text }] } : { id, type: 'agentMessage', text },
  };
}

async function writeFakeCodexAppServerThreadListScript(params: Readonly<{
  dir: string;
  remoteSessionId: string;
  title: string;
  cwd: string;
  updatedAtSeconds: number;
  nativeItemsPath: string;
}>): Promise<string> {
  const scriptPath = resolve(join(params.dir, 'fake-codex-app-server.mjs'));
  await writeFile(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'import readline from "node:readline";',
      'import { readFile } from "node:fs/promises";',
      'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
      'for await (const line of rl) {',
      '  if (!line.trim()) continue;',
      '  const msg = JSON.parse(line);',
      '  if (msg.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
      '    continue;',
      '  }',
      '  if (msg.method === "initialized") continue;',
      '  if (msg.method === "thread/list") {',
      `    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ id: ${JSON.stringify(params.remoteSessionId)}, name: ${JSON.stringify(params.title)}, preview: ${JSON.stringify(params.title)}, updatedAt: ${JSON.stringify(params.updatedAtSeconds)}, cwd: ${JSON.stringify(params.cwd)} }], nextCursor: null } }) + "\\n");`,
      '    continue;',
      '  }',
      // Codex thread/items/list: newest-first pages; cursors are item indexes (reverse cursors include the anchor).
      '  if (msg.method === "thread/items/list") {',
      `    const all = JSON.parse(await readFile(${JSON.stringify(params.nativeItemsPath)}, "utf8"));`,
      '    const desc = msg.params.sortDirection === "desc";',
      '    const anchor = msg.params.cursor ? JSON.parse(msg.params.cursor) : null;',
      '    const candidates = all.map((entry, index) => ({ entry, index })).filter(({ index }) => !anchor || (desc ? (anchor.inclusive ? index <= anchor.index : index < anchor.index) : (anchor.inclusive ? index >= anchor.index : index > anchor.index)));',
      '    if (desc) candidates.reverse();',
      '    const page = candidates.slice(0, msg.params.limit ?? 100);',
      '    const cursor = (index, inclusive) => JSON.stringify({ index, inclusive });',
      '    const result = { data: page.map(({ entry }) => entry), nextCursor: candidates.length > page.length ? cursor(page.at(-1).index, false) : null, backwardsCursor: page.length ? cursor(page[0].index, true) : null };',
      '    process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");',
      '    continue;',
      '  }',
      '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
      '}',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 },
  );
  return scriptPath;
}

describe('core e2e: direct Codex app-server sessions browse/link/tail', () => {
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

  it('browses app-server metadata, then pages and follows native Codex history for a linked direct session', async () => {
    const testDir = run.testDir('direct-sessions-codex-app-server-browse-tail');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const codexHomeDir = resolve(join(testDir, '.codex'));
    const remoteSessionId = '33333333-3333-3333-3333-333333333333';
    const appServerTitle = 'Codex app-server fallback title';
    const appServerCwd = '/tmp/direct-codex-app-server-project';
    const nativeItemsPath = resolve(join(testDir, 'codex-native-items.json'));
    const initialNativeItems = [
      nativeMessage('u1', 'native question', 'user'),
      nativeMessage('a1', 'native answer', 'agent'),
    ];
    await mkdir(testDir, { recursive: true });
    await writeFile(nativeItemsPath, JSON.stringify(initialNativeItems), 'utf8');
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: testDir,
      remoteSessionId,
      title: appServerTitle,
      cwd: appServerCwd,
      updatedAtSeconds: 1_741_590_000,
      nativeItemsPath,
    });

    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });

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
        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000, context: 'socket connected for app-server direct Codex sessions e2e' });

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
            throw new Error(`direct Codex app-server candidates rpc returned ${JSON.stringify(candidatesResult)}`);
          }
          return Array.isArray((candidatesResult as any)?.candidates)
            && (candidatesResult as any).candidates.some((candidate: any) => candidate?.remoteSessionId === remoteSessionId);
        },
        { timeoutMs: 30_000, context: 'direct Codex app-server candidates available' },
      );

      expect(candidatesResult).toEqual(expect.objectContaining({
        ok: true,
        candidates: expect.arrayContaining([
          expect.objectContaining({
            remoteSessionId,
            title: appServerTitle,
            details: expect.objectContaining({
              cwd: appServerCwd,
              codexBackendMode: 'appServer',
            }),
          }),
        ]),
      }));

      const firstLink = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
        machineId: seeded.machineId,
        providerId: 'codex',
        remoteSessionId,
        source: { kind: 'codexHome', home: 'user' },
      });
      const firstLinkResult = unwrapDataKeyRpcResult(firstLink, 'direct Codex app-server first link');
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
      const secondLinkResult = unwrapDataKeyRpcResult(secondLink, 'direct Codex app-server second link');
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
      const pageResult = unwrapDataKeyRpcResult(page, 'direct Codex app-server transcript page');
      // The list preview is metadata, never transcript: history comes from thread/items/list.
      expect(pageResult).toEqual(expect.objectContaining({ ok: true }));
      const pageItems = (pageResult as any).items as Array<{ raw?: { role?: string } }>;
      expect(pageItems.map(item => item.raw?.role)).toEqual(['user', 'agent']);
      expect(JSON.stringify(pageItems)).toContain('native answer');
      expect(JSON.stringify(pageItems)).not.toContain(appServerTitle);

      const tailStart = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER}`, {
        machineId: seeded.machineId,
        providerId: 'codex',
        remoteSessionId,
        source: { kind: 'codexHome', home: 'user' },
        cursor: 'tail',
      });
      const tailStartResult = unwrapDataKeyRpcResult(tailStart, 'direct Codex app-server transcript tail start');
      expect(tailStartResult).toEqual(expect.objectContaining({
        ok: true,
        items: [],
      }));
      expect((tailStartResult as any)?.nextCursor).toEqual(expect.any(String));

      await writeFile(
        nativeItemsPath,
        JSON.stringify([...initialNativeItems, nativeMessage('u2', 'native follow-up', 'user')]),
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
            cursor: (tailStartResult as any)?.nextCursor,
          });
          if (!res.ok) return false;
          tailResult = unwrapDataKeyRpcResult(res, 'direct Codex app-server native tail read_after');
          return Array.isArray((tailResult as any)?.items) && (tailResult as any).items.length > 0;
        },
        { timeoutMs: 20_000, context: 'direct Codex app-server tail follows native appends' },
      );

      expect(tailResult).toEqual(expect.objectContaining({ ok: true }));
      expect((tailResult as any).items.map((item: any) => item?.raw?.role)).toEqual(['user']);
      expect(JSON.stringify((tailResult as any).items)).toContain('native follow-up');
    } finally {
      ui.close();
    }
  }, 360_000);
});
