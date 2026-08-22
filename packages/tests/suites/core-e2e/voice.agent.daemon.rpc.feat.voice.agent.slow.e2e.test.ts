import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  deriveVoiceAgentTurnLocalId,
  ExecutionRunActionResponseSchema,
  ExecutionRunEnsureResponseSchema,
  ExecutionRunEnsureOrStartResponseSchema,
  ExecutionRunStopResponseSchema,
  ExecutionRunTurnStreamCancelResponseSchema,
  ExecutionRunTurnStreamReadResponseSchema,
  ExecutionRunTurnStreamStartResponseSchema,
} from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { replaceTestDaemonWithoutStoppingSessions, startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { countDuplicateLocalIds, fetchAllMessages, fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { callLegacyEncryptedSessionRpc } from '../../src/testkit/sessionRpc';
import { ensureCliSharedDepsBuilt } from '../../src/testkit/process/cliDist';
import { extractAssistantCandidateTextsFromDecryptedRecord } from '../../src/testkit/providers/scenarios/sessionRuntime';

const run = createRunDirs({ runLabel: 'core' });
const DAEMON_STARTUP_TIMEOUT_MS = 120_000;

type DecryptedSessionMessage = Readonly<{
  role?: unknown;
  content?: unknown;
  meta?: unknown;
  localId?: unknown;
}>;

type DecryptedSessionMessagePair = Readonly<{
  row: Awaited<ReturnType<typeof fetchAllMessages>>[number];
  message: DecryptedSessionMessage;
}>;

type VoiceTurnPayload = Readonly<{
  v?: unknown;
  epoch?: unknown;
  role?: unknown;
  voiceAgentId?: unknown;
  ts?: unknown;
}>;

type VoiceAgentRunMetadata = Readonly<{
  v?: unknown;
  runId?: unknown;
  backendId?: unknown;
  backendTarget?: unknown;
  resumeHandle?: unknown;
  updatedAtMs?: unknown;
  transcriptContractVersion?: unknown;
  welcomedEpoch?: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decryptSessionMessages(rows: Awaited<ReturnType<typeof fetchAllMessages>>, secret: Uint8Array): DecryptedSessionMessage[] {
  return rows
    .map((row) => row.content.c)
    .map((ciphertext) => decryptLegacyBase64(ciphertext, secret))
    .filter((value): value is DecryptedSessionMessage => isRecord(value));
}

function decryptSessionMessagePairs(
  rows: Awaited<ReturnType<typeof fetchAllMessages>>,
  secret: Uint8Array,
): DecryptedSessionMessagePair[] {
  return rows.flatMap((row) => {
    const decrypted = decryptLegacyBase64(row.content.c, secret);
    if (!isRecord(decrypted)) return [];
    return [{ row, message: decrypted as DecryptedSessionMessage }];
  });
}

function extractUserTextContent(message: DecryptedSessionMessage): string | null {
  const content = isRecord(message.content) ? message.content : null;
  if (content?.type !== 'text') return null;
  return typeof content.text === 'string' ? content.text : null;
}

function extractAssistantTextContent(message: DecryptedSessionMessage): string | null {
  const candidates = extractAssistantCandidateTextsFromDecryptedRecord(message as Record<string, unknown>);
  const trimmed = candidates
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return trimmed.at(-1) ?? null;
}

function extractVoiceTurnPayload(message: DecryptedSessionMessage): VoiceTurnPayload | null {
  const meta = isRecord(message.meta) ? message.meta : null;
  const happier = isRecord(meta?.happier) ? meta.happier : null;
  if (happier?.kind !== 'voice_agent_turn.v1') return null;
  const payload = happier.payload;
  return isRecord(payload) ? (payload as VoiceTurnPayload) : null;
}

function deriveLocalIdFromVoiceTurnPayload(payload: VoiceTurnPayload): string {
  if (payload.role !== 'assistant' && payload.role !== 'user') {
    throw new Error(`Unexpected voice turn role: ${String(payload.role)}`);
  }
  return deriveVoiceAgentTurnLocalId({
    epoch: Number(payload.epoch),
    role: payload.role,
    ts: Number(payload.ts),
    voiceAgentId: String(payload.voiceAgentId),
  });
}

function extractVoiceAgentRunMetadata(value: unknown): VoiceAgentRunMetadata | null {
  if (!isRecord(value)) return null;
  const raw = value.voiceAgentRunV1;
  return isRecord(raw) ? (raw as VoiceAgentRunMetadata) : null;
}

async function waitForVoiceAgentRunMetadata(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  assert: (metadata: VoiceAgentRunMetadata | null) => boolean;
  context: string;
}>): Promise<VoiceAgentRunMetadata | null> {
  let matched: VoiceAgentRunMetadata | null = null;
  await waitFor(async () => {
    const snapshot = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
    const metadata = extractVoiceAgentRunMetadata(decryptLegacyBase64(snapshot.metadata, params.secret));
    if (!params.assert(metadata)) {
      return false;
    }
    matched = metadata;
    return true;
  }, {
    timeoutMs: 30_000,
    context: params.context,
  });
  return matched;
}

async function waitForVoiceTranscriptPair(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  expectedUserText: string;
  expectedAssistantText: string;
}>): Promise<DecryptedSessionMessage[]> {
  let matchedMessages: DecryptedSessionMessage[] = [];
  await waitFor(async () => {
    const rows = await fetchAllMessages(params.baseUrl, params.token, params.sessionId);
    const decrypted = decryptSessionMessages(rows, params.secret);
    const voiceTurnMessages = decrypted.filter((message) => extractVoiceTurnPayload(message) !== null);
    const userMatches = voiceTurnMessages.filter((message) => {
      const payload = extractVoiceTurnPayload(message);
      return payload?.role === 'user' && extractUserTextContent(message) === params.expectedUserText;
    });
    const assistantMatches = voiceTurnMessages.filter((message) => {
      const payload = extractVoiceTurnPayload(message);
      return payload?.role === 'assistant' && extractAssistantTextContent(message) === params.expectedAssistantText;
    });
    if (userMatches.length !== 1 || assistantMatches.length !== 1) {
      return false;
    }
    matchedMessages = voiceTurnMessages;
    return true;
  }, {
    timeoutMs: 30_000,
    context: `voice transcript pair for ${params.expectedUserText}`,
  });
  return matchedMessages;
}

async function waitForVoiceTurnRows(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  expectedCount: number;
}>): Promise<DecryptedSessionMessage[]> {
  let matchedMessages: DecryptedSessionMessage[] = [];
  await waitFor(async () => {
    const rows = await fetchAllMessages(params.baseUrl, params.token, params.sessionId);
    const decrypted = decryptSessionMessages(rows, params.secret);
    const voiceTurnMessages = decrypted.filter((message) => extractVoiceTurnPayload(message) !== null);
    if (voiceTurnMessages.length !== params.expectedCount) {
      return false;
    }
    matchedMessages = voiceTurnMessages;
    return true;
  }, {
    timeoutMs: 30_000,
    context: `voice turn row count ${params.expectedCount}`,
  });
  return matchedMessages;
}

describe('core e2e: voice agent daemon sessionRPC (execution runs)', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let retiredDaemon: StartedDaemon | null = null;

  afterEach(async () => {
    const cleanupErrors: Error[] = [];
    await daemon?.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    daemon = null;
    await retiredDaemon?.proc.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    retiredDaemon = null;
    await server?.stop().catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    });
    server = null;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Voice daemon replacement teardown failed');
  });

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await retiredDaemon?.proc.stop().catch(() => {});
    retiredDaemon = null;
    await server?.stop();
    server = null;
  });

	  it('supports start/sendTurn/commit/stop without persisting transcript until explicit commit', async () => {
	    const testDir = run.testDir('voice-agent-daemon-rpc');
	    server = await startServerLight({ testDir });
	    const serverBaseUrl = server.baseUrl;
	    const auth = await createTestAuth(serverBaseUrl);

	    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
	    const cliSnapshotDir = resolve(join(testDir, 'cli-dist'));
	    const workspaceDir = resolve(join(testDir, 'workspace'));
	    await mkdir(daemonHomeDir, { recursive: true });
	    await mkdir(workspaceDir, { recursive: true });

    const secret = auth.accountSigningSeed;
    await seedCliAuthForTestAccount({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, auth, mode: 'legacy' });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
	    const daemonEnv: NodeJS.ProcessEnv = {
	      ...process.env,
	      CI: '1',
	      HAPPIER_VARIANT: 'dev',
	      HAPPIER_DISABLE_CAFFEINATE: '1',
	      HAPPIER_HOME_DIR: daemonHomeDir,
	      HAPPIER_SERVER_URL: serverBaseUrl,
	      HAPPIER_WEBAPP_URL: serverBaseUrl,
	      HAPPIER_CLAUDE_PATH: fakeClaudePath,
	      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
	      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
	      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1',
	    };

	    await ensureCliSharedDepsBuilt({ testDir, env: daemonEnv }, { skipSourceFreshnessCheck: true });

	    daemon = await startTestDaemon({
	      testDir,
	      happyHomeDir: daemonHomeDir,
	      env: daemonEnv,
	      snapshotDir: cliSnapshotDir,
	      startupTimeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
	      cleanupDescendantsOnExit: false,
	    });
	    await rm(resolve(cliSnapshotDir, 'dist', 'index.mjs'), { force: true });
	    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        terminal: { mode: 'plain' },
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
        },
      },
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing sessionId from daemon spawn-session');

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

    const baselineMessages = await fetchAllMessages(serverBaseUrl, auth.token, sessionId);

    const start = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      req: {
        runId: null,
        resume: true,
        start: {
          intent: 'voice_agent',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
          chatModelId: 'voice-chat-model',
          commitModelId: 'voice-commit-model',
          idleTtlSeconds: 300,
          initialContext: 'voice agent e2e initial context',
          verbosity: 'short',
        },
      },
      secret,
      schema: ExecutionRunEnsureOrStartResponseSchema,
      timeoutMs: 45_000,
    });

    expect(typeof start.runId).toBe('string');
    expect(start.created).toBe(true);

	    const sendTurn = async (userText: string, opts?: Readonly<{ resume?: boolean }>): Promise<string> => {
	      const streamStart = await callLegacyEncryptedSessionRpc({
	        ui,
	        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
        req: { runId: start.runId, message: userText, ...(opts?.resume === true ? { resume: true } : {}) },
        secret,
        schema: ExecutionRunTurnStreamStartResponseSchema,
	        timeoutMs: 45_000,
	      });

	      let streamCursor = 0;
	      let streamDone = false;
	      let streamedAssistantText = '';
	      await waitFor(async () => {
	        const streamRead = await callLegacyEncryptedSessionRpc({
	          ui,
	          sessionId,
	          method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
	          req: { runId: start.runId, streamId: streamStart.streamId, cursor: streamCursor, maxEvents: 64 },
	          secret,
	          schema: ExecutionRunTurnStreamReadResponseSchema,
	          timeoutMs: 45_000,
	        });
	        streamCursor = streamRead.nextCursor;
	        for (const event of streamRead.events as any[]) {
	          if (event.t === 'delta') streamedAssistantText += String(event.textDelta ?? '');
	          if (event.t === 'done') streamedAssistantText = String(event.assistantText ?? streamedAssistantText);
	        }
	        streamDone = streamRead.done;
	        return streamDone;
	      }, {
	        timeoutMs: 45_000,
	        intervalMs: 250,
	        context: `voice agent stream done for ${userText}`,
	      });
	      expect(streamDone).toBe(true);
	      return streamedAssistantText;
	    };

    expect(await sendTurn('turn-1')).toContain('FAKE_CLAUDE_OK_1');
    expect(await sendTurn('turn-2')).toContain('FAKE_CLAUDE_OK_2');
    expect(await sendTurn('turn-stream-1')).toContain('FAKE_CLAUDE_OK_3');

    const streamCancelStart = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
      req: { runId: start.runId, message: 'turn-stream-cancel' },
      secret,
      schema: ExecutionRunTurnStreamStartResponseSchema,
      timeoutMs: 45_000,
    });
    const streamCancelled = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
      req: { runId: start.runId, streamId: streamCancelStart.streamId },
      secret,
      schema: ExecutionRunTurnStreamCancelResponseSchema,
      timeoutMs: 45_000,
    });
    expect(streamCancelled.ok).toBe(true);

    const commit = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
      req: { runId: start.runId, actionId: 'voice_agent.commit', input: { maxChars: 1200 } },
      secret,
      schema: ExecutionRunActionResponseSchema,
      timeoutMs: 45_000,
    });
    const committedTranscriptText = String((commit as any).result?.commitText ?? '');
    expect(committedTranscriptText).toContain('FAKE_CLAUDE_OK_1');

    const stop = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      req: { runId: start.runId },
      secret,
      schema: ExecutionRunStopResponseSchema,
      timeoutMs: 45_000,
    });
    expect(stop.ok).toBe(true);

    // Ensure daemon voice agent does not write to the transcript by itself.
    const afterRpcMessages = await fetchAllMessages(serverBaseUrl, auth.token, sessionId);
    expect(afterRpcMessages.length).toBe(baselineMessages.length);

    expect(await sendTurn('turn-after-resume', { resume: true })).toContain('FAKE_CLAUDE_OK_');

    const stop2 = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      req: { runId: start.runId },
      secret,
      schema: ExecutionRunStopResponseSchema,
      timeoutMs: 45_000,
    });
    expect(stop2.ok).toBe(true);

    const ensuredAfterStop = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
      req: { runId: start.runId, resume: true },
      secret,
      schema: ExecutionRunEnsureResponseSchema,
      timeoutMs: 45_000,
    });
    expect(ensuredAfterStop.ok).toBe(true);

    // Assert chat+commit model selection was respected (separate Claude invocations).
    await waitForFakeClaudeInvocation(fakeLogPath, (i) => i.mode === 'sdk' && i.argv.includes('--model') && i.argv.includes('voice-chat-model'), { timeoutMs: 60_000 });
    await waitForFakeClaudeInvocation(fakeLogPath, (i) => i.mode === 'sdk' && i.argv.includes('--model') && i.argv.includes('voice-commit-model'), { timeoutMs: 60_000 });

    // Simulate UI confirmation by persisting the committed message into the transcript.
    const localId = `voice-commit-${randomUUID()}`;
    const msg = {
      role: 'user',
      content: { type: 'text', text: committedTranscriptText },
      localId,
      meta: { source: 'ui', sentFrom: 'e2e', feature: 'voice-agent' },
    };
    const ciphertext = encryptLegacyBase64(msg, secret);
    const writeRes = await fetch(`${serverBaseUrl}/v2/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ciphertext, localId }),
    });
    expect(writeRes.ok).toBe(true);

    await waitFor(
      async () => {
        const msgs = await fetchAllMessages(serverBaseUrl, auth.token, sessionId);
        return msgs.some((m) => m.localId === localId);
      },
      { timeoutMs: 30_000 },
    );

    const finalMessages = await fetchAllMessages(serverBaseUrl, auth.token, sessionId);
    expect(finalMessages.length).toBeGreaterThan(0);
    expect(finalMessages.filter((message) => message.localId === localId)).toHaveLength(1);
    expect(countDuplicateLocalIds(finalMessages)).toBe(0);

    const finalDecrypted = decryptSessionMessages(finalMessages, secret);
    const committedRows = finalDecrypted.filter((message) => extractUserTextContent(message) === committedTranscriptText);
    expect(committedRows).toHaveLength(1);
    expect(finalDecrypted.filter((message) => extractVoiceTurnPayload(message) !== null)).toHaveLength(0);

    ui.disconnect();
    ui.close();
  }, 300_000);

  it('keeps persistent transcript parity across resume and reconciles deterministic voice turn ids without duplicates', async () => {
    const testDir = run.testDir('voice-agent-daemon-rpc-persistent-transcript-resume');
    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const cliSnapshotDir = resolve(join(testDir, 'cli-dist'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = auth.accountSigningSeed;
    await seedCliAuthForTestAccount({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, auth, mode: 'legacy' });

    const fakeClaudePath = fakeClaudeFixturePath();
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1',
    };

    await ensureCliSharedDepsBuilt({ testDir, env: daemonEnv }, { skipSourceFreshnessCheck: true });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      snapshotDir: cliSnapshotDir,
      startupTimeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
    });
    await rm(resolve(cliSnapshotDir, 'dist', 'index.mjs'), { force: true });
    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        terminal: { mode: 'plain' },
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
        },
      },
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing sessionId from daemon spawn-session');

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

    const start = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      req: {
        runId: null,
        resume: true,
        start: {
          intent: 'voice_agent',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
          chatModelId: 'voice-chat-model',
          commitModelId: 'voice-chat-model',
          idleTtlSeconds: 300,
          initialContext: 'voice transcript parity e2e',
          verbosity: 'short',
          transcript: {
            persistenceMode: 'persistent',
            epoch: 7,
          },
        },
      },
      secret,
      schema: ExecutionRunEnsureOrStartResponseSchema,
      timeoutMs: 45_000,
    });
    expect(typeof start.runId).toBe('string');
    if (typeof start.runId !== 'string' || start.runId.length === 0) {
      throw new Error('Missing runId from EXECUTION_RUN_ENSURE_OR_START');
    }
    const startRunId = start.runId;

	    const sendTurn = async (message: string, resume = false): Promise<string> => {
	      const streamStart = await callLegacyEncryptedSessionRpc({
	        ui,
	        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
        req: { runId: start.runId, message, ...(resume ? { resume: true } : {}) },
        secret,
        schema: ExecutionRunTurnStreamStartResponseSchema,
	        timeoutMs: 45_000,
	      });

	      let streamCursor = 0;
	      let streamDone = false;
	      let streamedAssistantText = '';
	      await waitFor(async () => {
	        const streamRead = await callLegacyEncryptedSessionRpc({
	          ui,
	          sessionId,
	          method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
	          req: { runId: start.runId, streamId: streamStart.streamId, cursor: streamCursor, maxEvents: 64 },
	          secret,
	          schema: ExecutionRunTurnStreamReadResponseSchema,
	          timeoutMs: 45_000,
	        });
	        streamCursor = streamRead.nextCursor;
	        for (const event of streamRead.events as any[]) {
	          if (event.t === 'delta') streamedAssistantText += String(event.textDelta ?? '');
	          if (event.t === 'done') streamedAssistantText = String(event.assistantText ?? streamedAssistantText);
	        }
	        streamDone = streamRead.done;
	        return streamDone;
	      }, {
	        timeoutMs: 45_000,
	        intervalMs: 250,
	        context: `voice agent stream done for ${message}`,
	      });
	      expect(streamDone).toBe(true);
	      return streamedAssistantText;
	    };

    const firstAssistantText = await sendTurn('persistent-turn-1');
    const firstVoiceTranscript = await waitForVoiceTranscriptPair({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      expectedUserText: 'persistent-turn-1',
      expectedAssistantText: firstAssistantText,
    });
    const firstTurnRows = firstVoiceTranscript.filter((message) => {
      const payload = extractVoiceTurnPayload(message);
      return payload?.epoch === 7;
    });
    expect(firstTurnRows).toHaveLength(2);
    const firstVoiceAgentIds = new Set<string>();
    for (const message of firstTurnRows) {
      const payload = extractVoiceTurnPayload(message);
      expect(payload?.v).toBe(1);
      expect(payload?.epoch).toBe(7);
      expect(typeof payload?.voiceAgentId).toBe('string');
      expect(String(payload?.voiceAgentId ?? '')).not.toHaveLength(0);
      firstVoiceAgentIds.add(String(payload?.voiceAgentId));
    }
    expect(firstVoiceAgentIds.size).toBe(1);
    expect(Array.from(firstVoiceAgentIds)[0]).toBe(start.runId);

    const rowsAfterFirstTurn = decryptSessionMessagePairs(
      await fetchAllMessages(serverBaseUrl, auth.token, sessionId),
      secret,
    ).filter(({ message }) => extractVoiceTurnPayload(message) !== null);
    expect(rowsAfterFirstTurn).toHaveLength(2);
    expect(countDuplicateLocalIds(await fetchAllMessages(serverBaseUrl, auth.token, sessionId))).toBe(0);
    const firstTurnLocalIds = new Set<string>();
    for (const { row, message } of rowsAfterFirstTurn) {
      const payload = extractVoiceTurnPayload(message);
      expect(payload).not.toBeNull();
      if (!payload) continue;
      const deterministicLocalId = deriveLocalIdFromVoiceTurnPayload(payload);
      expect(row.localId).toBe(deterministicLocalId);
      firstTurnLocalIds.add(deterministicLocalId);
    }
    expect(firstTurnLocalIds.size).toBe(2);

    const stop = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      req: { runId: start.runId },
      secret,
      schema: ExecutionRunStopResponseSchema,
      timeoutMs: 45_000,
    });
    expect(stop.ok).toBe(true);

    const ensuredAfterReattach = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
      req: { runId: start.runId, resume: true },
      secret,
      schema: ExecutionRunEnsureResponseSchema,
      timeoutMs: 45_000,
    });
    expect(ensuredAfterReattach.ok).toBe(true);

    const secondAssistantText = await sendTurn('persistent-turn-2', true);
    const rowsAfterResume = await waitForVoiceTurnRows({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      expectedCount: 4,
    });

    const voiceTurnRows = decryptSessionMessagePairs(
      await fetchAllMessages(serverBaseUrl, auth.token, sessionId),
      secret,
    ).filter(({ message }) => extractVoiceTurnPayload(message) !== null);
    expect(voiceTurnRows).toHaveLength(4);
    expect(countDuplicateLocalIds(await fetchAllMessages(serverBaseUrl, auth.token, sessionId))).toBe(0);
    const userTexts = voiceTurnRows
      .filter(({ message }) => extractVoiceTurnPayload(message)?.role === 'user')
      .map(({ message }) => extractUserTextContent(message));
    const assistantTexts = voiceTurnRows
      .filter(({ message }) => extractVoiceTurnPayload(message)?.role === 'assistant')
      .map(({ message }) => extractAssistantTextContent(message));
    expect(userTexts).toEqual(['persistent-turn-1', 'persistent-turn-2']);
    expect(assistantTexts).toEqual([firstAssistantText, secondAssistantText]);
    const rowsByVoiceAgentId = new Map<string, VoiceTurnPayload[]>();
    for (const { row, message } of voiceTurnRows) {
      const payload = extractVoiceTurnPayload(message);
      if (typeof payload?.voiceAgentId !== 'string' || payload.voiceAgentId.length === 0) {
        continue;
      }
      expect(row.localId).toBe(deriveLocalIdFromVoiceTurnPayload(payload));
      const bucket = rowsByVoiceAgentId.get(payload.voiceAgentId) ?? [];
      bucket.push(payload);
      rowsByVoiceAgentId.set(payload.voiceAgentId, bucket);
    }
    expect(rowsByVoiceAgentId.size).toBe(1);
    expect(rowsByVoiceAgentId.get(startRunId)?.length).toBe(4);
    expect(
      Array.from(rowsByVoiceAgentId.values()).every(
        (bucket) => new Set(bucket.map((payload) => payload.role)).size === 2,
      ),
    ).toBe(true);
    expect(rowsByVoiceAgentId.has(startRunId)).toBe(true);

    ui.disconnect();
    ui.close();
  }, 300_000);

	  it('persists daemon voice run metadata and welcomedEpoch across stop/ensure resume and daemon replacement for persistent transcripts', async () => {
	    const testDir = run.testDir('voice-agent-daemon-rpc-run-metadata-resume');
	    server = await startServerLight({ testDir });
	    const serverBaseUrl = server.baseUrl;
	    const auth = await createTestAuth(serverBaseUrl);

	    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
	    const cliSnapshotDir = resolve(join(testDir, 'cli-dist'));
	    const workspaceDir = resolve(join(testDir, 'workspace'));
	    await mkdir(daemonHomeDir, { recursive: true });
	    await mkdir(workspaceDir, { recursive: true });

    const secret = auth.accountSigningSeed;
    await seedCliAuthForTestAccount({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, auth, mode: 'legacy' });

    const fakeClaudePath = fakeClaudeFixturePath();
	    const daemonEnv: NodeJS.ProcessEnv = {
	      ...process.env,
	      CI: '1',
	      HAPPIER_VARIANT: 'dev',
	      HAPPIER_DISABLE_CAFFEINATE: '1',
	      HAPPIER_HOME_DIR: daemonHomeDir,
	      HAPPIER_SERVER_URL: serverBaseUrl,
	      HAPPIER_WEBAPP_URL: serverBaseUrl,
	      HAPPIER_CLAUDE_PATH: fakeClaudePath,
	      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
	      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
	      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1',
	    };

	    await ensureCliSharedDepsBuilt({ testDir, env: daemonEnv }, { skipSourceFreshnessCheck: true });

	    daemon = await startTestDaemon({
	      testDir,
	      happyHomeDir: daemonHomeDir,
	      env: daemonEnv,
	      snapshotDir: cliSnapshotDir,
	      startupTimeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
	      cleanupDescendantsOnExit: false,
	    });
	    await rm(resolve(cliSnapshotDir, 'dist', 'index.mjs'), { force: true });
	    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        terminal: { mode: 'plain' },
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
        },
      },
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing sessionId from daemon spawn-session');

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

    const start = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      req: {
        runId: null,
        resume: true,
        start: {
          intent: 'voice_agent',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          permissionMode: 'read_only',
          retentionPolicy: 'resumable',
          runClass: 'long_lived',
          ioMode: 'streaming',
          chatModelId: 'voice-chat-model',
          commitModelId: 'voice-chat-model',
          idleTtlSeconds: 300,
          initialContext: 'voice run metadata parity e2e',
          verbosity: 'short',
          transcript: {
            persistenceMode: 'persistent',
            epoch: 11,
          },
        },
      },
      secret,
      schema: ExecutionRunEnsureOrStartResponseSchema,
      timeoutMs: 45_000,
    });

    expect(start.ok).toBe(true);
    const metadataAfterStart = await waitForVoiceAgentRunMetadata({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      context: 'voiceAgentRunV1 persisted after daemon voice run start',
      assert: (metadata) =>
        metadata?.v === 1
        && metadata.runId === start.runId
        && metadata.backendId === 'claude'
        && metadata.transcriptContractVersion === 2,
    });

    expect(metadataAfterStart?.resumeHandle).toBeTruthy();

    const welcome = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
      req: { runId: start.runId, actionId: 'voice_agent.welcome' },
      secret,
      schema: ExecutionRunActionResponseSchema,
      timeoutMs: 45_000,
    });
    expect(welcome.ok).toBe(true);
    expect(String((welcome as any).result?.assistantText ?? '')).toContain('FAKE_CLAUDE_OK_');

    const metadataAfterWelcome = await waitForVoiceAgentRunMetadata({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      context: 'voiceAgentRunV1 welcomedEpoch persisted after daemon welcome',
      assert: (metadata) =>
        metadata?.runId === start.runId
        && metadata?.transcriptContractVersion === 2
        && metadata?.welcomedEpoch === 11,
    });

    const stop = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      req: { runId: start.runId },
      secret,
      schema: ExecutionRunStopResponseSchema,
      timeoutMs: 45_000,
    });
    expect(stop.ok).toBe(true);

    const ensuredAfterStop = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
      req: { runId: start.runId, resume: true },
      secret,
      schema: ExecutionRunEnsureResponseSchema,
      timeoutMs: 45_000,
    });
    expect(ensuredAfterStop.ok).toBe(true);

    const metadataAfterEnsure = await waitForVoiceAgentRunMetadata({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      context: 'voiceAgentRunV1 preserved after daemon ensure resume',
      assert: (metadata) =>
        metadata?.runId === start.runId
        && metadata?.backendId === 'claude'
        && metadata?.transcriptContractVersion === 2
        && metadata?.welcomedEpoch === 11,
    });

    expect(metadataAfterEnsure?.resumeHandle).toEqual(metadataAfterWelcome?.resumeHandle ?? null);
    const listedBeforeReplacement = await daemonControlPostJson<{
      children?: Array<{ happySessionId?: string; pid?: number; startedBy?: string }>;
    }>({
      port: daemon.state.httpPort,
      path: '/list',
      controlToken,
    });
    expect(listedBeforeReplacement.status).toBe(200);
    const originalDaemonSession = listedBeforeReplacement.data.children?.find((child) => child.happySessionId === sessionId);
    const originalTrackedPid = originalDaemonSession?.pid;
    if (typeof originalTrackedPid !== 'number') {
      throw new Error('Expected daemon /list to expose the original tracked session PID');
    }

    const originalDaemonPid = daemon.state.pid;
    const replacedDaemonState = await replaceTestDaemonWithoutStoppingSessions({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      originalDaemon: daemon,
      stdoutPath: resolve(testDir, 'daemon.voice-agent-replace.stdout.log'),
      stderrPath: resolve(testDir, 'daemon.voice-agent-replace.stderr.log'),
    });
    retiredDaemon = daemon;
    daemon = replacedDaemonState;
    expect(replacedDaemonState.state.pid).not.toBe(originalDaemonPid);
    await waitFor(async () => {
      const listed = await daemonControlPostJson<{
        children?: Array<{ happySessionId?: string; pid?: number; startedBy?: string }>;
      }>({
        port: replacedDaemonState.state.httpPort,
        path: '/list',
        controlToken: replacedDaemonState.state.controlToken,
      });
      expect(listed.status).toBe(200);
      expect(listed.data.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            happySessionId: sessionId,
            startedBy: 'daemon',
            pid: originalTrackedPid,
          }),
        ]),
      );
      return true;
    }, {
      timeoutMs: 30_000,
      context: 'voice-agent daemon session reattached after daemon replacement',
    });

    const ensuredAfterReplacement = await callLegacyEncryptedSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
      req: { runId: start.runId, resume: true },
      secret,
      schema: ExecutionRunEnsureResponseSchema,
      timeoutMs: 45_000,
    });
    expect(ensuredAfterReplacement.ok).toBe(true);

    const metadataAfterReplacementEnsure = await waitForVoiceAgentRunMetadata({
      baseUrl: serverBaseUrl,
      token: auth.token,
      sessionId,
      secret,
      context: 'voiceAgentRunV1 preserved after daemon replacement ensure',
      assert: (metadata) =>
        metadata?.runId === start.runId
        && metadata?.backendId === 'claude'
        && metadata?.transcriptContractVersion === 2
        && metadata?.welcomedEpoch === 11,
    });

    expect(metadataAfterReplacementEnsure?.resumeHandle).toEqual(metadataAfterWelcome?.resumeHandle ?? null);
    ui.disconnect();
    ui.close();
  }, 300_000);
});
