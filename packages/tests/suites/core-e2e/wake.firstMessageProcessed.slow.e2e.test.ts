import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { enqueueSessionPromptForScenario, waitForAssistantMessageContaining } from '../../src/testkit/providers/scenarios/sessionRuntime';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchAllMessages, fetchSessionV2, type SessionMessageRow } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { postEncryptedUiTextMessage } from '../../src/testkit/uiMessages';

const run = createRunDirs({ runLabel: 'core' });

type WakeSubmitPath = 'pending_queue' | 'direct_commit';

type WakeProviderCase = Readonly<{
  backend: 'fake-claude' | 'fake-gemini-acp';
  agentId: 'claude' | 'gemini';
  submitPath: WakeSubmitPath;
  supportsServerPending: boolean;
  assistantSubstring: string;
}>;

const WAKE_PROVIDER_CASES = [
  {
    backend: 'fake-claude',
    agentId: 'claude',
    submitPath: 'pending_queue',
    supportsServerPending: true,
    assistantSubstring: 'FAKE_CLAUDE_OK_',
  },
  {
    backend: 'fake-claude',
    agentId: 'claude',
    submitPath: 'direct_commit',
    supportsServerPending: false,
    assistantSubstring: 'FAKE_CLAUDE_OK_',
  },
  {
    backend: 'fake-gemini-acp',
    agentId: 'gemini',
    submitPath: 'pending_queue',
    supportsServerPending: true,
    assistantSubstring: 'FAKE_GEMINI_OK_',
  },
] as const satisfies readonly WakeProviderCase[];

// Extension point: add new fake backend adapters here once they can spawn deterministically in core e2e.

type RunningWakeHarness = Readonly<{
  authToken: string;
  daemon: StartedDaemon;
  daemonHomeDir: string;
  fakeBinDir: string;
  fakeClaudeLogPath: string;
  fakeClaudePath: string;
  fakeGeminiLogPath: string;
  fakeGeminiPath: string;
  secret: Uint8Array;
  server: StartedServer;
  workspaceDir: string;
}>;

type DecryptedMessage = Readonly<{ row: SessionMessageRow; value: unknown }>;
type ProviderEnvParams = Readonly<{
  daemonHomeDir: string;
  fakeBinDir: string;
  fakeClaudeLogPath: string;
  fakeClaudePath: string;
  fakeGeminiLogPath: string;
  fakeGeminiPath: string;
  serverBaseUrl: string;
}>;

type FakeGeminiEvent =
  | Readonly<{ kind: 'newSession'; ts: number; sessionId: string }>
  | Readonly<{ kind: 'loadSession'; ts: number; sessionId: string }>
  | Readonly<{ kind: 'prompt'; ts: number; text: string }>
  | Readonly<{ kind: 'promptReturn'; ts: number; marker: string; stopReason: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readUserText(value: unknown): string | null {
  if (!isRecord(value) || value.role !== 'user') return null;
  const content = value.content;
  if (!isRecord(content) || content.type !== 'text') return null;
  return typeof content.text === 'string' ? content.text : null;
}

async function readJsonlEvents(path: string): Promise<unknown[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

async function countFakeClaudeUserTextOccurrences(logPath: string, text: string): Promise<number> {
  const events = await readJsonlEvents(logPath);
  return events.filter((event) => {
    if (!isRecord(event)) return false;
    if (event.type !== 'sdk_stdin' || event.hasUserText !== true) return false;
    return typeof event.userTextPreview === 'string' && event.userTextPreview.includes(text);
  }).length;
}

async function readFakeGeminiEvents(path: string): Promise<FakeGeminiEvent[]> {
  return (await readJsonlEvents(path)).filter((event): event is FakeGeminiEvent => {
    if (!isRecord(event) || typeof event.kind !== 'string') return false;
    if (event.kind === 'newSession' || event.kind === 'loadSession') {
      return typeof event.sessionId === 'string';
    }
    if (event.kind === 'prompt') {
      return typeof event.text === 'string';
    }
    if (event.kind === 'promptReturn') {
      return typeof event.marker === 'string' && typeof event.stopReason === 'string';
    }
    return false;
  });
}

async function waitForFakeGeminiPromptText(
  logPath: string,
  predicate: (text: string) => boolean,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const pollMs = opts?.pollMs ?? 100;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const events = await readFakeGeminiEvents(logPath);
    for (const event of events) {
      if (event.kind !== 'prompt') continue;
      if (predicate(event.text)) return event.text;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Timed out waiting for fake Gemini prompt text in ${logPath}`);
}

async function countFakeGeminiPromptTextOccurrences(logPath: string, text: string): Promise<number> {
  const events = await readFakeGeminiEvents(logPath);
  return events.filter((event) => event.kind === 'prompt' && event.text.includes(text)).length;
}

async function readDecryptedMessages(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
}): Promise<DecryptedMessage[]> {
  const rows = await fetchAllMessages(params.baseUrl, params.token, params.sessionId);
  return rows.flatMap((row) => {
    const value = decryptLegacyBase64(row.content.c, params.secret);
    return value === null ? [] : [{ row, value }];
  });
}

async function readTranscriptUserTextMatches(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  text: string;
}): Promise<DecryptedMessage[]> {
  const rows = await readDecryptedMessages(params);
  return rows.filter(({ value }) => readUserText(value) === params.text);
}

async function writeFakeGeminiAcpCli(params: {
  fakeGeminiLogPath: string;
  fakeGeminiPath: string;
}): Promise<void> {
  const acpSdkEntry = resolve(repoRootDir(), 'apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js');
  await writeFile(
    params.fakeGeminiPath,
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

  async newSession(_params) {
    const sessionId = randomUUID();
    log({ kind: "newSession", sessionId });
    return { sessionId };
  }

  async loadSession(params) {
    const sessionId = String(params?.sessionId || "");
    log({ kind: "loadSession", sessionId });
    return {};
  }

  async prompt(params) {
    const text = promptText(params.prompt);
    log({ kind: "prompt", text });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "FAKE_GEMINI_OK_" + Date.now() },
      },
    });
    log({ kind: "promptReturn", marker: "FAKE_GEMINI_OK", stopReason: "end_turn" });
    return { stopReason: "end_turn" };
  }

  async cancel(_params) {}
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeGeminiAgent(conn), stream);
`,
    'utf8',
  );
  await chmod(params.fakeGeminiPath, 0o755);
}

function createProviderEnv(params: ProviderEnvParams): Record<string, string> {
  return {
    CI: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_HOME_DIR: params.daemonHomeDir,
    HAPPIER_SERVER_URL: params.serverBaseUrl,
    HAPPIER_WEBAPP_URL: params.serverBaseUrl,
    HAPPIER_CLAUDE_PATH: params.fakeClaudePath,
    HAPPIER_E2E_FAKE_CLAUDE_LOG: params.fakeClaudeLogPath,
    HAPPIER_GEMINI_PATH: params.fakeGeminiPath,
    HAPPIER_E2E_GEMINI_LOG: params.fakeGeminiLogPath,
    GEMINI_API_KEY: 'e2e-fake-gemini-api-key',
    PATH: `${params.fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
  };
}

function createDaemonEnv(params: ProviderEnvParams): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...createProviderEnv(params),
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
  };
}

async function startWakeHarness(params: { testDir: string }): Promise<RunningWakeHarness> {
  const server = await startServerLight({ testDir: params.testDir, dbProvider: 'sqlite' });
  const auth = await createTestAuth(server.baseUrl);

  const daemonHomeDir = resolve(join(params.testDir, 'daemon-home'));
  const workspaceDir = resolve(join(params.testDir, 'workspace'));
  const fakeBinDir = resolve(join(params.testDir, 'fake-bin'));
  await mkdir(daemonHomeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(fakeBinDir, { recursive: true });

  const secret = Uint8Array.from(randomBytes(32));
  await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, token: auth.token, secret });

  const fakeClaudePath = fakeClaudeFixturePath();
  const fakeClaudeLogPath = resolve(join(params.testDir, 'fake-claude.jsonl'));
  const fakeGeminiPath = resolve(join(fakeBinDir, 'gemini'));
  const fakeGeminiLogPath = resolve(join(params.testDir, 'fake-gemini.jsonl'));
  await writeFakeGeminiAcpCli({ fakeGeminiPath, fakeGeminiLogPath });
  const daemon = await startTestDaemon({
    testDir: params.testDir,
    happyHomeDir: daemonHomeDir,
    env: createDaemonEnv({
      daemonHomeDir,
      fakeBinDir,
      fakeClaudePath,
      fakeClaudeLogPath,
      fakeGeminiPath,
      fakeGeminiLogPath,
      serverBaseUrl: server.baseUrl,
    }),
    snapshotDir: resolve(join(params.testDir, 'daemon-cli-snapshot')),
  });

  return {
    authToken: auth.token,
    daemon,
    daemonHomeDir,
    fakeBinDir,
    fakeClaudeLogPath,
    fakeClaudePath,
    fakeGeminiLogPath,
    fakeGeminiPath,
    secret,
    server,
    workspaceDir,
  };
}

async function spawnProviderSession(params: {
  harness: RunningWakeHarness;
  agentId: WakeProviderCase['agentId'];
  existingSessionId?: string;
  initialTranscriptAfterSeq?: number;
}): Promise<string> {
  const { harness } = params;
  const res = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
    port: harness.daemon.state.httpPort,
    path: '/spawn-session',
    controlToken: harness.daemon.state.controlToken,
    body: {
      directory: harness.workspaceDir,
      ...(params.existingSessionId ? { existingSessionId: params.existingSessionId } : {}),
      ...(typeof params.initialTranscriptAfterSeq === 'number'
        ? { initialTranscriptAfterSeq: params.initialTranscriptAfterSeq }
        : {}),
      backendTarget: { kind: 'builtInAgent', agentId: params.agentId },
      terminal: { mode: 'plain' },
      environmentVariables: createProviderEnv({
        daemonHomeDir: harness.daemonHomeDir,
        fakeBinDir: harness.fakeBinDir,
        fakeClaudePath: harness.fakeClaudePath,
        fakeClaudeLogPath: harness.fakeClaudeLogPath,
        fakeGeminiPath: harness.fakeGeminiPath,
        fakeGeminiLogPath: harness.fakeGeminiLogPath,
        serverBaseUrl: harness.server.baseUrl,
      }),
    },
  });
  expect(res.status).toBe(200);
  expect(res.data.success).toBe(true);
  expect(typeof res.data.sessionId).toBe('string');
  if (typeof res.data.sessionId !== 'string' || res.data.sessionId.length === 0) {
    throw new Error('Missing sessionId from daemon spawn-session');
  }
  return res.data.sessionId;
}

async function stopSession(params: { harness: RunningWakeHarness; sessionId: string }): Promise<void> {
  const res = await daemonControlPostJson<{ success: boolean }>({
    port: params.harness.daemon.state.httpPort,
    path: '/stop-session',
    controlToken: params.harness.daemon.state.controlToken,
    body: { sessionId: params.sessionId },
  });
  expect(res.status).toBe(200);
  expect(res.data.success).toBe(true);

  await waitFor(async () => {
    const snap = await fetchSessionV2(params.harness.server.baseUrl, params.harness.authToken, params.sessionId);
    return snap.active === false;
  }, { timeoutMs: 30_000, context: 'session inactive after stop-session' });
}

async function waitForProviderPromptText(params: {
  harness: RunningWakeHarness;
  providerCase: WakeProviderCase;
  prompt: string;
  timeoutMs: number;
}): Promise<void> {
  if (params.providerCase.backend === 'fake-claude') {
    await waitForFakeClaudeUserText(params.harness.fakeClaudeLogPath, (text) => text.includes(params.prompt), {
      timeoutMs: params.timeoutMs,
      pollMs: 150,
    });
    return;
  }

  await waitForFakeGeminiPromptText(params.harness.fakeGeminiLogPath, (text) => text.includes(params.prompt), {
    timeoutMs: params.timeoutMs,
    pollMs: 150,
  });
}

async function countProviderPromptTextOccurrences(params: {
  harness: RunningWakeHarness;
  providerCase: WakeProviderCase;
  prompt: string;
}): Promise<number> {
  if (params.providerCase.backend === 'fake-claude') {
    return await countFakeClaudeUserTextOccurrences(params.harness.fakeClaudeLogPath, params.prompt);
  }

  return await countFakeGeminiPromptTextOccurrences(params.harness.fakeGeminiLogPath, params.prompt);
}

async function seedBaselineTurn(params: {
  harness: RunningWakeHarness;
  providerCase: WakeProviderCase;
  sessionId: string;
  prompt: string;
}): Promise<void> {
  await enqueueSessionPromptForScenario({
    baseUrl: params.harness.server.baseUrl,
    token: params.harness.authToken,
    sessionId: params.sessionId,
    secret: params.harness.secret,
    text: params.prompt,
  });
  await waitForProviderPromptText({
    harness: params.harness,
    providerCase: params.providerCase,
    prompt: params.prompt,
    timeoutMs: 60_000,
  });
  await waitForAssistantMessageContaining({
    baseUrl: params.harness.server.baseUrl,
    token: params.harness.authToken,
    sessionId: params.sessionId,
    secret: params.harness.secret,
    requiredSubstring: params.providerCase.assistantSubstring,
    timeoutMs: 120_000,
  });
}

async function enqueueWakePrompt(params: {
  harness: RunningWakeHarness;
  sessionId: string;
  prompt: string;
  submitPath: WakeSubmitPath;
}): Promise<number | undefined> {
  if (params.submitPath === 'pending_queue') {
    await enqueueSessionPromptForScenario({
      baseUrl: params.harness.server.baseUrl,
      token: params.harness.authToken,
      sessionId: params.sessionId,
      secret: params.harness.secret,
      text: params.prompt,
    });
    await waitFor(async () => {
      const pending = await listPendingQueueV2({
        baseUrl: params.harness.server.baseUrl,
        token: params.harness.authToken,
        sessionId: params.sessionId,
      });
      return pending.status === 200 && pending.data.pending?.some((item) => item.localId) === true;
    }, { timeoutMs: 30_000, context: 'wake prompt queued in pending queue' });
    return undefined;
  }

  await postEncryptedUiTextMessage({
    baseUrl: params.harness.server.baseUrl,
    token: params.harness.authToken,
    sessionId: params.sessionId,
    secret: params.harness.secret,
    text: params.prompt,
    timeoutMs: 20_000,
  });
  await waitFor(async () => {
    const matches = await readTranscriptUserTextMatches({
      baseUrl: params.harness.server.baseUrl,
      token: params.harness.authToken,
      sessionId: params.sessionId,
      secret: params.harness.secret,
      text: params.prompt,
    });
    return matches.length === 1;
  }, { timeoutMs: 30_000, context: 'direct-commit wake prompt committed once' });

  const pending = await listPendingQueueV2({
    baseUrl: params.harness.server.baseUrl,
    token: params.harness.authToken,
    sessionId: params.sessionId,
  });
  expect(pending.status).toBe(200);
  expect(pending.data.pending ?? []).toHaveLength(0);

  const matches = await readTranscriptUserTextMatches({
    baseUrl: params.harness.server.baseUrl,
    token: params.harness.authToken,
    sessionId: params.sessionId,
    secret: params.harness.secret,
    text: params.prompt,
  });
  expect(matches).toHaveLength(1);
  const wakeSeq = matches[0]!.row.seq;
  return Math.max(0, wakeSeq - 1);
}

async function assertWakePromptProcessedExactlyOnce(params: {
  harness: RunningWakeHarness;
  providerCase: WakeProviderCase;
  sessionId: string;
  prompt: string;
  afterSeqStart: number;
}): Promise<void> {
  await waitForProviderPromptText({
    harness: params.harness,
    providerCase: params.providerCase,
    prompt: params.prompt,
    timeoutMs: 90_000,
  });
  await waitForAssistantMessageContaining({
    baseUrl: params.harness.server.baseUrl,
    token: params.harness.authToken,
    sessionId: params.sessionId,
    secret: params.harness.secret,
    requiredSubstring: params.providerCase.assistantSubstring,
    afterSeqStart: params.afterSeqStart,
    timeoutMs: 120_000,
  });

  await waitFor(async () => {
    const count = await countProviderPromptTextOccurrences(params);
    return count >= 1;
  }, { timeoutMs: 10_000, context: `${params.providerCase.backend} observed wake prompt` });

  const fakeOccurrences = await countProviderPromptTextOccurrences(params);
  expect(fakeOccurrences).toBe(1);

  const transcriptOccurrences = await readTranscriptUserTextMatches({
    baseUrl: params.harness.server.baseUrl,
    token: params.harness.authToken,
    sessionId: params.sessionId,
    secret: params.harness.secret,
    text: params.prompt,
  });
  expect(transcriptOccurrences).toHaveLength(1);

  const pending = await listPendingQueueV2({
    baseUrl: params.harness.server.baseUrl,
    token: params.harness.authToken,
    sessionId: params.sessionId,
  });
  expect(pending.status).toBe(200);
  expect(pending.data.pending ?? []).toHaveLength(0);
}

describe('wake/resume: first message processed', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it.each(WAKE_PROVIDER_CASES)(
    'processes the first wake prompt exactly once through $backend ($submitPath, supportsServerPending=$supportsServerPending)',
    async (caseItem) => {
      const testDir = run.testDir(`wake-first-message-${caseItem.backend}-${caseItem.submitPath}`);
      const harness = await startWakeHarness({ testDir });
      server = harness.server;
      daemon = harness.daemon;

      const sessionId = await spawnProviderSession({ harness, agentId: caseItem.agentId });
      const baselinePrompt = `E2E_WAKE_BASELINE_${caseItem.submitPath}_${randomBytes(8).toString('hex')}`;
      await seedBaselineTurn({ harness, providerCase: caseItem, sessionId, prompt: baselinePrompt });

      await stopSession({ harness, sessionId });

      const beforeWakeRows = await fetchAllMessages(harness.server.baseUrl, harness.authToken, sessionId);
      const beforeWakeSeq = beforeWakeRows.length > 0
        ? Math.max(...beforeWakeRows.map((row) => row.seq))
        : 0;
      const wakePrompt = `E2E_WAKE_FIRST_ONCE_${caseItem.submitPath}_${randomBytes(8).toString('hex')}`;
      const initialTranscriptAfterSeq = await enqueueWakePrompt({
        harness,
        sessionId,
        prompt: wakePrompt,
        submitPath: caseItem.submitPath,
      });

      const resumedSessionId = await spawnProviderSession({
        harness,
        agentId: caseItem.agentId,
        existingSessionId: sessionId,
        initialTranscriptAfterSeq,
      });
      expect(resumedSessionId).toBe(sessionId);

      await assertWakePromptProcessedExactlyOnce({
        harness,
        providerCase: caseItem,
        sessionId,
        prompt: wakePrompt,
        afterSeqStart: beforeWakeSeq,
      });
    },
    360_000,
  );
});
