import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createTestAuth, type TestAuth } from './auth';
import { seedCliAuthForServer } from './cliAuth';
import { writeCliSessionAttachFile } from './cliAttachFile';
import { decryptLegacyBase64Normalized } from './decryptLegacyBase64Normalized';
import { stopDaemonFromHomeDir } from './daemon/daemon';
import { writeTestManifestForServer } from './manifestForServer';
import { encryptLegacyBase64 } from './messageCrypto';
import { repoRootDir } from './paths';
import { startServerLight, type StartedServer } from './process/serverLight';
import { spawnLoggedProcess, type SpawnedProcess } from './process/spawnProcess';
import { yarnCommand } from './process/commands';
import { createSessionWithCiphertexts, fetchSessionV2, type SessionV2 } from './sessions';
import { waitFor } from './timing';

export type FakeCodexAppServerRequest = Readonly<{
  method?: string;
  params?: Record<string, unknown> | null;
}>;

export async function writeFakeCodexAppServerScript(params: Readonly<{
  dir: string;
  requestLogPath: string;
}>): Promise<string> {
  const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
  const script = [
    '#!/usr/bin/env node',
    'import { appendFile } from "node:fs/promises";',
    'import readline from "node:readline";',
    `const requestLogPath = ${JSON.stringify(params.requestLogPath)};`,
    'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'let turnCounter = 0;',
    'for await (const line of rl) {',
    '  if (!line.trim()) continue;',
    '  const msg = JSON.parse(line);',
    '  await appendFile(requestLogPath, JSON.stringify({ method: msg.method ?? null, params: msg.params ?? null }) + "\\n");',
    '  if (msg.method === "initialize") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "initialized") continue;',
    '  if (msg.method === "thread/start") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "thread/resume") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params?.threadId ?? null, model: "gpt-5.4", serviceTier: null } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "collaborationMode/list") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ name: "Default", mode: "default", reasoning_effort: null }] }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "model/list") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true }] }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "turn/start") {',
    '    turnCounter += 1;',
    '    const threadId = msg.params?.threadId ?? "thread-started";',
    '    const input = Array.isArray(msg.params?.input) ? msg.params.input : [];',
    '    const promptText = String(input[0]?.text ?? `prompt-${turnCounter}`);',
    '    const turnId = `turn-${turnCounter}`;',
    '    const messageId = `msg_${turnCounter}`;',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId } }) + "\\n");',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId } } }) + "\\n");',
    '    }, 5);',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: messageId, delta: `reply:${promptText}:` } }) + "\\n");',
    '    }, 6);',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: messageId, type: "agentMessage", text: `reply:${promptText}:done` } } }) + "\\n");',
    '    }, 7);',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId } } }) + "\\n");',
    '    }, 10);',
    '    continue;',
    '  }',
    '  if (msg.method === "thread/rollback") {',
    '    if (msg.params?.numTurns !== 1 || typeof msg.params?.threadId !== "string" || msg.params.threadId.length === 0) {',
    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "thread/rollback requires { threadId, numTurns: 1 }" } }) + "\\n");',
    '      continue;',
    '    }',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params.threadId } }) + "\\n");',
    '    continue;',
    '  }',
    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
    '}',
  ].join('\n');
  await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
  return scriptPath;
}

export async function readFakeCodexAppServerRequestLog(requestLogPath: string): Promise<FakeCodexAppServerRequest[]> {
  if (!existsSync(requestLogPath)) return [];
  const raw = await readFile(requestLogPath, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as FakeCodexAppServerRequest];
      } catch {
        return [];
      }
    });
}

export type StartedCodexAppServerRemoteHarness = Readonly<{
  server: StartedServer;
  serverBaseUrl: string;
  auth: TestAuth;
  cliHome: string;
  workspaceDir: string;
  secret: Uint8Array;
  sessionId: string;
  requestLogPath: string;
  readySession: SessionV2;
  stop: () => Promise<void>;
}>;

export async function startCodexAppServerRemoteHarness(params: Readonly<{
  testDir: string;
  runId: string;
  testName: string;
  cliEnvOverrides?: NodeJS.ProcessEnv;
  manifestEnv?: Record<string, string>;
  metadataOverrides?: Record<string, unknown>;
}>): Promise<StartedCodexAppServerRemoteHarness> {
  const startedAt = new Date().toISOString();
  const server = await startServerLight({
    testDir: params.testDir,
    dbProvider: 'sqlite',
    extraEnv: {
      HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    },
  });

  const serverBaseUrl = server.baseUrl;
  const auth = await createTestAuth(serverBaseUrl);
  const cliHome = resolve(join(params.testDir, 'cli-home'));
  const workspaceDir = resolve(join(params.testDir, 'workspace'));
  await mkdir(cliHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const secret = Uint8Array.from(randomBytes(32));
  await seedCliAuthForServer({ cliHome, serverUrl: serverBaseUrl, token: auth.token, secret });

  const metadataCiphertextBase64 = encryptLegacyBase64(
    {
      path: workspaceDir,
      host: 'e2e',
      name: params.testName,
      createdAt: Date.now(),
      permissionMode: 'default',
      permissionModeUpdatedAt: 1000,
      codexBackendMode: 'appServer',
      ...params.metadataOverrides,
    },
    secret,
  );

  const { sessionId } = await createSessionWithCiphertexts({
    baseUrl: serverBaseUrl,
    token: auth.token,
    tag: `e2e-${params.testName}-${randomUUID()}`,
    metadataCiphertextBase64,
    agentStateCiphertextBase64: null,
  });

  const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });
  const requestLogPath = resolve(join(params.testDir, 'fake-codex-app-server.requests.jsonl'));
  const fakeAppServer = await writeFakeCodexAppServerScript({ dir: params.testDir, requestLogPath });

  writeTestManifestForServer({
    testDir: params.testDir,
    server,
    startedAt,
    runId: params.runId,
    testName: params.testName,
    sessionIds: [sessionId],
    env: params.manifestEnv ?? {},
  });

  const cliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_HOME_DIR: cliHome,
    HAPPIER_SERVER_URL: serverBaseUrl,
    HAPPIER_WEBAPP_URL: serverBaseUrl,
    HAPPIER_SESSION_ATTACH_FILE: attachFile,
    HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
    ...params.cliEnvOverrides,
  };

  const proc: SpawnedProcess = spawnLoggedProcess({
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
      'remote',
    ],
    cwd: repoRootDir(),
    env: cliEnv,
    stdoutPath: resolve(join(params.testDir, 'cli.stdout.log')),
    stderrPath: resolve(join(params.testDir, 'cli.stderr.log')),
  });

  const stop = async (): Promise<void> => {
    await proc.stop().catch(() => {});
    await stopDaemonFromHomeDir(cliHome).catch(() => {});
    await server.stop().catch(() => {});
  };

  try {
    const baseline = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
    const baselineAgentStateVersion = baseline.agentStateVersion;

    await waitFor(async () => {
      const snap = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
      const metadata = decryptLegacyBase64Normalized(snap.metadata, secret) as Record<string, unknown> | null;
      return Boolean(
        (snap.active === true || (typeof snap.agentStateVersion === 'number' && snap.agentStateVersion > baselineAgentStateVersion))
        && metadata
        && metadata.codexBackendMode === 'appServer'
        && metadata.codexSessionId === sessionId,
      );
    }, { timeoutMs: 45_000, context: `${params.testName} session starts and publishes metadata` });

    return {
      server,
      serverBaseUrl,
      auth,
      cliHome,
      workspaceDir,
      secret,
      sessionId,
      requestLogPath,
      readySession: await fetchSessionV2(serverBaseUrl, auth.token, sessionId),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
