import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { writeCliSessionAttachFile } from '../../src/testkit/cliAttachFile';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { repoRootDir } from '../../src/testkit/paths';
import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';
import { ensureCliDistBuilt } from '../../src/testkit/process/cliDist';
import { spawnLoggedProcess, type SpawnedProcess } from '../../src/testkit/process/spawnProcess';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSessionWithCiphertexts, fetchAllMessages, fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type FakeGeminiEvent =
  | { kind: 'loadSession'; ts: number; sessionId: string; mcpServerNames: string[] }
  | { kind: 'loadReplayUpdate'; ts: number; marker: string }
  | { kind: 'prompt'; ts: number; text: string }
  | { kind: 'promptReturn'; ts: number; marker: string; stopReason: string };

async function readFakeGeminiEvents(path: string): Promise<FakeGeminiEvent[]> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as FakeGeminiEvent];
      } catch {
        return [];
      }
    });
}

function decodedMessagesContain(decodedMessages: unknown[], predicate: (record: Record<string, unknown>) => boolean): boolean {
  const stack = [...decodedMessages];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (predicate(record)) return true;
    stack.push(...Object.values(record));
  }
  return false;
}

async function decryptSessionMessages(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
}): Promise<unknown[]> {
  const rows = await fetchAllMessages(params.baseUrl, params.token, params.sessionId);
  return rows.flatMap((row) => {
    try {
      return [decryptLegacyBase64(row.content.c, params.secret)];
    } catch {
      return [];
    }
  });
}

function messageTreeContainsText(messages: unknown[], text: string): boolean {
  return decodedMessagesContain(messages, (record) =>
    Object.values(record).some((value) => typeof value === 'string' && value.includes(text)),
  );
}

function messageTreeContainsTaskComplete(messages: unknown[]): boolean {
  return decodedMessagesContain(messages, (record) => record.type === 'task_complete');
}

function messageTreeContainsTurnCancelled(messages: unknown[]): boolean {
  return decodedMessagesContain(messages, (record) => record.type === 'turn_cancelled');
}

describe('core e2e: Gemini ACP cancelled stopReason and load replay', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('loads replayed Gemini ACP history, surfaces cancelled turns, and resumes later turns', async () => {
    const testDir = run.testDir('gemini-acp-cancelled-load-replay');
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const cliHome = resolve(join(testDir, 'cli-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(cliHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome, serverUrl: server.baseUrl, token: auth.token, secret });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'gemini-acp-cancelled-load-replay',
        geminiSessionId: 'gemini-resume-remote-1',
        createdAt: Date.now(),
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-gemini-acp-cancelled-load-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    const attachFile = await writeCliSessionAttachFile({ cliHome, sessionId, secret });
    const fakeGeminiPath = resolve(join(fakeBinDir, 'gemini'));
    const fakeGeminiLog = resolve(join(testDir, 'fake-gemini.jsonl'));
    const acpSdkEntry = resolve(repoRootDir(), 'apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js');

    await writeFile(
      fakeGeminiPath,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Readable, Writable } from "node:stream";

if (process.argv.includes("--help")) {
  process.stdout.write("fake gemini usage --acp\\n");
  process.exit(0);
}

function log(line) {
  const p = process.env.HAPPIER_E2E_GEMINI_LOG;
  if (p) appendFileSync(p, JSON.stringify({ ts: Date.now(), ...line }) + "\\n", "utf8");
}

function promptText(blocks) {
  return Array.isArray(blocks)
    ? blocks.map((b) => b && typeof b === "object" && b.type === "text" ? String(b.text || "") : "").join("\\n")
    : "";
}

const acp = await import(pathToFileURL(${JSON.stringify(acpSdkEntry)}).href);

class FakeGeminiAgent {
  connection;
  constructor(connection) { this.connection = connection; }

  async initialize(_params) {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
    };
  }

  async authenticate(_params) { return {}; }

  async newSession(_params) { return { sessionId: randomUUID() }; }

  async loadSession(params) {
    const servers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
    log({
      kind: "loadSession",
      sessionId: String(params?.sessionId || ""),
      mcpServerNames: servers.map((server) => server && typeof server === "object" ? String(server.name || "") : ""),
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "REMOTE_REPLAY_USER_T25" } },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REMOTE_REPLAY_AGENT_T25" } },
    });
    log({ kind: "loadReplayUpdate", marker: "REMOTE_REPLAY_AGENT_T25" });
    return {};
  }

  async prompt(params) {
    const text = promptText(params.prompt);
    log({ kind: "prompt", text });
    if (text.includes("GEMINI_ACP_CANCELLED_T5")) {
      log({ kind: "promptReturn", marker: "GEMINI_ACP_CANCELLED_T5", stopReason: "cancelled" });
      return { stopReason: "cancelled" };
    }
    if (text.includes("GEMINI_ACP_AFTER_LOAD_OK_T25")) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after load replay response" } },
      });
      log({ kind: "promptReturn", marker: "GEMINI_ACP_AFTER_LOAD_OK_T25", stopReason: "end_turn" });
      return { stopReason: "end_turn" };
    }
    return { stopReason: "end_turn" };
  }

  async cancel(_params) {}
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeGeminiAgent(conn), stream);
`,
      'utf8',
    );
    await chmod(fakeGeminiPath, 0o755);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'gemini-acp-cancelled-load-replay',
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
      HAPPIER_GEMINI_PATH: fakeGeminiPath,
      GEMINI_API_KEY: 'e2e-fake-gemini-api-key',
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
      HAPPIER_E2E_GEMINI_LOG: fakeGeminiLog,
    };

    const cliDistEntrypoint = await ensureCliDistBuilt({ testDir, env: cliEnv });
    const proc: SpawnedProcess = spawnLoggedProcess({
      command: process.execPath,
      args: [
        cliDistEntrypoint,
        'gemini',
        '--existing-session',
        sessionId,
        '--resume',
        'gemini-resume-remote-1',
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

    try {
      const cancelledLocalId = `pending-${randomUUID()}`;
      const cancelledCiphertext = encryptLegacyBase64(
        {
          role: 'user',
          content: { type: 'text', text: 'GEMINI_ACP_CANCELLED_T5' },
          localId: cancelledLocalId,
          meta: { source: 'ui', sentFrom: 'e2e' },
        },
        secret,
      );
      expect((await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId: cancelledLocalId,
        ciphertext: cancelledCiphertext,
        timeoutMs: 20_000,
      })).status).toBe(200);

      await waitFor(async () => {
        const events = await readFakeGeminiEvents(fakeGeminiLog);
        return events.some((event) => event.kind === 'loadSession' && event.sessionId === 'gemini-resume-remote-1');
      }, { timeoutMs: 45_000, intervalMs: 250, context: 'Gemini ACP session/load called' });

      const loadEvents = await readFakeGeminiEvents(fakeGeminiLog);
      const loaded = loadEvents.find((event) => event.kind === 'loadSession');
      expect(loaded?.mcpServerNames.filter((name) => name === 'happier')).toHaveLength(1);
      expect(new Set(loaded?.mcpServerNames ?? []).size).toBe(loaded?.mcpServerNames.length ?? 0);

      await waitFor(async () => {
        const messages = await decryptSessionMessages({ baseUrl: server!.baseUrl, token: auth.token, sessionId, secret });
        return messageTreeContainsText(messages, 'REMOTE_REPLAY_USER_T25')
          && messageTreeContainsText(messages, 'REMOTE_REPLAY_AGENT_T25');
      }, { timeoutMs: 60_000, intervalMs: 500, context: 'Gemini load replay imported' });

      await waitFor(async () => {
        const events = await readFakeGeminiEvents(fakeGeminiLog);
        return events.some((event) =>
          event.kind === 'promptReturn'
          && event.marker === 'GEMINI_ACP_CANCELLED_T5'
          && event.stopReason === 'cancelled',
        );
      }, { timeoutMs: 60_000, intervalMs: 250, context: 'Gemini cancelled stopReason returned' });

      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        return snap.latestTurnStatus === 'cancelled' && snap.lastRuntimeIssue === null;
      }, { timeoutMs: 60_000, intervalMs: 500, context: 'cancelled Gemini turn surfaced' });

      const afterCancelledMessages = await decryptSessionMessages({ baseUrl: server.baseUrl, token: auth.token, sessionId, secret });
      expect(messageTreeContainsTurnCancelled(afterCancelledMessages)).toBe(true);
      expect(messageTreeContainsTaskComplete(afterCancelledMessages)).toBe(false);

      const followupLocalId = `pending-${randomUUID()}`;
      const followupCiphertext = encryptLegacyBase64(
        {
          role: 'user',
          content: { type: 'text', text: 'GEMINI_ACP_AFTER_LOAD_OK_T25' },
          localId: followupLocalId,
          meta: { source: 'ui', sentFrom: 'e2e' },
        },
        secret,
      );
      expect((await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId: followupLocalId,
        ciphertext: followupCiphertext,
        timeoutMs: 20_000,
      })).status).toBe(200);

      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        return snap.latestTurnStatus === 'completed' && snap.lastRuntimeIssue === null;
      }, { timeoutMs: 60_000, intervalMs: 500, context: 'post-load follow-up turn completed' });

      const finalMessages = await decryptSessionMessages({ baseUrl: server.baseUrl, token: auth.token, sessionId, secret });
      expect(messageTreeContainsText(finalMessages, 'after load replay response')).toBe(true);
      expect(messageTreeContainsTaskComplete(finalMessages)).toBe(true);
    } finally {
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});
