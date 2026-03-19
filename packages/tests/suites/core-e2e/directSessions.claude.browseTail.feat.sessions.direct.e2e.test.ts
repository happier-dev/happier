import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { fetchSessionV2 } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('core e2e: direct Claude sessions browse/link/tail', () => {
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
    await server?.stop().catch(() => {});
  });

  it('lists provider-backed Claude sessions, links one idempotently, and tails appended log lines', async () => {
    const testDir = run.testDir('direct-sessions-claude-browse-tail');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const claudeConfigDir = resolve(join(testDir, '.claude'));
    const claudeSessionFile = resolve(join(claudeConfigDir, 'projects', 'proj-direct-core', 'sess-direct-core.jsonl'));

    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(join(claudeConfigDir, 'projects', 'proj-direct-core'), { recursive: true });
    await writeFile(
      claudeSessionFile,
      [
        jsonlLine({ type: 'user', uuid: 'core-u1', cwd: '/tmp/direct-core-project', message: { content: 'first direct core message' } }),
        jsonlLine({ type: 'assistant', uuid: 'core-a1', cwd: '/tmp/direct-core-project', message: { model: 'claude-test', content: [{ type: 'text', text: 'first direct core reply' }] } }),
        jsonlLine({ type: 'user', uuid: 'core-u2', cwd: '/tmp/direct-core-project', message: { content: 'latest direct core message' } }),
        jsonlLine({ type: 'assistant', uuid: 'core-a2', cwd: '/tmp/direct-core-project', message: { model: 'claude-test', content: [{ type: 'text', text: 'latest direct core reply' }] } }),
      ].join(''),
      'utf8',
    );

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const machineKey = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliDataKeyAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey,
    });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
      },
    });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000, context: 'socket connected for direct sessions e2e' });

      const machineRpc = createDataKeyRpcClient(ui, machineKey);

      let candidatesResult: any = null;
      await waitFor(
        async () => {
          const res = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST}`, {
            machineId: seeded.machineId,
            providerId: 'claude',
            source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-core' },
            limit: 20,
          });
          if (!res.ok) return false;
          candidatesResult = res.result;
          if ((candidatesResult as { ok?: unknown })?.ok === false) {
            throw new Error(`direct candidates rpc returned ${JSON.stringify(candidatesResult)}`);
          }
          return Array.isArray((candidatesResult as any)?.candidates) && (candidatesResult as any).candidates.length > 0;
        },
        { timeoutMs: 30_000, context: 'direct Claude candidates available' },
      );

      expect(candidatesResult).toEqual(expect.objectContaining({
        ok: true,
        candidates: expect.arrayContaining([
          expect.objectContaining({
            remoteSessionId: 'sess-direct-core',
          }),
        ]),
      }));

      const status = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET}`, {
        machineId: seeded.machineId,
        sessionId: 'sess_placeholder',
        providerId: 'claude',
        remoteSessionId: 'sess-direct-core',
        source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-core' },
      });
      const statusResult = unwrapDataKeyRpcResult(status, 'direct Claude session status');
      expect(statusResult).toEqual(expect.objectContaining({
        ok: true,
        machineOnline: true,
        runnerActive: false,
        canTakeOverDirect: true,
        canTakeOverPersist: false,
      }));

      const firstLink = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
        machineId: seeded.machineId,
        providerId: 'claude',
        remoteSessionId: 'sess-direct-core',
        source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-core' },
      });
      const firstLinkResult = unwrapDataKeyRpcResult(firstLink, 'direct Claude first link');
      expect(firstLinkResult).toEqual(expect.objectContaining({
        ok: true,
        created: true,
      }));

      const secondLink = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
        machineId: seeded.machineId,
        providerId: 'claude',
        remoteSessionId: 'sess-direct-core',
        source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-core' },
      });
      const secondLinkResult = unwrapDataKeyRpcResult(secondLink, 'direct Claude second link');
      expect((secondLinkResult as any)?.sessionId).toBe((firstLinkResult as any)?.sessionId);
      expect(secondLinkResult).toEqual(expect.objectContaining({
        ok: true,
        created: false,
      }));

      const page = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE}`, {
        machineId: seeded.machineId,
        providerId: 'claude',
        remoteSessionId: 'sess-direct-core',
        source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-core' },
        direction: 'older',
      });
      const pageResult = unwrapDataKeyRpcResult(page, 'direct Claude transcript page');
      expect(pageResult).toEqual(expect.objectContaining({
        ok: true,
        hasMore: true,
        items: expect.arrayContaining([
          expect.objectContaining({
            raw: expect.objectContaining({
              role: 'user',
            }),
          }),
        ]),
      }));
      expect(((pageResult as any).items as any[]).some((item) => item?.raw?.content?.text === 'latest direct core message')).toBe(true);

      const tailStart = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER}`, {
        machineId: seeded.machineId,
        providerId: 'claude',
        remoteSessionId: 'sess-direct-core',
        source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-core' },
        cursor: 'tail',
      });
      const tailStartResult = unwrapDataKeyRpcResult(tailStart, 'direct Claude transcript tail start');
      expect(tailStartResult).toEqual(expect.objectContaining({
        ok: true,
        items: [],
      }));

      await appendFile(
        claudeSessionFile,
        jsonlLine({ type: 'user', uuid: 'core-u3', cwd: '/tmp/direct-core-project', message: { content: 'appended direct core message' } }),
        'utf8',
      );

      let tailResult: any = null;
      await waitFor(
        async () => {
          const res = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER}`, {
            machineId: seeded.machineId,
            providerId: 'claude',
            remoteSessionId: 'sess-direct-core',
            source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-core' },
            cursor: (tailStartResult as any)?.nextCursor ?? 'tail',
          });
          if (!res.ok) return false;
          tailResult = unwrapDataKeyRpcResult(res, 'direct Claude transcript tail read_after');
          return Array.isArray((tailResult as any)?.items) && (tailResult as any).items.some((item: any) => item?.raw?.content?.text === 'appended direct core message');
        },
        { timeoutMs: 20_000, context: 'direct Claude tail catches appended line' },
      );

      expect(tailResult).toEqual(expect.objectContaining({
        ok: true,
        items: expect.arrayContaining([
          expect.objectContaining({
            raw: expect.objectContaining({
              role: 'user',
              content: expect.objectContaining({
                text: 'appended direct core message',
              }),
            }),
          }),
        ]),
      }));
    } finally {
      ui.close();
    }
  }, 240_000);

  it('converts a linked direct Claude session to persisted mode and resumes it through the persisted runner', async () => {
    const testDir = run.testDir('direct-sessions-claude-takeover-persist');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const claudeConfigDir = resolve(join(testDir, '.claude'));
    const claudeSessionFile = resolve(join(claudeConfigDir, 'projects', 'proj-direct-persist', 'sess-direct-persist.jsonl'));
    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));

    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(join(claudeConfigDir, 'projects', 'proj-direct-persist'), { recursive: true });
    await writeFile(
      claudeSessionFile,
      [
        jsonlLine({ type: 'queue-operation', operation: 'enqueue', sessionId: 'sess-direct-persist' }),
        jsonlLine({ type: 'queue-operation', operation: 'dequeue', sessionId: 'sess-direct-persist' }),
        jsonlLine({ type: 'user', uuid: 'persist-u1', cwd: '/tmp/direct-persist-project', message: { content: 'direct import hello' } }),
        jsonlLine({
          type: 'assistant',
          uuid: 'persist-a1',
          cwd: '/tmp/direct-persist-project',
          message: {
            model: 'claude-test',
            content: [{ type: 'text', text: 'direct import reply' }],
          },
        }),
      ].join(''),
      'utf8',
    );

    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    const machineKey = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliDataKeyAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey,
    });

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_HOME_DIR: daemonHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${randomUUID()}`,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), { timeoutMs: 20_000, context: 'socket connected for direct takeover persist e2e' });

      const machineRpc = createDataKeyRpcClient(ui, machineKey);

      let candidatesResult: any = null;
      await waitFor(
        async () => {
          const res = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST}`, {
            machineId: seeded.machineId,
            providerId: 'claude',
            source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-persist' },
            limit: 20,
          });
          if (!res.ok) return false;
          candidatesResult = res.result;
          return Array.isArray((candidatesResult as any)?.candidates)
            && (candidatesResult as any).candidates.some((candidate: any) => candidate?.remoteSessionId === 'sess-direct-persist');
        },
        { timeoutMs: 30_000, context: 'direct Claude persist candidate available' },
      );

      const link = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
        machineId: seeded.machineId,
        providerId: 'claude',
        remoteSessionId: 'sess-direct-persist',
        titleHint: 'Direct persist fixture',
        directoryHint: '/tmp/direct-persist-project',
        source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId: 'proj-direct-persist' },
      });
      const linkResult = unwrapDataKeyRpcResult(link, 'direct Claude persisted link');
      expect(linkResult).toEqual(expect.objectContaining({
        ok: true,
        created: true,
      }));
      const sessionId = (linkResult as { sessionId: string }).sessionId;

      const takeoverPersist = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST}`, {
        machineId: seeded.machineId,
        sessionId,
      }, 60_000);
      const takeoverPersistResult = unwrapDataKeyRpcResult(takeoverPersist, 'direct Claude takeover persist');
      expect(takeoverPersistResult).toEqual({ ok: true, converted: true });

      await waitFor(
        async () => {
          const session = await fetchSessionV2(server!.baseUrl, auth.token, sessionId);
          const metadata = JSON.parse(session.metadata) as Record<string, unknown>;
          return !('directSessionV1' in metadata) && typeof metadata.externalHistoryImportV1 === 'object' && metadata.path === '/tmp/direct-persist-project';
        },
        { timeoutMs: 60_000, context: 'direct session metadata converted to persisted' },
      );

      const sessionAfter = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      const metadataAfter = JSON.parse(sessionAfter.metadata) as Record<string, unknown>;
      expect(metadataAfter.directSessionV1).toBeUndefined();
      expect(metadataAfter.externalHistoryImportV1).toEqual(expect.objectContaining({
        v: 1,
        providerId: 'claude',
        remoteSessionId: 'sess-direct-persist',
      }));
      expect(metadataAfter.path).toBe('/tmp/direct-persist-project');

      const importedMessages = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/messages?limit=20`, {
        headers: { Authorization: `Bearer ${auth.token}` },
        timeoutMs: 20_000,
      });
      expect(importedMessages.status).toBe(200);
      expect(importedMessages.data?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: expect.objectContaining({
            t: 'plain',
            v: expect.objectContaining({
              role: 'user',
              content: expect.objectContaining({
                text: 'direct import hello',
              }),
            }),
          }),
        }),
      ]));

      const localId = `persisted-post-${randomUUID()}`;
      const postPersistPrompt = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': localId,
        },
        body: JSON.stringify({
          localId,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'persisted follow-up prompt' },
              meta: { source: 'ui', sentFrom: 'e2e' },
            },
          },
        }),
        timeoutMs: 20_000,
      });
      expect(postPersistPrompt.status).toBe(200);

      const persistedInvocation = await waitForFakeClaudeInvocation(
        fakeClaudeLogPath,
        (invocation) => invocation.argv.includes('--resume') && invocation.argv.includes('sess-direct-persist'),
        { timeoutMs: 60_000, pollMs: 100 },
      );
      expect(persistedInvocation.mode).toBe('sdk');
    } finally {
      ui.close();
    }
  }, 240_000);
});
