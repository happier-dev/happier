import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
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
import { encryptLegacyBase64, decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { fetchAllMessages } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'core' });

type RpcAck = { ok: boolean; result?: string; error?: string; errorCode?: string };
type SafeParseResult<T> = { success: true; data: T } | { success: false };
type ParseSchema<T> = { safeParse: (input: unknown) => SafeParseResult<T> };

async function callSessionRpc<TReq, TRes>(params: {
  ui: ReturnType<typeof createUserScopedSocketCollector>;
  sessionId: string;
  method: string;
  req: TReq;
  secret: Uint8Array;
  schema: ParseSchema<TRes>;
  timeoutMs?: number;
}): Promise<TRes> {
  let out: TRes | null = null;

  const encryptedParams = encryptLegacyBase64(params.req, params.secret);

  await waitFor(
    async () => {
      const res = await params.ui.rpcCall<RpcAck>(`${params.sessionId}:${params.method}`, encryptedParams);
      if (!res || res.ok !== true || typeof res.result !== 'string') return false;
      const decrypted = decryptLegacyBase64(res.result, params.secret);
      const parsed = params.schema.safeParse(decrypted);
      if (!parsed.success) return false;
      out = parsed.data;
      return true;
    },
    { timeoutMs: params.timeoutMs ?? 25_000 },
  );

  if (!out) throw new Error(`RPC call did not return a valid response: ${params.method}`);
  return out;
}

describe('core e2e: voice agent daemon sessionRPC (execution runs)', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('supports start/sendTurn/commit/stop without persisting transcript until explicit commit', async () => {
    const testDir = run.testDir('voice-agent-daemon-rpc');
    server = await startServerLight({ testDir });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: serverBaseUrl,
        HAPPIER_WEBAPP_URL: serverBaseUrl,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
      },
    });
    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
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

    const start = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
      req: {
        runId: null,
        resume: true,
        start: {
          intent: 'voice_agent',
          backendId: 'claude',
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
      const streamStart = await callSessionRpc({
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
      for (let i = 0; i < 16 && !streamDone; i += 1) {
        const streamRead = await callSessionRpc({
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
        if (!streamDone) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(streamDone).toBe(true);
      return streamedAssistantText;
    };

    expect(await sendTurn('turn-1')).toContain('FAKE_CLAUDE_OK_1');
    expect(await sendTurn('turn-2')).toContain('FAKE_CLAUDE_OK_2');
    expect(await sendTurn('turn-stream-1')).toContain('FAKE_CLAUDE_OK_3');

    const streamCancelStart = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
      req: { runId: start.runId, message: 'turn-stream-cancel' },
      secret,
      schema: ExecutionRunTurnStreamStartResponseSchema,
      timeoutMs: 45_000,
    });
    const streamCancelled = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
      req: { runId: start.runId, streamId: streamCancelStart.streamId },
      secret,
      schema: ExecutionRunTurnStreamCancelResponseSchema,
      timeoutMs: 45_000,
    });
    expect(streamCancelled.ok).toBe(true);

    const commit = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
      req: { runId: start.runId, actionId: 'voice_agent.commit', input: { maxChars: 1200 } },
      secret,
      schema: ExecutionRunActionResponseSchema,
      timeoutMs: 45_000,
    });
    expect(String((commit as any).result?.commitText ?? '')).toContain('FAKE_CLAUDE_OK_1');

    const stop = await callSessionRpc({
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

    const stop2 = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      req: { runId: start.runId },
      secret,
      schema: ExecutionRunStopResponseSchema,
      timeoutMs: 45_000,
    });
    expect(stop2.ok).toBe(true);

    const ensured = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
      req: { runId: start.runId, resume: true },
      secret,
      schema: ExecutionRunEnsureResponseSchema,
      timeoutMs: 45_000,
    });
    expect(ensured.ok).toBe(true);

    // Assert chat+commit model selection was respected (separate Claude invocations).
    await waitForFakeClaudeInvocation(fakeLogPath, (i) => i.mode === 'sdk' && i.argv.includes('--model') && i.argv.includes('voice-chat-model'), { timeoutMs: 60_000 });
    await waitForFakeClaudeInvocation(fakeLogPath, (i) => i.mode === 'sdk' && i.argv.includes('--model') && i.argv.includes('voice-commit-model'), { timeoutMs: 60_000 });

    // Simulate UI confirmation by persisting the committed message into the transcript.
    const localId = `voice-commit-${randomUUID()}`;
    const msg = {
      role: 'user',
	      content: { type: 'text', text: commit.commitText },
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

    ui.disconnect();
    ui.close();
  }, 300_000);
});
