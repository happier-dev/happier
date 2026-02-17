import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  ExecutionRunGetResponseSchema,
  ExecutionRunStartResponseSchema,
  ExecutionRunStopResponseSchema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { encryptLegacyBase64, decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';

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
    { timeoutMs: params.timeoutMs ?? 40_000 },
  );

  if (!out) throw new Error(`RPC call did not return a valid response: ${params.method}`);
  return out;
}

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: execution runs (resumable) enforce backend resume support', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  }, 60_000);

  it('fails closed when backend does not support loadSession for resumable runs', async () => {
    const testDir = run.testDir(`execution-runs-resumable-${randomUUID()}`);
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
    const fakeClaudeLog = resolve(join(testDir, 'fake-claude.jsonl'));

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
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
      },
    });
    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

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
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
        },
      },
    });
    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing sessionId from daemon spawn-session');

    const started = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_START,
      req: {
        intent: 'delegate',
        backendId: 'claude',
        instructions: 'Start a long-lived resumable run.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
      },
      secret,
      schema: ExecutionRunStartResponseSchema,
      timeoutMs: 40_000,
    });

    const stopped = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      req: { runId: started.runId },
      secret,
      schema: ExecutionRunStopResponseSchema,
      timeoutMs: 40_000,
    });
    expect(stopped.ok).toBe(true);

    const sendNoResumeAck = await ui.rpcCall<RpcAck>(
      `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_SEND}`,
      encryptLegacyBase64({ runId: started.runId, message: 'hello again' }, secret),
    );
    expect(sendNoResumeAck?.ok).toBe(true);
    expect(typeof sendNoResumeAck?.result).toBe('string');
    const sendNoResumeResult = decryptLegacyBase64(String(sendNoResumeAck?.result ?? ''), secret) as any;
    expect(sendNoResumeResult?.ok).toBe(false);
    expect(sendNoResumeResult?.errorCode).toBe('execution_run_not_allowed');

    const resumeAck = await ui.rpcCall<RpcAck>(
      `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_SEND}`,
      encryptLegacyBase64({ runId: started.runId, message: 'hello again', resume: true }, secret),
    );
    expect(resumeAck?.ok).toBe(true);
    expect(typeof resumeAck?.result).toBe('string');
    const resumeResult = decryptLegacyBase64(String(resumeAck?.result ?? ''), secret) as any;
    expect(resumeResult?.ok).toBe(false);
    expect(resumeResult?.errorCode).toBe('execution_run_not_allowed');

    const got = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
      req: { runId: started.runId },
      secret,
      schema: ExecutionRunGetResponseSchema,
      timeoutMs: 40_000,
    });
    expect(got.run.runId).toBe(started.runId);
    expect(got.run.status).toBe('cancelled');
    expect(got.run.retentionPolicy).toBe('resumable');
    expect(got.run.runClass).toBe('long_lived');
  }, 120_000);
});
