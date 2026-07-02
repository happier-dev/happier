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
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { createSession } from '../../src/testkit/sessions';
import {
  callEncryptedMachineRpc,
  MemoryEnsureUpToDateAckSchema,
  postEncryptedSessionMessage,
} from '../../src/testkit/memoryRpc';

const run = createRunDirs({ runLabel: 'core' });

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
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
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

    const settings = await callEncryptedMachineRpc({
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

    await callEncryptedMachineRpc({
      ui,
      machineId: seeded.machineId,
      method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
      req: { sessionId },
      secret,
      schema: MemoryEnsureUpToDateAckSchema,
      timeoutMs: 90_000,
    });

    const searchRes = await callEncryptedMachineRpc({
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

    const windowRes = await callEncryptedMachineRpc({
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
