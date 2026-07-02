import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  MemorySearchResultV1Schema,
  MemorySettingsV1Schema,
  MemoryStatusV1Schema,
  MemoryWindowV1Schema,
  type MemorySearchHitV1,
  type MemorySearchResultV1,
  type MemoryStatusV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
  callEncryptedMachineRpc,
  MemoryEnsureUpToDateAckSchema,
  postEncryptedSessionMessage,
} from '../../src/testkit/memoryRpc';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';

const run = createRunDirs({ runLabel: 'core' });

type MemoryTestContext = Readonly<{
  baseUrl: string;
  token: string;
  secret: Uint8Array;
}>;

type MemoryIndexContentForAssertion = Readonly<{
  lightShardCount: number;
  searchableSessionCount: number;
}>;

function randomMemorySentinel(label: string): string {
  return `OPENCLAW_MEMORY_SENTINEL_${label}_${randomUUID().replace(/-/g, '_')}`;
}

async function seedEventHeavyTranscript(params: MemoryTestContext & Readonly<{
  sessionId: string;
  semanticSentinel: string;
  legacyNullRoleSentinel: string;
  claudeOutputSentinel: string;
  excludedToolSentinel: string;
}>): Promise<void> {
  await postEncryptedSessionMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    localId: 'semantic-user-1',
    messageRole: 'user',
    payload: {
      role: 'user',
      content: { type: 'text', text: `Please remember the migration note ${params.semanticSentinel}.` },
    },
  });

  for (let i = 0; i < 20; i += 1) {
    await postEncryptedSessionMessage({
      baseUrl: params.baseUrl,
      token: params.token,
      sessionId: params.sessionId,
      secret: params.secret,
      localId: `excluded-tool-event-${i}`,
      messageRole: 'event',
      payload: {
        role: 'agent',
        content: {
          type: 'text',
          text: `tool-output-noise ${i}: ${params.excludedToolSentinel}`,
        },
      },
    });
  }

  await postEncryptedSessionMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    localId: 'legacy-null-role-semantic-1',
    payload: {
      role: 'user',
      content: { type: 'text', text: `Legacy null-role semantic memory ${params.legacyNullRoleSentinel}.` },
    },
  });

  await postEncryptedSessionMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    localId: 'semantic-assistant-1',
    messageRole: 'agent',
    payload: {
      role: 'agent',
      content: {
        type: 'acp',
        provider: 'codex',
        data: {
          type: 'message',
          message: `The semantic backfill answer is ${params.semanticSentinel}.`,
        },
      },
    },
  });

  await postEncryptedSessionMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    localId: 'semantic-claude-output-1',
    messageRole: 'agent',
    payload: {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `Claude output semantic memory ${params.claudeOutputSentinel}.` }],
          },
        },
      },
    },
  });
}

async function seedShortTranscript(params: MemoryTestContext & Readonly<{
  sessionId: string;
  sentinel: string;
}>): Promise<void> {
  await postEncryptedSessionMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    localId: 'short-user-1',
    messageRole: 'user',
    payload: {
      role: 'user',
      content: { type: 'text', text: `Short session asks about ${params.sentinel}.` },
    },
  });
  await postEncryptedSessionMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    sessionId: params.sessionId,
    secret: params.secret,
    localId: 'short-assistant-1',
    messageRole: 'agent',
    payload: {
      role: 'agent',
      content: { type: 'text', text: `Short session answer preserves ${params.sentinel}.` },
    },
  });
}

async function searchMemory(params: Readonly<{
  ui: ReturnType<typeof createUserScopedSocketCollector>;
  machineId: string;
  secret: Uint8Array;
  query: string;
}>): Promise<MemorySearchResultV1> {
  return await callEncryptedMachineRpc({
    ui: params.ui,
    machineId: params.machineId,
    method: RPC_METHODS.DAEMON_MEMORY_SEARCH,
    req: { v: 1, query: params.query, scope: { type: 'global' }, mode: 'auto', maxResults: 5 },
    secret: params.secret,
    schema: MemorySearchResultV1Schema,
    timeoutMs: 90_000,
  });
}

async function fetchMemoryStatus(params: Readonly<{
  ui: ReturnType<typeof createUserScopedSocketCollector>;
  machineId: string;
  secret: Uint8Array;
}>): Promise<MemoryStatusV1> {
  return await callEncryptedMachineRpc({
    ui: params.ui,
    machineId: params.machineId,
    method: RPC_METHODS.DAEMON_MEMORY_STATUS,
    req: { v: 1 },
    secret: params.secret,
    schema: MemoryStatusV1Schema,
    timeoutMs: 60_000,
  });
}

function expectFirstHitForSession(result: MemorySearchResultV1, sessionId: string): MemorySearchHitV1 {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`memory search failed: ${result.errorCode}`);
  }
  const hit = result.hits.find((candidate) => candidate.sessionId === sessionId) ?? null;
  expect(hit).not.toBeNull();
  return hit!;
}

function expectNoHitsForSession(result: MemorySearchResultV1, sessionId: string): void {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`memory search failed: ${result.errorCode}`);
  }
  expect(result.hits.some((hit) => hit.sessionId === sessionId)).toBe(false);
}

function readRequiredIndexContent(status: MemoryStatusV1): MemoryIndexContentForAssertion {
  const content: unknown = status.indexContent;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('memory status did not include indexContent');
  }
  const lightShardCount = (content as Record<string, unknown>).lightShardCount;
  const searchableSessionCount = (content as Record<string, unknown>).searchableSessionCount;
  if (typeof lightShardCount !== 'number' || typeof searchableSessionCount !== 'number') {
    throw new Error('memory status indexContent did not include searchable counts');
  }
  return { lightShardCount, searchableSessionCount };
}

describe('core e2e: memory semantic backfill role-filtered roundtrip', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
    daemon = null;
    server = null;
  });

  it('indexes semantic rows across event-heavy, short, and incremental transcripts without searching event noise', async () => {
    const testDir = run.testDir('memory-semantic-backfill-role-filtered');
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

    const eventHeavy = await createSession(server.baseUrl, auth.token);
    const short = await createSession(server.baseUrl, auth.token);
    const eventHeavySentinel = randomMemorySentinel('SEMANTIC');
    const legacyNullRoleSentinel = randomMemorySentinel('LEGACY_NULL_ROLE');
    const claudeOutputSentinel = randomMemorySentinel('CLAUDE_OUTPUT');
    const excludedToolSentinel = randomMemorySentinel('TOOL_NOISE');
    const shortSentinel = randomMemorySentinel('SHORT');
    const incrementalSentinel = randomMemorySentinel('INCREMENTAL');

    const testContext = { baseUrl: server.baseUrl, token: auth.token, secret };
    await seedEventHeavyTranscript({
      ...testContext,
      sessionId: eventHeavy.sessionId,
      semanticSentinel: eventHeavySentinel,
      legacyNullRoleSentinel,
      claudeOutputSentinel,
      excludedToolSentinel,
    });
    await seedShortTranscript({ ...testContext, sessionId: short.sessionId, sentinel: shortSentinel });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    try {
      const settings = await callEncryptedMachineRpc({
        ui,
        machineId: seeded.machineId,
        method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET,
        req: {
          v: 1,
          enabled: true,
          indexMode: 'hints',
          backfillPolicy: 'all_history',
          hints: {
            updateMode: 'continuous',
            idleDelayMs: 0,
            windowSizeMessages: 16,
            targetShardMessages: 16,
            minShardMessages: 1,
          },
          worker: { maxSessionsPerTick: 10 },
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
        req: {},
        secret,
        schema: MemoryEnsureUpToDateAckSchema,
        timeoutMs: 90_000,
      });

      const eventHeavySearch = await searchMemory({
        ui,
        machineId: seeded.machineId,
        secret,
        query: eventHeavySentinel,
      });
      const eventHeavyHit = expectFirstHitForSession(eventHeavySearch, eventHeavy.sessionId);

      const legacyNullRoleSearch = await searchMemory({
        ui,
        machineId: seeded.machineId,
        secret,
        query: legacyNullRoleSentinel,
      });
      expectFirstHitForSession(legacyNullRoleSearch, eventHeavy.sessionId);

      const claudeOutputSearch = await searchMemory({
        ui,
        machineId: seeded.machineId,
        secret,
        query: claudeOutputSentinel,
      });
      const claudeOutputHit = expectFirstHitForSession(claudeOutputSearch, eventHeavy.sessionId);

      const excludedToolSearch = await searchMemory({
        ui,
        machineId: seeded.machineId,
        secret,
        query: excludedToolSentinel,
      });
      expectNoHitsForSession(excludedToolSearch, eventHeavy.sessionId);

      const shortSearch = await searchMemory({
        ui,
        machineId: seeded.machineId,
        secret,
        query: shortSentinel,
      });
      expectFirstHitForSession(shortSearch, short.sessionId);

      const windowRes = await callEncryptedMachineRpc({
        ui,
        machineId: seeded.machineId,
        method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
        req: {
          v: 1,
          sessionId: eventHeavy.sessionId,
          seqFrom: eventHeavyHit.seqFrom,
          seqTo: eventHeavyHit.seqTo,
        },
        secret,
        schema: MemoryWindowV1Schema,
        timeoutMs: 90_000,
      });
      const windowText = windowRes.snippets.map((snippet) => snippet.text).join('\n');
      expect(windowText).toContain(eventHeavySentinel);
      expect(windowText).not.toContain(excludedToolSentinel);

      const claudeWindowRes = await callEncryptedMachineRpc({
        ui,
        machineId: seeded.machineId,
        method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
        req: {
          v: 1,
          sessionId: eventHeavy.sessionId,
          seqFrom: claudeOutputHit.seqFrom,
          seqTo: claudeOutputHit.seqTo,
        },
        secret,
        schema: MemoryWindowV1Schema,
        timeoutMs: 90_000,
      });
      expect(claudeWindowRes.snippets.map((snippet) => snippet.text).join('\n')).toContain(claudeOutputSentinel);

      const status = await fetchMemoryStatus({ ui, machineId: seeded.machineId, secret });
      const indexContent = readRequiredIndexContent(status);
      expect(status.activeIndexSearchable).toBe(true);
      expect(indexContent.lightShardCount).toBeGreaterThan(0);
      expect(indexContent.searchableSessionCount).toBeGreaterThanOrEqual(2);
      expect(status.activeIndexSearchable).toBe(indexContent.lightShardCount > 0);

      await postEncryptedSessionMessage({
        baseUrl: server.baseUrl,
        token: auth.token,
        sessionId: eventHeavy.sessionId,
        secret,
        localId: 'semantic-incremental-user-1',
        messageRole: 'user',
        payload: {
          role: 'user',
          content: { type: 'text', text: `Incremental memory update ${incrementalSentinel}.` },
        },
      });

      await callEncryptedMachineRpc({
        ui,
        machineId: seeded.machineId,
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        req: { sessionId: eventHeavy.sessionId },
        secret,
        schema: MemoryEnsureUpToDateAckSchema,
        timeoutMs: 90_000,
      });

      const incrementalSearch = await searchMemory({
        ui,
        machineId: seeded.machineId,
        secret,
        query: incrementalSentinel,
      });
      expectFirstHitForSession(incrementalSearch, eventHeavy.sessionId);
    } finally {
      ui.disconnect();
    }
  }, 300_000);
});
