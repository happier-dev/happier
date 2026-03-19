import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { yarnCommand } from '../../src/testkit/process/commands';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { requestSessionSwitchRpc } from '../../src/testkit/sessionSwitchRpc';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { hasToolCall, parseToolTraceJsonl } from '../../src/testkit/toolTraceJsonl';
import {
  readFakeCodexAppServerRequestLog,
  startCodexAppServerRemoteHarness,
  type StartedCodexAppServerRemoteHarness,
} from '../../src/testkit/codexAppServerRemoteHarness';

const run = createRunDirs({ runLabel: 'core' });
type RemoteBackend = 'acp' | 'appServer';

async function createLocalCodexStub(params: Readonly<{
  testDir: string;
}>): Promise<Readonly<{
  fakeCodexPath: string;
  codexSessionId: string;
  rolloutPath: string;
  fakeCodexLog: string;
}>> {
  const fakeBinDir = resolve(join(params.testDir, 'fake-bin'));
  await mkdir(fakeBinDir, { recursive: true });
  const fakeCodexPath = resolve(join(fakeBinDir, 'codex'));
  const codexSessionId = `codex-session-${randomUUID()}`;
  const rolloutPath = resolve(join(params.testDir, 'codex-sessions', 'rollout-test.jsonl'));
  const fakeCodexLog = resolve(join(params.testDir, 'fake-codex.jsonl'));

  await mkdir(resolve(join(params.testDir, 'codex-sessions')), { recursive: true });
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const sessionsRoot = process.env.HAPPIER_CODEX_SESSIONS_DIR;
if (!sessionsRoot) throw new Error('Missing HAPPIER_CODEX_SESSIONS_DIR');
fs.mkdirSync(sessionsRoot, { recursive: true });

const filePath = path.join(sessionsRoot, ${JSON.stringify('rollout-test.jsonl')});
const id = process.env.HAPPIER_E2E_CODEX_SESSION_ID;
if (!id) throw new Error('Missing HAPPIER_E2E_CODEX_SESSION_ID');

const logPath = process.env.HAPPIER_E2E_FAKE_CODEX_LOG;
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n', 'utf8');
}

function write(line) {
  fs.appendFileSync(filePath, line + '\\n', 'utf8');
}

write(JSON.stringify({ type: 'session_meta', payload: { id, timestamp: new Date().toISOString(), cwd: process.cwd() } }));
write(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'call_exec', name: 'exec_command', arguments: JSON.stringify({ command: 'echo CODEX_REMOTE_SWITCH_OK' }) } }));
write(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_exec', output: JSON.stringify({ stdout: 'CODEX_REMOTE_SWITCH_OK\\n', exit_code: 0 }) } }));

process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
    'utf8',
  );
  await chmod(fakeCodexPath, 0o755);

  return {
    fakeCodexPath,
    codexSessionId,
    rolloutPath,
    fakeCodexLog,
  };
}

async function assertLocalTakeover(params: Readonly<{
  authToken: string;
  codexSessionId: string;
  fakeCodexLog: string;
  rolloutPath: string;
  secret: Uint8Array;
  serverBaseUrl: string;
  sessionId: string;
  toolTraceFile: string;
}>): Promise<void> {
  await waitFor(async () => {
    if (!existsSync(params.fakeCodexLog)) return false;
    const raw = await readFile(params.fakeCodexLog, 'utf8').catch(() => '');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const invocations = lines.flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    return invocations.some((inv) => {
      const argv = Array.isArray(inv?.argv) ? inv.argv.map(String) : [];
      const askIdx = argv.indexOf('--ask-for-approval');
      const sandboxIdx = argv.indexOf('--sandbox');
      return (
        askIdx >= 0
        && sandboxIdx >= 0
        && argv[askIdx + 1] === 'never'
        && argv[sandboxIdx + 1] === 'read-only'
      );
    });
  }, { timeoutMs: 30_000 });

  await waitFor(async () => existsSync(params.rolloutPath), { timeoutMs: 20_000 });

  await waitFor(async () => {
    if (!existsSync(params.toolTraceFile)) return false;
    const raw = await readFile(params.toolTraceFile, 'utf8').catch(() => '');
    const events = parseToolTraceJsonl(raw);
    return hasToolCall(events, {
      protocol: 'codex',
      name: 'Bash',
      commandSubstring: 'echo CODEX_REMOTE_SWITCH_OK',
    });
  }, { timeoutMs: 30_000 });

  const snap = await fetchSessionV2(params.serverBaseUrl, params.authToken, params.sessionId);
  const metadata = decryptLegacyBase64Normalized(snap.metadata, params.secret) as any;
  expect(metadata.codexSessionId).toBe(params.codexSessionId);
}

async function runRemoteToLocalMirroringScenario(params: Readonly<{
  remoteBackend: RemoteBackend;
}>): Promise<void> {
  const testName = params.remoteBackend === 'appServer'
    ? 'codex-switch-remote-to-local-app-server'
    : 'codex-switch-remote-to-local';
  const testDir = run.testDir(testName);
  const toolTraceFile = resolve(join(testDir, 'tooltrace.jsonl'));
  const localCodex = await createLocalCodexStub({ testDir });

  let server: StartedServer | null = null;
  let proc: SpawnedProcess | null = null;
  let harness: StartedCodexAppServerRemoteHarness | null = null;
  let ui: ReturnType<typeof createUserScopedSocketCollector> | null = null;
  let cliHomeForCleanup: string | null = null;

  try {
    if (params.remoteBackend === 'acp') {
      const startedAt = new Date().toISOString();

      // This scenario validates codex remote/local control handoff semantics, not DB portability.
      // Keep sqlite here for deterministic metadata propagation across environments.
      server = await startServerLight({ testDir, dbProvider: 'sqlite' });
      const auth = await createTestAuth(server.baseUrl);

      const cliHome = resolve(join(testDir, 'cli-home'));
      const workspaceDir = resolve(join(testDir, 'workspace'));
      await mkdir(cliHome, { recursive: true });
      await mkdir(workspaceDir, { recursive: true });
      cliHomeForCleanup = cliHome;

      const secret = Uint8Array.from(randomBytes(32));
      await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

      const metadataCiphertextBase64 = encryptLegacyBase64(
        {
          path: workspaceDir,
          host: 'e2e',
          name: testName,
          createdAt: Date.now(),
          permissionMode: 'read-only',
          permissionModeUpdatedAt: 1000,
        },
        secret,
      );

      const { sessionId } = await createSessionWithCiphertexts({
        baseUrl: server.baseUrl,
        token: auth.token,
        tag: `e2e-${testName}-${randomUUID()}`,
        metadataCiphertextBase64,
        agentStateCiphertextBase64: null,
      });

      const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

      writeTestManifestForServer({
        testDir,
        server,
        startedAt,
        runId: run.runId,
        testName,
        sessionIds: [sessionId],
        env: {
          HAPPIER_STACK_TOOL_TRACE: '1',
        },
      });

      const cliEnv: NodeJS.ProcessEnv = {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_HOME_DIR: cliHome,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_SESSION_ATTACH_FILE: attachFile,
        HAPPIER_STACK_TOOL_TRACE: '1',
        HAPPIER_STACK_TOOL_TRACE_FILE: toolTraceFile,
        HAPPIER_CODEX_TUI_BIN: localCodex.fakeCodexPath,
        HAPPIER_CODEX_SESSIONS_DIR: resolve(join(testDir, 'codex-sessions')),
        HAPPIER_E2E_CODEX_SESSION_ID: localCodex.codexSessionId,
        HAPPIER_E2E_FAKE_CODEX_LOG: localCodex.fakeCodexLog,
        HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
      };

      proc = spawnLoggedProcess({
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
        stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
        stderrPath: resolve(join(testDir, 'cli.stderr.log')),
      });

      ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
      ui.connect();

      await waitFor(() => ui?.isConnected() === true, { timeoutMs: 20_000 });

      const switched = await requestSessionSwitchRpc({ ui, sessionId, to: 'local', secret, timeoutMs: 20_000 });
      expect(switched).toBe(true);

      await assertLocalTakeover({
        authToken: auth.token,
        codexSessionId: localCodex.codexSessionId,
        fakeCodexLog: localCodex.fakeCodexLog,
        rolloutPath: localCodex.rolloutPath,
        secret,
        serverBaseUrl: server.baseUrl,
        sessionId,
        toolTraceFile,
      });
      return;
    }

    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName,
      metadataOverrides: {
        permissionMode: 'read-only',
        permissionModeUpdatedAt: 1000,
      },
      manifestEnv: {
        HAPPIER_STACK_TOOL_TRACE: '1',
      },
      cliEnvOverrides: {
        HAPPIER_STACK_TOOL_TRACE: '1',
        HAPPIER_STACK_TOOL_TRACE_FILE: toolTraceFile,
        HAPPIER_CODEX_TUI_BIN: localCodex.fakeCodexPath,
        HAPPIER_CODEX_SESSIONS_DIR: resolve(join(testDir, 'codex-sessions')),
        HAPPIER_E2E_CODEX_SESSION_ID: localCodex.codexSessionId,
        HAPPIER_E2E_FAKE_CODEX_LOG: localCodex.fakeCodexLog,
      },
    });
    cliHomeForCleanup = harness.cliHome;

    const requests = await readFakeCodexAppServerRequestLog(harness.requestLogPath);
    expect(requests.some((entry) => entry.method === 'thread/resume')).toBe(true);

    ui = createUserScopedSocketCollector(harness.serverBaseUrl, harness.auth.token);
    ui.connect();

    await waitFor(() => ui?.isConnected() === true, { timeoutMs: 20_000 });

    const switched = await requestSessionSwitchRpc({ ui, sessionId: harness.sessionId, to: 'local', secret: harness.secret, timeoutMs: 20_000 });
    expect(switched).toBe(true);

    await assertLocalTakeover({
      authToken: harness.auth.token,
      codexSessionId: localCodex.codexSessionId,
      fakeCodexLog: localCodex.fakeCodexLog,
      rolloutPath: localCodex.rolloutPath,
      secret: harness.secret,
      serverBaseUrl: harness.serverBaseUrl,
      sessionId: harness.sessionId,
      toolTraceFile,
    });
  } finally {
    ui?.close();
    await proc?.stop();
    await harness?.stop().catch(() => {});
    if (cliHomeForCleanup) {
      await stopDaemonFromHomeDir(cliHomeForCleanup).catch(() => {});
    }
    await server?.stop();
  }
}

describe('core e2e: Codex remote→local switch triggers rollout mirroring', () => {
  it('switches from remote to local and mirrors tool calls without requiring remote backend spawn', async () => {
    await runRemoteToLocalMirroringScenario({ remoteBackend: 'acp' });
  }, 240_000);

  it('switches from app-server remote to local and mirrors tool calls through the local rollout', async () => {
    await runRemoteToLocalMirroringScenario({ remoteBackend: 'appServer' });
  }, 240_000);
});
