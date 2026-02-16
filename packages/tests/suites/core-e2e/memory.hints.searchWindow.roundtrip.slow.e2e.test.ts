import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  MemorySearchResultV1Schema,
  MemorySettingsV1Schema,
  MemoryWindowV1Schema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { waitFor } from '../../src/testkit/timing';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { decryptLegacyBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { createSession } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

type RpcAck = { ok?: boolean; result?: string; error?: string; errorCode?: string };

async function callMachineRpc<TReq, TRes>(params: {
  ui: ReturnType<typeof createUserScopedSocketCollector>;
  machineId: string;
  method: string;
  req: TReq;
  secret: Uint8Array;
  schema: { safeParse: (input: unknown) => { success: true; data: TRes } | { success: false } };
  timeoutMs?: number;
}): Promise<TRes> {
  let out: TRes | null = null;
  const encryptedParams = encryptLegacyBase64(params.req, params.secret);

  await waitFor(
    async () => {
      const res = await params.ui.rpcCall<RpcAck>(`${params.machineId}:${params.method}`, encryptedParams);
      if (!res || res.ok !== true || typeof res.result !== 'string') return false;
      const decrypted = decryptLegacyBase64(res.result, params.secret);
      const parsed = params.schema.safeParse(decrypted);
      if (!parsed.success) return false;
      out = parsed.data;
      return true;
    },
    { timeoutMs: params.timeoutMs ?? 45_000 },
  );

  if (!out) throw new Error(`Machine RPC did not return a valid response: ${params.method}`);
  return out;
}

async function postEncryptedSessionMessage(params: {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  payload: unknown;
}): Promise<void> {
  const ciphertext = encryptLegacyBase64(params.payload, params.secret);
  const res = await fetch(`${params.baseUrl}/v2/sessions/${params.sessionId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ciphertext }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post session message (status=${res.status})`);
  }
}

describe('core e2e: memory hints search + window roundtrip', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
    daemon = null;
    server = null;
  });

  it('generates a summary shard and can search + fetch a decrypted window', async () => {
    const testDir = run.testDir('memory-hints-roundtrip');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    await mkdir(daemonHomeDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: server.baseUrl, token: auth.token, secret });

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
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: server.baseUrl,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'memory-hints-json',
      },
    });

    const created = await createSession(server.baseUrl, auth.token);
    const sessionId = created.sessionId;

    const sentinel = `OPENCLAW_MEMORY_SENTINEL_${randomUUID()}`;

    await postEncryptedSessionMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      payload: { role: 'user', content: { type: 'text', text: `We talked about ${sentinel} and Openclaw.` } },
    });
    await postEncryptedSessionMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      payload: { role: 'agent', content: { type: 'text', text: `Yep, ${sentinel} is important for memory search.` } },
    });
    await postEncryptedSessionMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      payload: { role: 'user', content: { type: 'text', text: `Please remember ${sentinel}.` } },
    });
    await postEncryptedSessionMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      payload: { role: 'agent', content: { type: 'text', text: `Noted: ${sentinel} should be searchable later.` } },
    });
    await postEncryptedSessionMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      payload: { role: 'user', content: { type: 'text', text: `Ok great. ${sentinel}.` } },
    });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    const settings = await callMachineRpc({
      ui,
      machineId: seeded.machineId,
      method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET,
      req: {
        v: 1,
        enabled: true,
        indexMode: 'hints',
        backfillPolicy: 'all_history',
        hints: { updateMode: 'continuous', idleDelayMs: 0, windowSizeMessages: 5 },
      },
      secret,
      schema: MemorySettingsV1Schema,
      timeoutMs: 60_000,
    });
    expect(settings.enabled).toBe(true);

    await callMachineRpc({
      ui,
      machineId: seeded.machineId,
      method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
      req: { sessionId },
      secret,
      schema: { safeParse: (value: any) => (value && value.ok === true ? { success: true, data: value } : { success: false }) } as any,
      timeoutMs: 90_000,
    });

    const searchRes = await callMachineRpc({
      ui,
      machineId: seeded.machineId,
      method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
      req: { v: 1, query: sentinel, scope: { type: 'global' }, mode: 'auto', maxResults: 5 },
      secret,
      schema: MemorySearchResultV1Schema,
      timeoutMs: 90_000,
    });

    expect(searchRes.ok).toBe(true);
    if (!searchRes.ok) return;
    const hit = searchRes.hits[0];
    expect(hit?.sessionId).toBe(sessionId);

    const windowRes = await callMachineRpc({
      ui,
      machineId: seeded.machineId,
      method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
      req: { v: 1, sessionId, seqFrom: hit!.seqFrom, seqTo: hit!.seqTo },
      secret,
      schema: MemoryWindowV1Schema,
      timeoutMs: 90_000,
    });

    const combined = windowRes.snippets.map((s) => s.text).join('\n');
    expect(combined).toContain(sentinel);

    ui.disconnect();
  }, 240_000);
});
