import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { openEncryptedDataKeyEnvelopeV1, SessionContinueWithReplayRpcResultSchema } from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient } from '../../src/testkit/syntheticAgent/rpcClient';
import { encryptDataKeyBase64, decryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { fetchAllMessages } from '../../src/testkit/sessions';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';

const run = createRunDirs({ runLabel: 'core' });

type SessionsV2GetResponse = {
  session?: {
    id?: unknown;
    dataEncryptionKey?: unknown;
  };
};

async function fetchSessionDataEncryptionKeyBase64(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
}): Promise<string> {
  const res = await fetchJson<SessionsV2GetResponse>(`${params.baseUrl}/v2/sessions/${params.sessionId}`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (res.status !== 200) {
    throw new Error(`Failed to fetch /v2/sessions/${params.sessionId} (status=${res.status})`);
  }
  const dek = (res.data as any)?.session?.dataEncryptionKey;
  if (typeof dek !== 'string' || dek.length === 0) {
    throw new Error('Missing session.dataEncryptionKey');
  }
  return dek;
}

async function postEncryptedMessage(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  sessionKey: Uint8Array;
  message: unknown;
}): Promise<void> {
  const ciphertext = encryptDataKeyBase64(params.message, params.sessionKey);
  const endpoint = `${params.baseUrl}/v2/sessions/${params.sessionId}/messages`;
  const res = await fetchJson<any>(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciphertext }),
    timeoutMs: 20_000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to post message to ${endpoint} (status=${res.status})`);
  }
}

describe('core e2e: machine RPC session.continueWithReplay hydrates transcript in dataKey mode', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('decrypts prior transcript via dataEncryptionKey and spawns a new session with seedDraft', async () => {
    const testDir = run.testDir('session-continue-with-replay-datakey-hydration');
    // Deterministic control-plane timing.
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
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

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
      },
    });

    const controlToken = (daemon.state as any)?.controlToken as string | undefined;
    await waitFor(
      async () => {
        const res = await daemonControlPostJson({ port: daemon!.state.httpPort, path: '/list', body: {}, controlToken });
        return res.status === 200;
      },
      { timeoutMs: 20_000 },
    );

    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        terminal: { mode: 'plain' },
        environmentVariables: {
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: server.baseUrl,
          HAPPIER_VARIANT: 'dev',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
        },
      },
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const previousSessionId = spawnRes.data.sessionId;
    expect(typeof previousSessionId).toBe('string');
    if (typeof previousSessionId !== 'string' || previousSessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    const encryptedDekBase64 = await fetchSessionDataEncryptionKeyBase64({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: previousSessionId,
    });
    const dek = openEncryptedDataKeyEnvelopeV1({
      envelope: new Uint8Array(Buffer.from(encryptedDekBase64, 'base64')),
      recipientSecretKeyOrSeed: machineKey,
    });
    if (!dek || dek.length !== 32) {
      throw new Error('Failed to open session dataEncryptionKey');
    }

    const userText = 'hello from e2e replay';
    const assistantText = 'hi from e2e replay';
    await postEncryptedMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: previousSessionId,
      sessionKey: dek,
      message: { role: 'user', content: { type: 'text', text: userText } },
    });
    await postEncryptedMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: previousSessionId,
      sessionKey: dek,
      message: { role: 'agent', content: { type: 'text', text: assistantText } },
    });

    const transcript = await fetchAllMessages(server.baseUrl, auth.token, previousSessionId);
    const decrypted = transcript
      .map((m) => decryptDataKeyBase64(m.content.c, dek))
      .filter((row) => row && typeof row === 'object');
    expect(decrypted.some((m: any) => m?.role === 'user' && m?.content?.text === userText)).toBe(true);
    expect(decrypted.some((m: any) => m?.role === 'agent' && m?.content?.text === assistantText)).toBe(true);

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

    const machineRpc = createDataKeyRpcClient(ui, machineKey);

    let replayResult: any | null = null;
    await waitFor(
      async () => {
        const res = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY}`, {
          directory: workspaceDir,
          agent: 'claude',
          approvedNewDirectoryCreation: true,
          replay: {
            previousSessionId,
            strategy: 'recent_messages',
            recentMessagesCount: 8,
            seedMode: 'draft',
          },
        });
        if (!res.ok) return false;
        replayResult = res.result;
        const parsed = SessionContinueWithReplayRpcResultSchema.safeParse(replayResult);
        return parsed.success && parsed.data.type === 'success';
      },
      { timeoutMs: 30_000 },
    );

    const parsed = SessionContinueWithReplayRpcResultSchema.safeParse(replayResult);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== 'success') {
      throw new Error('Expected success result from session.continueWithReplay');
    }
    expect(parsed.data.seedDraft).toContain(userText);
    expect(typeof parsed.data.sessionId).toBe('string');
    expect(parsed.data.sessionId.length).toBeGreaterThan(0);

    ui.close();
  });
});

