import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { repoRootDir } from '../../src/testkit/paths';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { encryptLegacyBase64, decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { yarnCommand } from '../../src/testkit/process/commands';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { fetchJson } from '../../src/testkit/http';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: Codex ACP in-flight steer (mid-turn)', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('steers a second user message into the same in-flight turn (no abort)', async () => {
    const testDir = run.testDir('codex-acp-in-flight-steer-pending-queue');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: serverBaseUrl, token: auth.token, secret });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'codex-acp-in-flight-steer-pending-queue',
        createdAt: Date.now(),
        permissionMode: 'default',
        permissionModeUpdatedAt: 1000,
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: serverBaseUrl,
      token: auth.token,
      tag: `e2e-codex-acp-steer-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });

    const sdkEntry = resolve(repoRootDir(), 'apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js');
    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });

    const fakeAgentPath = resolve(join(fakeBinDir, 'codex-acp'));
    const promptLogPath = resolve(join(testDir, 'prompt-log.jsonl'));
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

const promptLogPath = process.env.HAPPIER_E2E_PROMPT_LOG;
let primary = "";
let steer = "";
let promptCount = 0;

function log(obj) {
  if (!promptLogPath) return;
  try { appendFileSync(promptLogPath, JSON.stringify({ at: Date.now(), ...obj }) + "\\n", "utf8"); } catch {}
}

class FakeAgent {
  connection;
  constructor(connection) { this.connection = connection; }
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }; }
  async authenticate() { return {}; }
  async newSession() { return { sessionId: randomUUID() }; }
  async prompt(params) {
    const blocks = params?.prompt;
    const text = Array.isArray(blocks) && blocks[0] && typeof blocks[0].text === "string" ? blocks[0].text : "";
    if (promptCount === 0) {
      primary = text;
      // Mark the primary prompt as in-flight immediately so concurrent prompt requests are treated as steer input.
      // (ACP steer uses the same session/prompt method; the agent must interpret re-entrant prompts as steer.)
      promptCount = 1;
      log({ kind: "primary_prompt_received", text });
      // Keep this prompt request in-flight so a steer prompt can arrive concurrently.
      // Wait for the steer message (best-effort) before emitting output so the transcript proves steering.
      const maxMsRaw = Number(process.env.HAPPIER_E2E_PRIMARY_MAX_MS || "8000");
      const maxMs = Number.isFinite(maxMsRaw) ? maxMsRaw : 8000;
      const startedAt = Date.now();
      while (!steer && Date.now() - startedAt < maxMs) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!steer) log({ kind: "primary_prompt_timeout_waiting_for_steer" });
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "primary=" + primary + "; steer=" + steer } },
      });
      return { stopReason: "end_turn" };
    }
    // Treat subsequent prompts as "steer" messages.
    steer = text;
    log({ kind: "steer_prompt_received", text });
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
      testName: 'codex-acp-in-flight-steer-pending-queue',
      sessionIds: [sessionId],
      env: {},
    });

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: cliHome,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_SESSION_ATTACH_FILE: attachFile,
      HAPPIER_E2E_PROVIDERS: '1',
      HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
      // Prefer PATH stub to avoid relying on npx / installs.
      HAPPIER_CODEX_ACP_BIN: fakeAgentPath,
      HAPPIER_E2E_ACP_SDK_ENTRY: sdkEntry,
      HAPPIER_E2E_PROMPT_LOG: promptLogPath,
      HAPPIER_E2E_PRIMARY_MAX_MS: '8000',
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
    };

    await ensureCliDistBuilt({ testDir, env: cliEnv });

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
      stdoutPath: resolve(join(testDir, 'cli.stdout.log')),
      stderrPath: resolve(join(testDir, 'cli.stderr.log')),
    });

    const baseline = await fetchSessionV2(serverBaseUrl, auth.token, sessionId);
    const baselineAgentStateVersion = baseline.agentStateVersion;

    try {
      // Wait until the CLI has attached (it registers a machine on first connect).
      // If we post messages before that, the runner may miss the initial "new-message" update.
      await waitFor(async () => {
        const res = await fetchJson<any>(`${serverBaseUrl}/v1/machines`, {
          headers: { Authorization: `Bearer ${auth.token}` },
          timeoutMs: 15_000,
        });
        return res.status === 200 && Array.isArray(res.data) && res.data.length > 0;
      }, { timeoutMs: 45_000 });

      const localIdPrimary = `msg-${randomUUID()}`;
      const msgPrimary = {
        role: 'user',
        content: { type: 'text', text: 'hello' },
        localId: localIdPrimary,
        meta: { source: 'ui', sentFrom: 'e2e' },
      };
      const ciphertextPrimary = encryptLegacyBase64(msgPrimary, secret);
      {
        const enqueue = await enqueuePendingQueueV2({
          baseUrl: serverBaseUrl,
          token: auth.token,
          sessionId,
          localId: localIdPrimary,
          ciphertext: ciphertextPrimary,
          timeoutMs: 20_000,
        });
        expect(enqueue.status).toBe(200);
      }

      // Wait until the ACP agent has received the primary prompt so the next message is steered mid-turn.
      await waitFor(async () => {
        const raw = await readFile(promptLogPath, 'utf8').catch(() => '');
        return raw.includes('"kind":"primary_prompt_received"');
      }, { timeoutMs: 30_000 });

      const localIdSteer = `msg-${randomUUID()}`;
      const msgSteer = {
        role: 'user',
        content: { type: 'text', text: 'steer-now' },
        localId: localIdSteer,
        meta: { source: 'ui', sentFrom: 'e2e' },
      };
      const ciphertextSteer = encryptLegacyBase64(msgSteer, secret);
      {
        // Steer messages should arrive as committed transcript messages (agent_queue style),
        // not via server-backed pending queue.
        const res = await fetchJson<any>(`${serverBaseUrl}/v2/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ciphertext: ciphertextSteer, localId: localIdSteer }),
          timeoutMs: 20_000,
        });
        expect(res.status).toBe(200);
        expect(res.data?.didWrite).toBe(true);
      }

      // Ensure the second message was routed as an ACP steer prompt (not queued as a new turn).
      await waitFor(async () => {
        const raw = await readFile(promptLogPath, 'utf8').catch(() => '');
        return raw.includes('"kind":"steer_prompt_received"');
      }, { timeoutMs: 30_000 });

      // Wait for the assistant response that reflects the steer prompt being applied mid-turn.
      const startAfterSeq = baseline.seq ?? 0;
      await waitFor(async () => {
        const rows = await fetchMessagesSince({ baseUrl: serverBaseUrl, token: auth.token, sessionId, afterSeq: startAfterSeq });
        for (const row of rows) {
          const decrypted = decryptLegacyBase64(row.content.c, secret) as any;
          if (!decrypted || typeof decrypted !== 'object') continue;
          if (decrypted.role !== 'agent') continue;
          const content = decrypted.content;
          if (!content || typeof content !== 'object') continue;
          if (content.type !== 'acp') continue;
          if (content.provider !== 'codex') continue;
          const data = content.data;
          if (!data || typeof data !== 'object') continue;
          if (data.type !== 'message') continue;
          const msgText = (data as any).message;
          if (typeof msgText !== 'string') continue;
          return msgText.includes('primary=hello') && msgText.includes('steer=steer-now');
        }
        return false;
      }, { timeoutMs: 90_000 });
    } finally {
      await proc.stop().catch(() => {});
    }
  });
});
