import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { ensureCliSharedDepsBuilt } from '../../src/testkit/process/cliDist';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { yarnCommand } from '../../src/testkit/process/commands';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { hasToolCall, parseToolTraceJsonl } from '../../src/testkit/toolTraceJsonl';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { fetchSessionsV2 } from '../../src/testkit/sessions';
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
      'import { mkdirSync, appendFileSync } from "node:fs";',
      'import path from "node:path";',
      `const invocationLogPath = ${JSON.stringify(params.invocationLogPath)};`,
      'await appendFile(invocationLogPath, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");',
      'const sessionsRoot = process.env.HAPPIER_CODEX_SESSIONS_DIR?.trim() ?? "";',
      'const sessionId = process.env.HAPPIER_E2E_CODEX_SESSION_ID?.trim() ?? "";',
      'if (!sessionsRoot || !sessionId) {',
      '  process.exit(0);',
      '}',
      'mkdirSync(sessionsRoot, { recursive: true });',
      'const rolloutPath = path.join(sessionsRoot, "rollout-test.jsonl");',
      'function write(line) { appendFileSync(rolloutPath, line + "\\n", "utf8"); }',
      'write(JSON.stringify({ type: "session_meta", payload: { id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() } }));',
      'write(JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: JSON.stringify({ command: "echo CODEX_DIRECT_TAKEOVER_LOCAL_OK" }) } }));',
      'write(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_exec", output: JSON.stringify({ stdout: "CODEX_DIRECT_TAKEOVER_LOCAL_OK\\\\n", exit_code: 0 }) } }));',
      'process.on("SIGTERM", () => process.exit(0));',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    { encoding: 'utf8' },
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function resolveSessionAttachSecret(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  machineKey: Uint8Array;
}>): Promise<Readonly<{
  encryptionVariant: 'legacy' | 'dataKey';
  secret: Uint8Array;
}>> {
  const sessions = await fetchSessionsV2(params.baseUrl, params.token, { limit: 100 });
  const row = sessions.sessions.find((session) => session.id === params.sessionId) ?? null;
  if (!row) {
    throw new Error(`Missing v2 session row for ${params.sessionId}`);
  }

  if (typeof row.dataEncryptionKey === 'string' && row.dataEncryptionKey.trim().length > 0) {
    const opened = openEncryptedDataKeyEnvelopeV1({
      envelope: new Uint8Array(Buffer.from(row.dataEncryptionKey, 'base64')),
      recipientSecretKeyOrSeed: params.machineKey,
    });
    if (!opened || opened.length !== 32) {
      throw new Error(`Failed to open dataEncryptionKey for ${params.sessionId}`);
    }
    return { encryptionVariant: 'dataKey', secret: opened };
  }

  return { encryptionVariant: 'legacy', secret: params.machineKey };
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

  it('persists a linked direct Codex app-server session and then resumes the same vendor session through local terminalRuntime mirroring', async () => {
    const testDir = run.testDir('direct-sessions-codex-app-server-takeover-persist-continue');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const codexHomeDir = resolve(join(testDir, '.codex'));
    const codexSessionsDir = resolve(join(codexHomeDir, 'sessions'));
    const appServerRequestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
    const localCodexInvocationLogPath = resolve(join(testDir, 'fake-local-codex.invocations.jsonl'));
    const toolTraceFile = resolve(join(testDir, 'tooltrace.jsonl'));
    const localRolloutPath = resolve(join(codexSessionsDir, 'rollout-test.jsonl'));
    const remoteSessionId = '44444444-4444-4444-4444-444444444444';
    const linkedDirectory = '/tmp/direct-codex-app-server-takeover-project';
    let localProc: SpawnedProcess | null = null;

    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await mkdir(codexSessionsDir, { recursive: true });

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
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
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
      link = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`, {
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

    const takeoverPersist = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER}`, {
      machineId: seeded.machineId,
      linkedSessionId: sessionId,
      targetRuntimeMode: 'terminal',
      storageMode: 'persisted',
    });
    const takeoverPersistResult = unwrapDataKeyRpcResult(takeoverPersist, 'direct Codex app-server takeover persist');
    expect(takeoverPersistResult).toEqual(expect.objectContaining({ ok: true, converted: true }));

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

    writeTestManifestForServer({
      testDir,
      server,
      startedAt: new Date().toISOString(),
      runId: run.runId,
      testName: 'direct-sessions-codex-app-server-takeover-persist-continue',
      sessionIds: [sessionId],
      env: {
        HAPPIER_STACK_TOOL_TRACE: '1',
      },
    });

    await daemon?.stop().catch(() => {});
    daemon = null;

    const attachSecret = await resolveSessionAttachSecret({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      machineKey,
    });
    const attachFile = await writeCliSessionAttachFile({
      cliHome: daemonHomeDir,
      sessionId,
      secret: attachSecret.secret,
      encryptionVariant: attachSecret.encryptionVariant,
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
      HAPPIER_STACK_TOOL_TRACE: '1',
      HAPPIER_STACK_TOOL_TRACE_FILE: toolTraceFile,
      CODEX_HOME: codexHomeDir,
      HAPPIER_CODEX_TUI_BIN: fakeLocalCodex,
      HAPPIER_CODEX_SESSIONS_DIR: codexSessionsDir,
      HAPPIER_E2E_CODEX_SESSION_ID: remoteSessionId,
      HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
    };

    await ensureCliSharedDepsBuilt({ testDir, env: cliEnv });

    localProc = spawnLoggedProcess({
      command: yarnCommand(),
      args: [
        '-s',
        'workspace',
        '@happier-dev/cli',
        'dev',
        'codex',
        '--existing-session',
        sessionId,
        '--started-by',
        'terminal',
        '--happy-starting-mode',
        'local',
      ],
      cwd: repoRootDir(),
      env: cliEnv,
      stdoutPath: resolve(join(testDir, 'terminal-runtime.stdout.log')),
      stderrPath: resolve(join(testDir, 'terminal-runtime.stderr.log')),
    });

    await waitFor(async () => existsSync(localRolloutPath), {
      timeoutMs: 30_000,
      context: 'local terminalRuntime rollout file created for persisted direct session',
    });

    await waitFor(async () => {
      if (!existsSync(localCodexInvocationLogPath)) return false;
      const raw = await readFile(localCodexInvocationLogPath, 'utf8').catch(() => '');
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .some((line) => {
          try {
            const parsed = JSON.parse(line) as { argv?: unknown };
            const argv = Array.isArray(parsed.argv) ? parsed.argv.map(String) : [];
            const resumeIndex = argv.indexOf('resume');
            return resumeIndex >= 0 && argv[resumeIndex + 1] === remoteSessionId;
          } catch {
            return false;
          }
        });
    }, {
      timeoutMs: 30_000,
      context: 'local terminalRuntime resumes the persisted vendor session id',
    });

    await waitFor(async () => {
      if (!existsSync(toolTraceFile)) return false;
      const raw = await readFile(toolTraceFile, 'utf8').catch(() => '');
      const events = parseToolTraceJsonl(raw);
      return hasToolCall(events, {
        protocol: 'codex',
        name: 'Bash',
        commandSubstring: 'echo CODEX_DIRECT_TAKEOVER_LOCAL_OK',
      });
    }, {
      timeoutMs: 30_000,
      context: 'local terminalRuntime mirroring publishes tool trace for persisted direct session',
    });

    ui.close();
    await localProc?.stop().catch(() => {});
    localProc = null;
    await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
  }, 240_000);
});
