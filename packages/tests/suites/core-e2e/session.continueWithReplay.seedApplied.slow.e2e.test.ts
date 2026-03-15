import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
  SessionContinueWithReplayRpcResultSchema,
} from '@happier-dev/protocol';

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
import { createSession, fetchAllMessages } from '../../src/testkit/sessions';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';

const run = createRunDirs({ runLabel: 'core' });

type JsonlEvent = { [key: string]: unknown };

function parseJsonl(raw: string): JsonlEvent[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonlEvent];
      } catch {
        return [];
      }
    });
}

async function readJsonlFile(path: string): Promise<JsonlEvent[]> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return parseJsonl(raw);
}

async function waitForFakeClaudeObservedPrompt(params: {
  logPath: string;
  predicate: (text: string) => boolean;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const events = await readJsonlFile(params.logPath);
    for (const evt of events) {
      if (evt?.type === 'sdk_stdin' && evt?.hasUserText === true && typeof evt.userTextPreview === 'string') {
        if (params.predicate(evt.userTextPreview)) return evt.userTextPreview;
      }
      if (evt?.type === 'invocation' && evt?.mode === 'local' && Array.isArray((evt as any).argv)) {
        const argv = (evt as any).argv as unknown[];
        const idx = argv.indexOf('--print');
        const prompt = idx >= 0 && typeof argv[idx + 1] === 'string'
          ? String(argv[idx + 1])
          : typeof argv[argv.length - 1] === 'string' ? String(argv[argv.length - 1]) : '';
        if (prompt && params.predicate(prompt)) return prompt;
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for fake Claude prompt observation in ${params.logPath}`);
}

type SessionsV2GetResponse = {
  session?: {
    id?: unknown;
    dataEncryptionKey?: unknown;
    metadata?: unknown;
  };
};

async function fetchSessionV2(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
}): Promise<{ dataEncryptionKeyBase64: string; metadataCiphertextBase64: string }> {
  const res = await fetchJson<SessionsV2GetResponse>(`${params.baseUrl}/v2/sessions/${params.sessionId}`, {
    headers: { Authorization: `Bearer ${params.token}` },
    timeoutMs: 20_000,
  });
  if (res.status !== 200) throw new Error(`Failed to fetch /v2/sessions/${params.sessionId} (status=${res.status})`);
  const dek = (res.data as any)?.session?.dataEncryptionKey;
  const meta = (res.data as any)?.session?.metadata;
  if (typeof dek !== 'string' || dek.length === 0) throw new Error('Missing session.dataEncryptionKey');
  if (typeof meta !== 'string' || meta.length === 0) throw new Error('Missing session.metadata');
  return { dataEncryptionKeyBase64: dek, metadataCiphertextBase64: meta };
}

async function resolveDaemonMachineIdFromSettings(params: { daemonHomeDir: string }): Promise<string> {
  const raw = await readFile(resolve(join(params.daemonHomeDir, 'settings.json')), 'utf8').catch(() => '');
  const parsed = raw ? JSON.parse(raw) as any : null;
  const activeServerId = parsed && typeof parsed.activeServerId === 'string' ? String(parsed.activeServerId) : '';
  const machineIdByServerId = parsed && typeof parsed.machineIdByServerId === 'object' ? parsed.machineIdByServerId : null;
  const machineId = activeServerId && machineIdByServerId && typeof machineIdByServerId[activeServerId] === 'string'
    ? String(machineIdByServerId[activeServerId])
    : '';
  if (!machineId) throw new Error('Missing machineIdByServerId[activeServerId] in seeded settings.json');
  return machineId;
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

async function postEncryptedUiTextMessage(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  sessionKey: Uint8Array;
  text: string;
}): Promise<{ localId: string }> {
  const localId = randomUUID();
  const msg = {
    role: 'user',
    content: { type: 'text', text: params.text },
    localId,
    meta: { source: 'ui', sentFrom: 'e2e' },
  };
  const ciphertext = encryptDataKeyBase64(msg, params.sessionKey);
  const endpoint = `${params.baseUrl}/v2/sessions/${params.sessionId}/messages`;
  const res = await fetchJson<any>(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciphertext, localId }),
    timeoutMs: 20_000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to post UI message to ${endpoint} (status=${res.status})`);
  }
  return { localId };
}

describe('core e2e: replaySeedV1 is applied to the first provider prompt but not committed to transcript', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  });

  it('prefixes the first provider prompt with replay seed and consumes metadata exactly once', async () => {
    const testDir = run.testDir('session-continue-with-replay-seed-applied');
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

    const sessionDekPlain = Uint8Array.from(randomBytes(32));
    const sealedDek = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDekPlain,
      recipientPublicKey: seeded.publicKey,
      randomBytes: (length) => Uint8Array.from(randomBytes(length)),
    });
    const { sessionId: previousSessionId } = await createSession(server.baseUrl, auth.token, {
      dataEncryptionKeyBase64: Buffer.from(sealedDek).toString('base64'),
    });

    const previous = await fetchSessionV2({ baseUrl: server.baseUrl, token: auth.token, sessionId: previousSessionId });
    const openedPrevDek = openEncryptedDataKeyEnvelopeV1({
      envelope: new Uint8Array(Buffer.from(previous.dataEncryptionKeyBase64, 'base64')),
      recipientSecretKeyOrSeed: machineKey,
    });
    if (!openedPrevDek || openedPrevDek.length !== 32) throw new Error('Failed to open previous session DEK');

    const prevContext = `PREV_CTX_${randomUUID()}`;
    await postEncryptedMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: previousSessionId,
      sessionKey: openedPrevDek,
      message: { role: 'user', content: { type: 'text', text: prevContext } },
    });
    const toolCmd = `echo REPLAY_TOOL_USE_${randomUUID()}`;
    const toolResultText = `REPLAY_TOOL_RESULT_${randomUUID()}`;
    await postEncryptedMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: previousSessionId,
      sessionKey: openedPrevDek,
      message: {
        role: 'agent',
        content: {
          type: 'output',
          data: {
            type: 'assistant',
            uuid: randomUUID(),
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: `toolu_${randomUUID()}`,
                  name: 'Bash',
                  input: { command: toolCmd, description: 'Replay seed tool-use coverage' },
                },
              ],
            },
          },
        },
      },
    });
    await postEncryptedMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: previousSessionId,
      sessionKey: openedPrevDek,
      message: {
        role: 'agent',
        content: {
          type: 'output',
          data: {
            type: 'assistant',
            uuid: randomUUID(),
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: `toolu_${randomUUID()}`, content: toolResultText }],
            },
          },
        },
      },
    });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeChildLogPath = resolve(join(testDir, 'fake-claude-child.jsonl'));

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
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeChildLogPath,
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

    const daemonMachineId = await resolveDaemonMachineIdFromSettings({ daemonHomeDir });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });
    const machineRpc = createDataKeyRpcClient(ui, machineKey);

    const replay = await machineRpc.call(`${daemonMachineId}:${RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY}`, {
      directory: workspaceDir,
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId,
        strategy: 'recent_messages',
        recentMessagesCount: 16,
        seedMode: 'draft',
      },
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.error ?? 'continueWithReplay failed');

    const parsed = SessionContinueWithReplayRpcResultSchema.safeParse(replay.result);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== 'success') throw new Error('Expected success continueWithReplay response');
    const childSessionId = parsed.data.sessionId;

    const childSession = await fetchSessionV2({ baseUrl: server.baseUrl, token: auth.token, sessionId: childSessionId });
    const openedChildDek = openEncryptedDataKeyEnvelopeV1({
      envelope: new Uint8Array(Buffer.from(childSession.dataEncryptionKeyBase64, 'base64')),
      recipientSecretKeyOrSeed: machineKey,
    });
    if (!openedChildDek || openedChildDek.length !== 32) throw new Error('Failed to open child session DEK');

    const childPrompt = `CHILD_CTX_CHECK_${randomUUID()}`;
    const firstUi = await postEncryptedUiTextMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: childSessionId,
      sessionKey: openedChildDek,
      text: childPrompt,
    });

    const providerPrompt = await waitForFakeClaudeObservedPrompt({
      logPath: fakeChildLogPath,
      predicate: (t) => t.includes(prevContext) && t.includes(childPrompt),
      timeoutMs: 60_000,
    });
    expect(providerPrompt).toContain(prevContext);
    expect(providerPrompt).toContain(toolCmd);
    expect(providerPrompt).toContain(toolResultText);
    expect(providerPrompt).toContain(childPrompt);

    await waitFor(async () => {
      const rows = await fetchAllMessages(server!.baseUrl, auth.token, childSessionId);
      const decrypted = rows
        .map((m) => decryptDataKeyBase64(m.content.c, openedChildDek))
        .filter((m) => m && typeof m === 'object') as any[];
      const sawUser = decrypted.some((m) => m?.role === 'user' && m?.content?.text === childPrompt);
      const sawSeedLeak = decrypted.some((m) =>
        m?.role === 'user' &&
        typeof m?.content?.text === 'string' &&
        String(m.content.text).includes(prevContext) &&
        String(m.content.text).includes(childPrompt) &&
        String(m.content.text).length > childPrompt.length + 20,
      );
      return sawUser && !sawSeedLeak;
    }, { timeoutMs: 60_000 });

    await waitFor(async () => {
      const latest = await fetchSessionV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId: childSessionId });
      const meta = decryptDataKeyBase64(latest.metadataCiphertextBase64, openedChildDek) as any;
      const seed = meta?.replaySeedV1;
      if (!seed || seed.v !== 1) return false;
      if (typeof seed.seedText !== 'string') return false;
      if (seed.seedText !== '') return false;
      if (seed.appliedToLocalId !== firstUi.localId) return false;
      return true;
    }, { timeoutMs: 60_000 });

    // Restart-safety: repeat the flow but interrupt the auto-spawned runner before first prompt.
    const replay2 = await machineRpc.call(`${daemonMachineId}:${RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY}`, {
      directory: workspaceDir,
      agent: 'claude',
      approvedNewDirectoryCreation: true,
      replay: {
        previousSessionId,
        strategy: 'recent_messages',
        recentMessagesCount: 16,
        seedMode: 'draft',
      },
    });
    expect(replay2.ok).toBe(true);
    if (!replay2.ok) throw new Error(replay2.error ?? 'continueWithReplay failed');
    const parsed2 = SessionContinueWithReplayRpcResultSchema.safeParse(replay2.result);
    expect(parsed2.success).toBe(true);
    if (!parsed2.success || parsed2.data.type !== 'success') throw new Error('Expected success continueWithReplay response');
    const childSessionId2 = parsed2.data.sessionId;

    const childSession2 = await fetchSessionV2({ baseUrl: server.baseUrl, token: auth.token, sessionId: childSessionId2 });
    const openedChildDek2 = openEncryptedDataKeyEnvelopeV1({
      envelope: new Uint8Array(Buffer.from(childSession2.dataEncryptionKeyBase64, 'base64')),
      recipientSecretKeyOrSeed: machineKey,
    });
    if (!openedChildDek2 || openedChildDek2.length !== 32) throw new Error('Failed to open child session DEK');

    const stopRes2 = await daemonControlPostJson<{ success: boolean }>({
      port: daemon.state.httpPort,
      path: '/stop-session',
      controlToken,
      body: { sessionId: childSessionId2 },
    });
    expect(stopRes2.status).toBe(200);

    const childSpawn2 = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        sessionId: childSessionId2,
        terminal: { mode: 'plain' },
      },
    });
    expect(childSpawn2.status).toBe(200);
    expect(childSpawn2.data.success).toBe(true);

    const childPrompt2 = `CHILD_CTX_RESTART_${randomUUID()}`;
    const firstUi2 = await postEncryptedUiTextMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: childSessionId2,
      sessionKey: openedChildDek2,
      text: childPrompt2,
    });

    const providerPrompt2 = await waitForFakeClaudeObservedPrompt({
      logPath: fakeChildLogPath,
      predicate: (t) => t.includes(prevContext) && t.includes(childPrompt2),
      timeoutMs: 60_000,
    });
    expect(providerPrompt2).toContain(prevContext);
    expect(providerPrompt2).toContain(childPrompt2);

    await waitFor(async () => {
      const latest = await fetchSessionV2({ baseUrl: server!.baseUrl, token: auth.token, sessionId: childSessionId2 });
      const meta = decryptDataKeyBase64(latest.metadataCiphertextBase64, openedChildDek2) as any;
      const seed = meta?.replaySeedV1;
      if (!seed || seed.v !== 1) return false;
      if (typeof seed.seedText !== 'string') return false;
      if (seed.seedText !== '') return false;
      if (seed.appliedToLocalId !== firstUi2.localId) return false;
      return true;
    }, { timeoutMs: 60_000 });

    ui.close();
  }, 240_000);
});
