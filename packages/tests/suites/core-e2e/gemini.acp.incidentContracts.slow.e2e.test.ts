import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  | { kind: 'newSession'; ts: number; mcpServerNames: string[]; mcpServerCount: number }
  | { kind: 'prompt'; ts: number; text: string }
  | { kind: 'thinkingUpdate'; ts: number; marker: string }
  | { kind: 'promptReturn'; ts: number; marker: string }
  | { kind: 'permissionResult'; ts: number; outcome: unknown };

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

function decodedMessagesContainTaskComplete(decodedMessages: unknown[]): boolean {
  const stack = [...decodedMessages];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }

    const record = value as Record<string, unknown>;
    if (record.type === 'task_complete') return true;
    stack.push(...Object.values(record));
  }
  return false;
}

async function taskCompleteMessageCreatedAts(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
}): Promise<number[]> {
  const rows = await fetchAllMessages(params.baseUrl, params.token, params.sessionId);
  return rows.flatMap((row) => {
    try {
      const decoded = decryptLegacyBase64(row.content.c, params.secret);
      return decodedMessagesContainTaskComplete([decoded]) ? [row.createdAt] : [];
    } catch {
      return [];
    }
  });
}

describe('core e2e: Gemini ACP incident contracts', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('keeps a thinking-only turn open until stopReason and uses title-sourced execute permissions', async () => {
    const testDir = run.testDir('gemini-acp-incident-contracts');
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
        name: 'gemini-acp-incident-contracts',
        createdAt: Date.now(),
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-gemini-acp-incident-${randomUUID()}`,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      agentCapabilities: { loadSession: false },
      authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
    };
  }

  async authenticate(_params) { return {}; }

  async newSession(params) {
    const servers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
    log({
      kind: "newSession",
      mcpServerNames: servers.map((server) => server && typeof server === "object" ? String(server.name || "") : ""),
      mcpServerCount: servers.length,
    });
    return { sessionId: randomUUID() };
  }

  async prompt(params) {
    const text = promptText(params.prompt);
    log({ kind: "prompt", text });

    if (text.includes("GEMINI_ACP_THINKING_ONLY")) {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking without visible assistant output" },
        },
      });
      log({ kind: "thinkingUpdate", marker: "GEMINI_ACP_THINKING_ONLY" });
      await sleep(Number(process.env.HAPPIER_E2E_GEMINI_THINKING_SILENCE_MS || "3000"));
      log({ kind: "promptReturn", marker: "GEMINI_ACP_THINKING_ONLY" });
      return { stopReason: "end_turn" };
    }

    if (text.includes("GEMINI_ACP_PERMISSION_TITLE")) {
      const titleCommand = process.env.HAPPIER_E2E_PERMISSION_TITLE_COMMAND || "";
      const resp = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "execute-title-command-1",
          title: titleCommand,
          kind: "execute",
          status: "pending",
        },
        options: [
          { kind: "allow_once", name: "Allow for this session", optionId: "allow_once" },
          { kind: "reject_once", name: "Deny", optionId: "deny" },
        ],
      });
      log({ kind: "permissionResult", outcome: resp.outcome });
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
      testName: 'gemini-acp-incident-contracts',
      sessionIds: [sessionId],
      env: {},
    });

    const titleCommand =
      `happier tools call --session-id "${sessionId}" --directory "${workspaceDir}" ` +
      `--source happier --tool change_title --args-json '{"title":"Gemini ACP Incident"}' --json`;
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
      HAPPIER_E2E_GEMINI_THINKING_SILENCE_MS: '3000',
      HAPPIER_E2E_PERMISSION_TITLE_COMMAND: titleCommand,
    };

    const cliDistEntrypoint = await ensureCliDistBuilt({ testDir, env: cliEnv });
    const proc: SpawnedProcess = spawnLoggedProcess({
      command: process.execPath,
      args: [
        cliDistEntrypoint,
        'gemini',
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

    try {
      const baseline = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      const baselineAgentStateVersion = baseline.agentStateVersion;
      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        return snap.active === true || snap.agentStateVersion > baselineAgentStateVersion;
      }, { timeoutMs: 45_000, intervalMs: 250, context: 'Gemini CLI attached' });

      const thinkingLocalId = `pending-${randomUUID()}`;
      const thinkingCiphertext = encryptLegacyBase64(
        {
          role: 'user',
          content: { type: 'text', text: 'GEMINI_ACP_THINKING_ONLY set title with change_title if needed' },
          localId: thinkingLocalId,
          meta: { source: 'ui', sentFrom: 'e2e' },
        },
        secret,
      );
      const enqueueThinking = await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId: thinkingLocalId,
        ciphertext: thinkingCiphertext,
        timeoutMs: 20_000,
      });
      expect(enqueueThinking.status).toBe(200);

      await waitFor(async () => {
        const events = await readFakeGeminiEvents(fakeGeminiLog);
        return events.some((event) => event.kind === 'thinkingUpdate');
      }, { timeoutMs: 45_000, intervalMs: 250, context: 'thinking-only update' });

      const sessionEvents = await readFakeGeminiEvents(fakeGeminiLog);
      const newSessionEvents = sessionEvents.filter((event) => event.kind === 'newSession');
      expect(newSessionEvents).toHaveLength(1);
      const mcpNames = newSessionEvents[0]?.mcpServerNames ?? [];
      expect(mcpNames.filter((name) => name === 'happier')).toHaveLength(1);
      expect(new Set(mcpNames).size).toBe(mcpNames.length);

      await waitFor(async () => {
        const events = await readFakeGeminiEvents(fakeGeminiLog);
        return events.some((event) => event.kind === 'promptReturn');
      }, { timeoutMs: 20_000, intervalMs: 250, context: 'thinking-only prompt stopReason' });

      const completedThinkingEvents = await readFakeGeminiEvents(fakeGeminiLog);
      const thinkingUpdate = completedThinkingEvents.find((event) => event.kind === 'thinkingUpdate');
      const promptReturn = completedThinkingEvents.find((event) => event.kind === 'promptReturn');
      expect(thinkingUpdate?.ts).toEqual(expect.any(Number));
      expect(promptReturn?.ts).toEqual(expect.any(Number));
      expect((promptReturn?.ts ?? 0) - (thinkingUpdate?.ts ?? 0)).toBeGreaterThan(500);
      const taskCompleteCreatedAtsBeforePermission = await taskCompleteMessageCreatedAts({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        secret,
      });
      expect(
        taskCompleteCreatedAtsBeforePermission.every((createdAt) => createdAt >= (promptReturn?.ts ?? Number.POSITIVE_INFINITY)),
      ).toBe(true);

      const permissionLocalId = `pending-${randomUUID()}`;
      const permissionCiphertext = encryptLegacyBase64(
        {
          role: 'user',
          content: { type: 'text', text: 'GEMINI_ACP_PERMISSION_TITLE request execute permission' },
          localId: permissionLocalId,
          meta: { source: 'ui', sentFrom: 'e2e' },
        },
        secret,
      );
      const enqueuePermission = await enqueuePendingQueueV2({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        localId: permissionLocalId,
        ciphertext: permissionCiphertext,
        timeoutMs: 20_000,
      });
      expect(enqueuePermission.status).toBe(200);

      await waitFor(async () => {
        const events = await readFakeGeminiEvents(fakeGeminiLog);
        return events.some((event) => event.kind === 'permissionResult');
      }, { timeoutMs: 60_000, intervalMs: 250, context: 'title-sourced execute permission result' });

      const finalEvents = await readFakeGeminiEvents(fakeGeminiLog);
      const promptTexts = finalEvents.flatMap((event) => event.kind === 'prompt' ? [event.text] : []);
      expect(promptTexts.some((text) => text.includes('GEMINI_ACP_THINKING_ONLY'))).toBe(true);
      expect(promptTexts.join('\n')).not.toContain('happier tools call --session-id');
      expect(promptTexts.join('\n')).not.toContain('Happier tools shell');

      const permissionResult = finalEvents.find((event) => event.kind === 'permissionResult');
      expect(permissionResult?.outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });

      await waitFor(async () => {
        const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
        return snap.latestTurnStatus === 'completed' && snap.lastRuntimeIssue === null;
      }, { timeoutMs: 60_000, intervalMs: 500, context: 'thinking-only turn completion' });

      const finalTaskCompleteCreatedAts = await taskCompleteMessageCreatedAts({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId,
        secret,
      });
      expect(finalTaskCompleteCreatedAts.length).toBeGreaterThan(0);
    } finally {
      await proc.stop();
      await stopDaemonFromHomeDir(cliHome).catch(() => {});
    }
  }, 240_000);
});
