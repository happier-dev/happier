import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import {
  readFakeCodexAppServerRequestLog,
  writeFakeCodexAppServerScript,
} from '../../src/testkit/codexAppServerRemoteHarness';

const run = createRunDirs({ runLabel: 'core' });

async function writeFakeLocalCodexScript(params: Readonly<{ testDir: string; invocationLogPath: string }>): Promise<string> {
  const scriptPath = resolve(join(params.testDir, 'fake-local-codex.mjs'));
  await writeFile(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'import { appendFile } from "node:fs/promises";',
      `const invocationLogPath = ${JSON.stringify(params.invocationLogPath)};`,
      'await appendFile(invocationLogPath, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");',
      'process.exit(0);',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 },
  );
  return scriptPath;
}

describe('core e2e: direct Codex app-server sessions takeover+continue', () => {
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

  it('persists a linked direct Codex app-server session and resumes it through the same app-server backend', async () => {
    const testDir = run.testDir('direct-sessions-codex-app-server-takeover-persist-continue');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const codexHomeDir = resolve(join(testDir, '.codex'));
    const appServerRequestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
    const localCodexInvocationLogPath = resolve(join(testDir, 'fake-local-codex.invocations.jsonl'));
    const remoteSessionId = '44444444-4444-4444-4444-444444444444';
    const linkedDirectory = '/tmp/direct-codex-app-server-takeover-project';

    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });

    const fakeAppServer = await writeFakeCodexAppServerScript({
      dir: testDir,
      requestLogPath: appServerRequestLogPath,
    });
    const fakeLocalCodex = await writeFakeLocalCodexScript({
      testDir,
      invocationLogPath: localCodexInvocationLogPath,
    });

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

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
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
        CODEX_HOME: codexHomeDir,
        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
        HAPPIER_CODEX_TUI_BIN: fakeLocalCodex,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000, context: 'socket connected for direct Codex app-server takeover persist e2e' });

    const machineRpc = createDataKeyRpcClient(ui, machineKey);

    let link: Awaited<ReturnType<typeof machineRpc.call>> | null = null;
    await waitFor(async () => {
      link = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
        machineId: seeded.machineId,
        providerId: 'codex',
        remoteSessionId,
        titleHint: 'Direct Codex app-server linked session',
        directoryHint: linkedDirectory,
        codexBackendMode: 'appServer',
        source: { kind: 'codexHome', home: 'user' },
      });
      return link.ok === true;
    }, { timeoutMs: 30_000, context: 'direct Codex app-server link RPC available' });
    if (!link) {
      throw new Error('Expected direct Codex app-server link response');
    }
    const linkResult = unwrapDataKeyRpcResult(link, 'direct Codex app-server persisted link');
    expect(linkResult).toEqual(expect.objectContaining({
      ok: true,
      created: true,
    }));
    const sessionId = (linkResult as { sessionId: string }).sessionId;

    const takeoverPersist = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST}`, {
      machineId: seeded.machineId,
      sessionId,
    });
    const takeoverPersistResult = unwrapDataKeyRpcResult(takeoverPersist, 'direct Codex app-server takeover persist');
    expect(takeoverPersistResult).toEqual({ ok: true, converted: true });

    await waitFor(async () => {
      const requests = await readFakeCodexAppServerRequestLog(appServerRequestLogPath);
      return requests.some((entry) => entry.method === 'thread/resume' && entry.params?.threadId === remoteSessionId);
    }, { timeoutMs: 45_000, context: 'direct Codex app-server persisted takeover resumes linked app-server thread' });

    if (existsSync(localCodexInvocationLogPath)) {
      const localInvocations = (await readFile(localCodexInvocationLogPath, 'utf8'))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      expect(localInvocations).toEqual([]);
    }

    ui.close();
  }, 240_000);
});
