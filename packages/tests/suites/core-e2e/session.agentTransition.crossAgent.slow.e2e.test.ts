import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RPC_METHODS,
  SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX,
  SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
  SessionAgentTransitionResultV1Schema,
  buildSessionAgentTransitionDividerLocalId,
  isSessionAgentTransitionDividerLocalId,
  openEncryptedDataKeyEnvelopeV1,
  readSessionAgentTransitionDividerFromStoredRecordV1,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startTestDaemon, stopDaemonFromHomeDir, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import {
  fakeClaudeFixturePath,
  waitForFakeClaudeInvocation,
  waitForFakeClaudeUserText,
} from '../../src/testkit/fakeClaude';
import {
  readFakeCodexAppServerRequestLog,
  writeFakeCodexAppServerScript,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { fetchJson } from '../../src/testkit/http';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveAcpSdkTestRuntime } from '../../src/testkit/providers/acpSdkTestRuntime';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchAllMessages, fetchSessionV2, type SessionMessageRow } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { unwrapSerializedJsonValue } from '../../src/testkit/unwrapSerializedJsonValue';

/**
 * The same-Session cross-Agent transition, proven end to end through a real
 * server + daemon + CLI loop with FAKE Agents. No stack, no Agent credentials,
 * no paid traffic.
 *
 * The pair is fake-Claude -> fake-Gemini(ACP) because both already run under one
 * daemon from one spawn environment (`wake.firstMessageProcessed` establishes
 * that combination in this tree). The deciding properties are Agent-agnostic:
 * the same Session row keeps its identity while its runtime Agent is replaced,
 * exactly one divider is appended at the reserved localId, and the submitted
 * localId is admitted exactly once.
 *
 * DATA-KEY auth is not incidental. The transition's bounded context pass runs
 * through the Replay owner, and `hydrateReplayDialogFromForkChain` can only open
 * an `e2ee` Session's transcript when `credentials.encryption.type === 'dataKey'`
 * — a legacy-secret CLI home makes every segment unreadable, so the daemon stops
 * the source and then answers `partially_applied` / `context_unavailable`
 * (observed). A legacy-secret harness therefore cannot reach the assertions
 * below at all.
 *
 * A composed run that only checks that the target REPLIED is insufficient: a
 * reply proves only that something ran. `dev` shipped a defect in which the
 * target was activated with ZERO context and still reported `accepted`, so this
 * file also reads the target Agent's own recorded prompts — the exact admitted
 * text must reach the target, and that prompt must carry source history.
 *
 * Strict per-step call ordering (stop before any target effect) is owned by
 * `apps/cli/src/session/agentTransition/sessionAgentTransitionCoordinator.test.ts`.
 * What this file proves is the composed, cross-process form: no source activity
 * at or after the target's first prompt, and a durable transcript in which the
 * divider precedes the target's first output.
 */

const run = createRunDirs({ runLabel: 'core' });

type ProviderEnvParams = Readonly<{
  daemonHomeDir: string;
  fakeBinDir: string;
  fakeClaudeLogPath: string;
  fakeClaudePath: string;
  fakeGeminiLogPath: string;
  fakeGeminiPath: string;
  serverBaseUrl: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function createClaudeCodexProviderEnv(params: Readonly<{
  daemonHomeDir: string;
  fakeClaudeLogPath: string;
  fakeClaudePath: string;
  fakeCodexAppServerPath: string;
  serverBaseUrl: string;
}>): Record<string, string> {
  return {
    CI: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_HOME_DIR: params.daemonHomeDir,
    HAPPIER_SERVER_URL: params.serverBaseUrl,
    HAPPIER_WEBAPP_URL: params.serverBaseUrl,
    HAPPIER_CLAUDE_PATH: params.fakeClaudePath,
    // The composed assertion reads the target's real prompt. The default
    // fixture log only retains a preview, which can omit the admitted input
    // after a bounded replay seed.
    HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
    HAPPIER_E2E_FAKE_CLAUDE_LOG: params.fakeClaudeLogPath,
    HAPPIER_CODEX_APP_SERVER_BIN: params.fakeCodexAppServerPath,
    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
    HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
  };
}

async function writeFakeGeminiAcpCli(params: Readonly<{ fakeGeminiPath: string }>): Promise<void> {
  const { sdkEntry: acpSdkEntry, agentAppAdapterEntry } = resolveAcpSdkTestRuntime(repoRootDir());
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
const adapterEntry = process.env.HAPPIER_E2E_ACP_AGENT_APP_ADAPTER_ENTRY ?? ${JSON.stringify(agentAppAdapterEntry)};
if (!adapterEntry) throw new Error("Missing HAPPIER_E2E_ACP_AGENT_APP_ADAPTER_ENTRY");
const { connectAcpTestAgentApp } = await import(pathToFileURL(adapterEntry).href);

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
const connection = connectAcpTestAgentApp({ acp, stream, createAgent: (client) => new FakeGeminiAgent(client) });
await connection.closed;
`,
    'utf8',
  );
  await chmod(params.fakeGeminiPath, 0o755);
}

async function readJsonlEvents(path: string): Promise<Record<string, unknown>[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function readEventTimestamps(events: readonly Record<string, unknown>[]): number[] {
  return events
    .map((event) => (typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : 0))
    .filter((value) => value > 0);
}

function readCodexTurnInputText(params: Record<string, unknown> | null | undefined): string {
  const input = params?.input;
  if (!Array.isArray(input)) return '';
  return input.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const text = (entry as { text?: unknown }).text;
    return typeof text === 'string' ? [text] : [];
  }).join('\n');
}

function readCodexThreadId(params: Record<string, unknown> | null | undefined): string | null {
  const threadId = params?.threadId;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

async function readFakeGeminiPromptEvents(path: string): Promise<Record<string, unknown>[]> {
  return (await readJsonlEvents(path)).filter(
    (event) => event.kind === 'prompt' && typeof event.text === 'string',
  );
}

function decodeRow(row: SessionMessageRow, sessionKey: Uint8Array): unknown {
  return unwrapSerializedJsonValue(decryptDataKeyBase64(row.content.c, sessionKey));
}

/**
 * The daemon seals the Session's data key to its own box key when it creates the
 * Session. `fetchSessionV2` deliberately drops that field, so read it from the
 * same endpoint and open it the way a real client does.
 */
async function openSessionDataKeyWhenAvailable(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  machineKey: Uint8Array;
  timeoutMs?: number;
}>): Promise<Uint8Array> {
  let opened: Uint8Array | null = null;
  await waitFor(async () => {
    const res = await fetchJson<{ session?: { dataEncryptionKey?: unknown } }>(
      `${params.baseUrl}/v2/sessions/${params.sessionId}`,
      { headers: { Authorization: `Bearer ${params.token}` }, timeoutMs: 20_000 },
    ).catch(() => null);
    const sealed = res?.status === 200 ? res.data?.session?.dataEncryptionKey : null;
    if (typeof sealed !== 'string' || sealed.length === 0) return false;
    const dek = openEncryptedDataKeyEnvelopeV1({
      envelope: new Uint8Array(Buffer.from(sealed, 'base64')),
      recipientSecretKeyOrSeed: params.machineKey,
    });
    if (!dek || dek.length !== 32) return false;
    opened = dek;
    return true;
  }, {
    timeoutMs: params.timeoutMs ?? 60_000,
    intervalMs: 250,
    context: 'session data encryption key sealed to the daemon',
  });
  if (!opened) throw new Error('Failed to open the Session data encryption key');
  return opened;
}

async function enqueueUiTextMessage(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  sessionKey: Uint8Array;
  text: string;
}>): Promise<void> {
  const localId = randomUUID();
  const ciphertext = encryptDataKeyBase64(
    {
      role: 'user',
      content: { type: 'text', text: params.text },
      localId,
      meta: { source: 'ui', sentFrom: 'e2e' },
    },
    params.sessionKey,
  );
  const res = await enqueuePendingQueueV2({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    localId,
    ciphertext,
    timeoutMs: 20_000,
  });
  if (res.status !== 200) throw new Error(`Failed to enqueue UI message (status=${res.status})`);
}

async function waitForTranscriptTextContaining(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  sessionKey: Uint8Array;
  marker: string;
  afterSeq?: number;
  timeoutMs: number;
  context: string;
}>): Promise<void> {
  await waitFor(async () => {
    const rows = await fetchAllMessages(params.baseUrl, params.token, params.sessionId).catch(() => []);
    return rows.some((row) => {
      if (typeof params.afterSeq === 'number' && row.seq <= params.afterSeq) return false;
      const decoded = decodeRow(row, params.sessionKey);
      return decoded !== null && JSON.stringify(decoded).includes(params.marker);
    });
  }, { timeoutMs: params.timeoutMs, intervalMs: 250, context: params.context });
}

describe('core e2e: same-Session cross-Agent transition', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let daemonHomeDir: string | null = null;
  let ui: SocketCollector | null = null;

  afterEach(async () => {
    ui?.close();
    ui = null;
    if (daemonHomeDir) {
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
      daemonHomeDir = null;
    }
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('keeps the Session, appends exactly one divider, and hands the target the admitted input WITH source context', async () => {
    const testDir = run.testDir(`agent-transition-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });

    const machineKey = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliDataKeyAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey,
    });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const fakeGeminiPath = resolve(join(fakeBinDir, 'gemini'));
    const fakeGeminiLogPath = resolve(join(testDir, 'fake-gemini.jsonl'));
    await writeFakeGeminiAcpCli({ fakeGeminiPath });

    const providerEnv = createProviderEnv({
      daemonHomeDir,
      fakeBinDir,
      fakeClaudeLogPath,
      fakeClaudePath,
      fakeGeminiLogPath,
      fakeGeminiPath,
      serverBaseUrl: server.baseUrl,
    });
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        ...providerEnv,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
      snapshotDir: resolve(join(testDir, 'daemon-cli-snapshot')),
    });

    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken: daemon.state.controlToken,
      body: {
        directory: workspaceDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'plain' },
        environmentVariables: providerEnv,
      },
    });
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    // The daemon owns the Session's data key. Opening its sealed envelope with
    // the same machine key is how a real client reads this Session, and it is
    // what lets the assertions below inspect metadata and transcript rows.
    const sessionKey = await openSessionDataKeyWhenAvailable({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      machineKey,
    });

    // Drive one real source turn so the transition starts from a Session with
    // history and a live runtime, not an empty shell. Both halves of that turn
    // are the material the target must be able to see afterwards.
    const sourceText = `AGENT_TRANSITION_SOURCE_${randomUUID()}`;
    await enqueueUiTextMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      sessionKey,
      text: sourceText,
    });
    await waitForFakeClaudeInvocation(fakeClaudeLogPath, (invocation) => invocation.mode === 'sdk', {
      timeoutMs: 120_000,
    });
    await waitForTranscriptTextContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      sessionKey,
      marker: 'FAKE_CLAUDE_OK_1',
      timeoutMs: 180_000,
      context: 'source Agent completed its turn',
    });
    await waitFor(async () => {
      const snap = await fetchSessionV2(server!.baseUrl, auth.token, sessionId).catch(() => null);
      return snap?.active === true;
    }, { timeoutMs: 60_000, intervalMs: 250, context: 'source Session active' });

    const beforeTransition = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
    const messagesBefore = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    const metadataBefore = unwrapSerializedJsonValue(
      decryptDataKeyBase64(beforeTransition.metadata, sessionKey),
    );
    if (!isRecord(metadataBefore)) throw new Error('Failed to decrypt source session metadata');
    // `flavor` is the declared current-Agent identity written by
    // `projectCurrentAgentSessionView`; the transition replaces exactly it.
    expect(metadataBefore.flavor).toBe('claude');
    expect(
      messagesBefore.filter((row) => isSessionAgentTransitionDividerLocalId(row.localId)),
    ).toHaveLength(0);

    ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui!.isConnected(), { timeoutMs: 30_000, context: 'user socket connected' });
    const machineRpc = createDataKeyRpcClient(ui, machineKey);

    const submittedLocalId = `transition-${randomUUID()}`;
    const transitionText = `AGENT_TRANSITION_TARGET_${randomUUID()}`;
    const rpc = await machineRpc.call(
      `${seeded.machineId}:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      {
        v: 1,
        sessionId,
        expectedCurrentAgentId: 'claude',
        selection: { v: 1, agentId: 'gemini' },
        input: { text: transitionText, localId: submittedLocalId, meta: {} },
      },
      // One budget for both hops: the transition stops the source runtime and
      // starts the target inside this call.
      240_000,
      // The server authorizes this session-write method against the named
      // Session before forwarding anything to the machine.
      { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId },
    );
    expect(rpc.ok).toBe(true);
    if (!rpc.ok) throw new Error(`session.agentTransition failed: ${rpc.errorCode ?? rpc.error}`);
    expect(SessionAgentTransitionResultV1Schema.parse(rpc.result)).toEqual({
      type: 'accepted',
      localId: submittedLocalId,
    });

    // The Session row itself is untouched: same identity, same creation.
    const afterTransition = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
    expect(afterTransition.id).toBe(sessionId);
    expect(afterTransition.createdAt).toBe(beforeTransition.createdAt);

    const metadataAfter = unwrapSerializedJsonValue(
      decryptDataKeyBase64(afterTransition.metadata, sessionKey),
    );
    if (!isRecord(metadataAfter)) throw new Error('Failed to decrypt target session metadata');
    expect(metadataAfter.flavor).toBe('gemini');

    // Exactly one divider, at the deterministic reserved localId, carrying the
    // sidecar — read through the protocol's own canonical stored-record reader
    // rather than a shape check re-derived here.
    const messagesAfter = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    const dividerLocalId = buildSessionAgentTransitionDividerLocalId(submittedLocalId);
    const dividers = messagesAfter.filter(
      (row) => typeof row.localId === 'string'
        && row.localId.startsWith(SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX),
    );
    expect(dividers).toHaveLength(1);
    const divider = dividers[0]!;
    expect(divider.localId).toBe(dividerLocalId);
    const dividerSidecar = readSessionAgentTransitionDividerFromStoredRecordV1({
      localId: divider.localId,
      record: decodeRow(divider, sessionKey),
    });
    expect(dividerSidecar).toEqual({
        v: 1,
        fromAgentId: 'claude',
        toAgentId: 'gemini',
        // The departure seq is part of the sidecar, not an optional extra: it is the
        // ONE input that survives the transition, and the bounded away-delta a
        // returning Agent is seeded with is derived from it. Asserting the payload
        // without it let a divider that had LOST the bound pass this gate.
        sourceCutoffSeqInclusive: expect.any(Number),
    });
    // …and it is the real head of the source, not the `?? 0` fallback: it covers
    // everything the departing Agent saw, and stops below the divider itself so
    // the divider is not inside its own bound.
    expect(dividerSidecar?.sourceCutoffSeqInclusive)
        .toBeGreaterThanOrEqual(Math.max(...messagesBefore.map((row) => row.seq)));
    expect(dividerSidecar?.sourceCutoffSeqInclusive).toBeLessThan(divider.seq);

    // Source history is preserved, not rewritten: every pre-transition row
    // survives, and the divider lands after all of them.
    for (const before of messagesBefore) {
      expect(messagesAfter.some((row) => row.seq === before.seq)).toBe(true);
    }
    expect(divider.seq).toBeGreaterThan(Math.max(...messagesBefore.map((row) => row.seq)));

    // The target Agent actually runs the admitted input in the SAME Session.
    await waitForTranscriptTextContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      sessionKey,
      marker: 'FAKE_GEMINI_OK_',
      afterSeq: divider.seq,
      timeoutMs: 180_000,
      context: 'target Agent replied after the divider',
    });

    // ---- What the TARGET actually received, and when.

    const targetPrompts = await readFakeGeminiPromptEvents(fakeGeminiLogPath);
    expect(targetPrompts.length).toBeGreaterThan(0);
    const targetPromptText = targetPrompts.map((event) => String(event.text ?? '')).join('\n');

    // The admitted input reaches the AGENT, not just the Session row.
    expect(targetPromptText).toContain(transitionText);

    // Zero-context guard — the assertion that would have caught `C3`. The target
    // must be able to see the turn the source Agent already ran in this same
    // Session. BOTH halves are required and are structural, not incidental: the
    // coordinator asks the Replay owner with `strategy: 'recent_messages'`, so
    // the brief is the transcript tail rather than a summary.
    //
    // Deliberately NOT asserted by length: the ACP prompt carries the Happier
    // system preamble, so `length > transitionText.length` holds even with a
    // zero-context target. Measured, not assumed — under the seed-removal break
    // that comparison still passed while these two failed.
    expect(targetPromptText).toContain(sourceText);
    expect(targetPromptText).toContain('FAKE_CLAUDE_OK_1');

    // The context is a PREFIX seed, not a trailing artifact: the source history
    // has to reach the Agent before the input it is context for.
    expect(targetPromptText.indexOf(sourceText)).toBeLessThan(targetPromptText.indexOf(transitionText));

    // Ordering: the source Agent is finished before the target produces its
    // first effect, so no source activity may be recorded at or after the
    // target's first prompt.
    const sourceTimestamps = readEventTimestamps(await readJsonlEvents(fakeClaudeLogPath));
    const targetPromptTimestamps = readEventTimestamps(targetPrompts);
    expect(sourceTimestamps.length).toBeGreaterThan(0);
    expect(targetPromptTimestamps.length).toBeGreaterThan(0);
    expect(Math.max(...sourceTimestamps)).toBeLessThan(Math.min(...targetPromptTimestamps));

    // The same ordering has to hold in the durable transcript the user reads.
    const messagesFinal = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    const targetReplyRow = messagesFinal.find(
      (row) => JSON.stringify(decodeRow(row, sessionKey) ?? '').includes('FAKE_GEMINI_OK_'),
    );
    expect(targetReplyRow).toBeDefined();
    expect(targetReplyRow!.seq).toBeGreaterThan(divider.seq);

    // Still exactly one divider once the target has spoken.
    expect(
      messagesFinal.filter((row) => isSessionAgentTransitionDividerLocalId(row.localId)),
    ).toHaveLength(1);

    // The exact submitted localId is admitted ONCE, not duplicated. It is
    // asserted here rather than at `accepted`: that arm reports canonical
    // PENDING-QUEUE admission, and the row reaches the transcript only when the
    // target drains the queue (observed — the row is absent the moment the RPC
    // returns). It has to land after the boundary the divider drew.
    const admitted = messagesFinal.filter((row) => row.localId === submittedLocalId);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.seq).toBeGreaterThan(divider.seq);

    // The source runtime is gone: the daemon tracks only the target child now.
    await waitFor(async () => {
      const list = await daemonControlPostJson<{ children?: Array<{ happySessionId?: string }> }>({
        port: daemon!.state.httpPort,
        path: '/list',
        controlToken: daemon!.state.controlToken,
      });
      const children = list.data.children ?? [];
      return children.filter((child) => child.happySessionId === sessionId).length <= 1;
    }, { timeoutMs: 60_000, context: 'exactly one tracked runtime for the transitioned Session' });
  }, 900_000);

  it('returns through the exact Codex app-server thread without duplicating a retried Claude-to-Codex input', async () => {
    const testDir = run.testDir(`agent-transition-codex-claude-codex-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    const machineKey = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliDataKeyAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey,
    });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const requestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
    const fakeCodexAppServerPath = await writeFakeCodexAppServerScript({
      dir: testDir,
      requestLogPath,
      // A logged resume request alone can be a prompt-transport lookalike.
      // The fake provider rejects every other native id, so a green target
      // turn proves the app-server accepted this exact returning identity.
      expectedResumeThreadId: 'thread-started',
    });
    const providerEnv = createClaudeCodexProviderEnv({
      daemonHomeDir,
      fakeClaudeLogPath,
      fakeClaudePath,
      fakeCodexAppServerPath,
      serverBaseUrl: server.baseUrl,
    });
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        ...providerEnv,
      },
      snapshotDir: resolve(join(testDir, 'daemon-cli-snapshot')),
    });

    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken: daemon.state.controlToken,
      body: {
        directory: workspaceDir,
        agent: 'codex',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        codexBackendMode: 'appServer',
        terminal: { mode: 'plain' },
        environmentVariables: providerEnv,
      },
    });
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    const sessionKey = await openSessionDataKeyWhenAvailable({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      machineKey,
    });

    // Start with a real Codex turn. Its native identity must be persisted
    // before the first cutover can capture it for the later native return.
    const codexSourceText = `AGENT_TRANSITION_CODEX_SOURCE_${randomUUID()}`;
    await enqueueUiTextMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      sessionKey,
      text: codexSourceText,
    });
    await waitFor(async () => {
      const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
      return requests.some((request) => request.method === 'turn/start'
        && readCodexTurnInputText(request.params).includes(codexSourceText));
    }, { timeoutMs: 60_000, context: 'initial Codex app-server turn receives the source input' });
    await waitFor(async () => {
      const snapshot = await fetchSessionV2(server!.baseUrl, auth.token, sessionId).catch(() => null);
      return snapshot?.active === true;
    }, { timeoutMs: 60_000, intervalMs: 250, context: 'initial Codex Session active' });

    let initialCodexThreadId: string | null = null;
    await waitFor(async () => {
      const snapshot = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
      const metadata = unwrapSerializedJsonValue(
        decryptDataKeyBase64(snapshot.metadata, sessionKey),
      );
      if (!isRecord(metadata)) return false;
      const threadId = typeof metadata.codexSessionId === 'string' ? metadata.codexSessionId : null;
      if (metadata.flavor !== 'codex' || !threadId) return false;
      initialCodexThreadId = threadId;
      return true;
    }, { timeoutMs: 60_000, context: 'initial Codex native thread identity is published' });
    if (!initialCodexThreadId) throw new Error('Initial Codex native thread identity was not published');
    expect(initialCodexThreadId).toBe('thread-started');

    const beforeFirstCutover = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
    const messagesBeforeFirstCutover = await fetchAllMessages(server.baseUrl, auth.token, sessionId);

    ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui!.isConnected(), { timeoutMs: 30_000, context: 'user socket connected for Codex return transition' });
    const machineRpc = createDataKeyRpcClient(ui, machineKey);

    const toClaudeLocalId = `transition-to-claude-${randomUUID()}`;
    const toClaudeText = `AGENT_TRANSITION_TO_CLAUDE_${randomUUID()}`;
    const toClaudeRpc = await machineRpc.call(
      `${seeded.machineId}:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      {
        v: 1,
        sessionId,
        expectedCurrentAgentId: 'codex',
        selection: { v: 1, agentId: 'claude' },
        input: { text: toClaudeText, localId: toClaudeLocalId, meta: {} },
      },
      300_000,
      { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId },
    );
    expect(toClaudeRpc.ok).toBe(true);
    if (!toClaudeRpc.ok) throw new Error(`Codex-to-Claude transition failed: ${toClaudeRpc.errorCode ?? toClaudeRpc.error}`);
    expect(SessionAgentTransitionResultV1Schema.parse(toClaudeRpc.result)).toEqual({
      type: 'accepted',
      localId: toClaudeLocalId,
    });

    const afterClaudeCutover = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
    expect(afterClaudeCutover.id).toBe(sessionId);
    expect(afterClaudeCutover.createdAt).toBe(beforeFirstCutover.createdAt);
    const claudeMetadata = unwrapSerializedJsonValue(
      decryptDataKeyBase64(afterClaudeCutover.metadata, sessionKey),
    );
    if (!isRecord(claudeMetadata)) throw new Error('Failed to decrypt Claude current metadata');
    expect(claudeMetadata.flavor).toBe('claude');

    const messagesAfterClaudeCutover = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    const toClaudeDividerLocalId = buildSessionAgentTransitionDividerLocalId(toClaudeLocalId);
    const toClaudeDivider = messagesAfterClaudeCutover.find((row) => row.localId === toClaudeDividerLocalId);
    expect(toClaudeDivider).toBeDefined();
    expect(readSessionAgentTransitionDividerFromStoredRecordV1({
      localId: toClaudeDivider!.localId,
      record: decodeRow(toClaudeDivider!, sessionKey),
    })).toEqual({
      v: 1,
      fromAgentId: 'codex',
      toAgentId: 'claude',
      sourceCutoffSeqInclusive: expect.any(Number),
    });
    expect(toClaudeDivider!.seq).toBeGreaterThanOrEqual(Math.max(...messagesBeforeFirstCutover.map((row) => row.seq)));

    await waitForFakeClaudeInvocation(
      fakeClaudeLogPath,
      (invocation) => invocation.mode === 'sdk',
      { timeoutMs: 120_000 },
    );
    const claudeTargetPrompt = await waitForFakeClaudeUserText(
      fakeClaudeLogPath,
      (text) => text.includes(codexSourceText) && text.includes(toClaudeText),
      { timeoutMs: 120_000 },
    );
    // The reverse Codex -> Claude leg is a real provider prompt with the
    // source turn as a prefix, not a Session-only transcript projection.
    expect(claudeTargetPrompt.indexOf(codexSourceText)).toBeLessThan(claudeTargetPrompt.indexOf(toClaudeText));
    await waitForTranscriptTextContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      sessionKey,
      marker: 'FAKE_CLAUDE_OK_1',
      afterSeq: toClaudeDivider!.seq,
      timeoutMs: 180_000,
      context: 'Claude target replies after the Codex-to-Claude divider',
    });

    const toCodexLocalId = `transition-to-codex-${randomUUID()}`;
    const toCodexText = `AGENT_TRANSITION_TO_CODEX_${randomUUID()}`;
    const toCodexRequest = {
      v: 1 as const,
      sessionId,
      expectedCurrentAgentId: 'claude' as const,
      selection: { v: 1 as const, agentId: 'codex' as const },
      input: { text: toCodexText, localId: toCodexLocalId, meta: {} },
    };
    const toCodexRpc = await machineRpc.call(
      `${seeded.machineId}:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      toCodexRequest,
      300_000,
      { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId },
    );
    expect(toCodexRpc.ok).toBe(true);
    if (!toCodexRpc.ok) throw new Error(`Claude-to-Codex transition failed: ${toCodexRpc.errorCode ?? toCodexRpc.error}`);
    expect(SessionAgentTransitionResultV1Schema.parse(toCodexRpc.result)).toEqual({
      type: 'accepted',
      localId: toCodexLocalId,
    });

    const afterCodexReturn = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
    expect(afterCodexReturn.id).toBe(sessionId);
    expect(afterCodexReturn.createdAt).toBe(beforeFirstCutover.createdAt);
    const codexMetadata = unwrapSerializedJsonValue(
      decryptDataKeyBase64(afterCodexReturn.metadata, sessionKey),
    );
    if (!isRecord(codexMetadata)) throw new Error('Failed to decrypt returned Codex metadata');
    expect(codexMetadata.flavor).toBe('codex');
    expect(codexMetadata.codexSessionId).toBe(initialCodexThreadId);

    const messagesAfterCodexReturn = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    const toCodexDividerLocalId = buildSessionAgentTransitionDividerLocalId(toCodexLocalId);
    const toCodexDivider = messagesAfterCodexReturn.find((row) => row.localId === toCodexDividerLocalId);
    expect(toCodexDivider).toBeDefined();
    expect(readSessionAgentTransitionDividerFromStoredRecordV1({
      localId: toCodexDivider!.localId,
      record: decodeRow(toCodexDivider!, sessionKey),
    })).toEqual({
      v: 1,
      fromAgentId: 'claude',
      toAgentId: 'codex',
      sourceCutoffSeqInclusive: expect.any(Number),
    });

    let codexRequests = await readFakeCodexAppServerRequestLog(requestLogPath);
    await waitFor(async () => {
      codexRequests = await readFakeCodexAppServerRequestLog(requestLogPath);
      const resumeIndex = codexRequests.findIndex((request) => request.method === 'thread/resume'
        && readCodexThreadId(request.params) === initialCodexThreadId);
      const targetTurnIndex = codexRequests.findIndex((request) => request.method === 'turn/start'
        && readCodexThreadId(request.params) === initialCodexThreadId
        && readCodexTurnInputText(request.params).includes(toCodexText));
      return resumeIndex >= 0 && targetTurnIndex > resumeIndex;
    }, { timeoutMs: 120_000, context: 'Codex app-server strictly resumes the recorded native thread before the return turn' });

    const returnedTurn = codexRequests.find((request) => request.method === 'turn/start'
      && readCodexThreadId(request.params) === initialCodexThreadId
      && readCodexTurnInputText(request.params).includes(toCodexText));
    expect(returnedTurn).toBeDefined();
    const returnedPrompt = readCodexTurnInputText(returnedTurn!.params);
    // This is the required real-process Claude -> Codex direction: exact
    // admitted input plus source-Claude history reaches the app-server.
    expect(returnedPrompt).toContain(toClaudeText);
    expect(returnedPrompt).toContain('FAKE_CLAUDE_OK_1');
    expect(returnedPrompt).toContain(toCodexText);
    expect(returnedPrompt.indexOf(toClaudeText)).toBeLessThan(returnedPrompt.indexOf(toCodexText));
    expect(returnedPrompt.indexOf('FAKE_CLAUDE_OK_1')).toBeLessThan(returnedPrompt.indexOf(toCodexText));

    await waitForTranscriptTextContaining({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      sessionKey,
      marker: 'reply:',
      afterSeq: toCodexDivider!.seq,
      timeoutMs: 180_000,
      context: 'returned Codex target replies after the Claude-to-Codex divider',
    });
    const messagesAfterReturnedTurn = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    expect(messagesAfterReturnedTurn.filter((row) => isSessionAgentTransitionDividerLocalId(row.localId))).toHaveLength(2);
    expect(messagesAfterReturnedTurn.filter((row) => row.localId === toCodexDividerLocalId)).toHaveLength(1);
    expect(messagesAfterReturnedTurn.filter((row) => row.localId === toCodexLocalId)).toHaveLength(1);
    const returnedReply = messagesAfterReturnedTurn.find((row) => row.seq > toCodexDivider!.seq
      && JSON.stringify(decodeRow(row, sessionKey) ?? '').includes('reply:'));
    expect(returnedReply).toBeDefined();

    // Retry the exact same request after its first response. This is the
    // retry/lost-ack-safe shape the coordinator reconciles: it must not
    // append a second divider, re-admit the localId, or start another turn.
    const targetTurnCountBeforeRetry = codexRequests.filter((request) => request.method === 'turn/start'
      && readCodexThreadId(request.params) === initialCodexThreadId
      && readCodexTurnInputText(request.params).includes(toCodexText)).length;
    const retryRpc = await machineRpc.call(
      `${seeded.machineId}:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      toCodexRequest,
      300_000,
      { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId },
    );
    expect(retryRpc.ok).toBe(true);
    if (!retryRpc.ok) throw new Error(`Claude-to-Codex retry failed: ${retryRpc.errorCode ?? retryRpc.error}`);
    expect(SessionAgentTransitionResultV1Schema.parse(retryRpc.result)).toEqual({
      type: 'accepted',
      localId: toCodexLocalId,
    });

    let stableRetryReads = 0;
    await waitFor(async () => {
      const rows = await fetchAllMessages(server!.baseUrl, auth.token, sessionId);
      const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
      const stable = rows.filter((row) => isSessionAgentTransitionDividerLocalId(row.localId)).length === 2
        && rows.filter((row) => row.localId === toCodexDividerLocalId).length === 1
        && rows.filter((row) => row.localId === toCodexLocalId).length === 1
        && requests.filter((request) => request.method === 'turn/start'
          && readCodexThreadId(request.params) === initialCodexThreadId
          && readCodexTurnInputText(request.params).includes(toCodexText)).length === targetTurnCountBeforeRetry;
      stableRetryReads = stable ? stableRetryReads + 1 : 0;
      return stableRetryReads >= 3;
    }, { timeoutMs: 30_000, intervalMs: 250, context: 'retry leaves one divider, one input, and one returned Codex turn' });
  }, 900_000);
});
