import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: message meta permission overrides session metadata for that turn', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('denies a write-like ACP permission request when the user message is read-only even if session metadata is yolo', async () => {
    const testDir = run.testDir('permissions-message-meta-overrides-metadata');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'permissions-message-meta-overrides-metadata',
        createdAt: Date.now(),
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 1000,
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-permissions-message-meta-overrides-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const fakeAgentPath = resolve(join(testDir, 'fake-codex-acp-agent.mjs'));
    const permissionLogPath = resolve(join(testDir, 'permission-log.jsonl'));

    await writeFile(
      fakeAgentPath,
      `#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const sdkEntry = process.env.HAPPIER_E2E_ACP_SDK_ENTRY;
if (!sdkEntry) throw new Error("Missing HAPPIER_E2E_ACP_SDK_ENTRY");
const acp = await import(pathToFileURL(sdkEntry).href);

class FakeAgent {
  connection;
  constructor(connection) { this.connection = connection; }
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async newSession() { return { sessionId: randomUUID() }; }
  async authenticate() { return {}; }
  async prompt(params) {
    const delayMs = Number(process.env.HAPPIER_E2E_PERMISSION_DELAY_MS || "100");
    await new Promise((r) => setTimeout(r, Number.isFinite(delayMs) ? delayMs : 100));

    const resp = await this.connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "tool_write_1",
        title: "Write-like action",
        kind: "edit",
        status: "pending",
        locations: [{ path: "README.md" }],
        rawInput: { filePath: "README.md", oldString: "old", newString: "new" },
      },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Deny", optionId: "deny" },
      ],
    });

    const logPath = process.env.HAPPIER_E2E_PERMISSION_LOG;
    if (logPath) appendFileSync(logPath, JSON.stringify({ outcome: resp.outcome }) + "\\n", "utf8");

    return { stopReason: "end_turn" };
  }
  async cancel() {}
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
`,
      'utf8',
    );
    await chmod(fakeAgentPath, 0o755);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'permissions-message-meta-overrides-metadata',
      sessionIds: [sessionId],
      env: {},
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_E2E_PROVIDERS: '1',
      HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
      HAPPIER_CODEX_ACP_BIN: fakeAgentPath,
      HAPPIER_CODEX_ACP_ALLOW_NPX: '0',
      HAPPIER_E2E_ACP_SDK_ENTRY: resolve(repoRootDir(), 'apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'),
      HAPPIER_E2E_PERMISSION_LOG: permissionLogPath,
      HAPPIER_E2E_PERMISSION_DELAY_MS: '250',
    };

    const cliDistEntrypoint = await ensureCliDistBuilt({ testDir, env: cliEnv });

    const proc: SpawnedProcess = spawnLoggedProcess({
      command: process.execPath,
      args: [
        cliDistEntrypoint,
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

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

      const baseline = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      const baselineAgentStateVersion = baseline.agentStateVersion;

      await waitFor(async () => {
        const snap: any = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        return snap.active === true || (typeof snap.agentStateVersion === 'number' && snap.agentStateVersion > baselineAgentStateVersion);
      }, { timeoutMs: 45_000 });

      const localId1 = `pending-${randomUUID()}`;
      const pendingMsg1 = {
        role: 'user',
        content: { type: 'text', text: 'TRIGGER_PERMISSION_REQUEST_1' },
        localId: localId1,
        meta: { source: 'ui', sentFrom: 'e2e', permissionMode: 'read-only' },
      };
      const pendingCiphertext1 = encryptLegacyBase64(pendingMsg1, secret);
      const enqueue1 = await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId: localId1,
        ciphertext: pendingCiphertext1,
        timeoutMs: 20_000,
      });
      expect(enqueue1.status).toBe(200);

      await waitFor(async () => {
        const raw = await readFile(permissionLogPath, 'utf8').catch(() => '');
        const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0) return false;
        const last = JSON.parse(lines[lines.length - 1] ?? '{}');
        const outcome = last?.outcome;
        return outcome && outcome.outcome === 'selected' && outcome.optionId === 'deny';
      }, { timeoutMs: 90_000 });

      const raw = await readFile(permissionLogPath, 'utf8');
      const last = JSON.parse(raw.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '{}');
      expect(last?.outcome?.optionId).toBe('deny');
    } finally {
      ui.close();
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});
