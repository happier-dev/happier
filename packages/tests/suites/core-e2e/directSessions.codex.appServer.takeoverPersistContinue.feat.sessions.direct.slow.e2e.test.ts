import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readNonAuthoritativeLinkedExternalSessionV1FromMetadata } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import {
  resolveTestDbProvider,
  startServerLight,
  type StartedServer,
} from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import {
  replaceTestDaemonWithoutStoppingSessions,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { fetchSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';
import { fetchJson } from '../../src/testkit/http';
import {
  readFakeCodexAppServerRequestLog,
  writeFakeCodexAppServerScript,
} from '../../src/testkit/codexAppServerRemoteHarness';

const run = createRunDirs({ runLabel: 'core' });
const suiteDbProvider = resolveTestDbProvider(process.env, {
  fallbackProvider: 'sqlite',
});

type JsonRecord = Record<string, unknown>;

function requireRecord(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${context} to be an object.`);
  }
  return value as JsonRecord;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${context} to be a non-empty string.`);
  }
  return value;
}

function requireNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected ${context} to be a non-negative safe integer.`);
  }
  return value;
}

async function fetchPublicMessages(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
}>): Promise<JsonRecord[]> {
  const response = await fetchJson<{ messages?: unknown }>(
    `${params.baseUrl}/v1/sessions/${params.sessionId}/messages?afterSeq=0&limit=200`,
    {
      headers: { Authorization: `Bearer ${params.token}` },
      timeoutMs: 30_000,
    },
  );
  if (response.status !== 200 || !Array.isArray(response.data?.messages)) {
    throw new Error(`Failed to read imported Codex transcript (status=${response.status}).`);
  }
  return response.data.messages.map((row, index) =>
    requireRecord(row, `imported transcript row ${index}`));
}

async function writeStoppedCodexOwnerMarker(params: Readonly<{
  daemonHomeDir: string;
  linkedDirectory: string;
  sessionId: string;
  remoteSessionId: string;
}>): Promise<void> {
  const deadPid = 2_147_483_647;
  const marker = {
    pid: deadPid,
    happySessionId: params.sessionId,
    happyHomeDir: params.daemonHomeDir,
    createdAt: 1,
    updatedAt: Date.now(),
    flavor: 'codex',
    startedBy: 'terminal',
    cwd: params.linkedDirectory,
    processCommandHash: '0'.repeat(64),
    processStartTimeMs: 1,
    processCommand: 'stopped-fake-codex-owner',
    metadata: {
      flavor: 'codex',
      codexSessionId: params.remoteSessionId,
    },
  };
  for (const basename of ['daemon-sessions', 'daemon-sessions.dev']) {
    const markerDir = join(params.daemonHomeDir, 'tmp', basename);
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, `pid-${deadPid}.json`),
      JSON.stringify(marker),
      'utf8',
    );
  }
}

describe('core e2e: direct Codex app-server sessions takeover+continue', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let retiredDaemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await retiredDaemon?.proc.stop().catch(() => {});
    retiredDaemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await retiredDaemon?.proc.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  it('stays passive through a daemon restart after persisted import, then explicitly resumes the same vendor thread', async () => {
    const testDir = run.testDir('direct-sessions-codex-app-server-takeover-persist-continue');
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const codexHomeDir = resolve(join(testDir, '.codex'));
    const rolloutDir = resolve(join(codexHomeDir, 'sessions', '2026', '07', '26'));
    const appServerRequestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
    const remoteSessionId = '44444444-4444-4444-4444-444444444444';
    const linkedDirectory = resolve(join(testDir, 'project'));
    const importedMarker = 'CODEX_DIRECT_TAKEOVER_IMPORTED_HISTORY';

    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(rolloutDir, { recursive: true });
    await mkdir(linkedDirectory, { recursive: true });
    await writeFile(
      resolve(join(rolloutDir, `rollout-2026-07-26T00-00-00-${remoteSessionId}.jsonl`)),
      [
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-07-26T00:00:00.000Z',
          payload: {
            id: remoteSessionId,
            timestamp: '2026-07-26T00:00:00.000Z',
            cwd: linkedDirectory,
          },
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: '2026-07-26T00:00:01.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: importedMarker }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const fakeAppServer = await writeFakeCodexAppServerScript({
      dir: testDir,
      requestLogPath: appServerRequestLogPath,
    });

    server = await startServerLight({
      testDir,
      dbProvider: suiteDbProvider,
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);

    const seeded = await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
    });

    const daemonEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
      CODEX_HOME: codexHomeDir,
      HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
      HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), {
      timeoutMs: 20_000,
      context: 'socket connected for direct Codex app-server persisted takeover',
    });

    try {
      const machineRpc = createDataKeyRpcClient(ui, auth.accountMachineKey);
      const route = (method: string): string => `${seeded.machineId}:${method}`;

      let link: Awaited<ReturnType<typeof machineRpc.call>> | null = null;
      await waitFor(async () => {
        link = await machineRpc.call(route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE), {
          machineId: seeded.machineId,
          providerId: 'codex',
          remoteSessionId,
          titleHint: 'Direct Codex app-server linked session',
          directoryHint: linkedDirectory,
          codexBackendMode: 'appServer',
          source: { kind: 'codexHome', home: 'user' },
        });
        return link.ok === true;
      }, { timeoutMs: 30_000, context: 'direct Codex app-server link RPC available' });
      if (!link) throw new Error('Expected direct Codex app-server link response.');
      const linkResult = requireRecord(
        unwrapDataKeyRpcResult(link, 'direct Codex app-server persisted link'),
        'direct Codex app-server persisted link',
      );
      expect(linkResult).toEqual(expect.objectContaining({ ok: true, created: true }));
      const sessionId = requireString(linkResult.sessionId, 'linked session id');
      await writeStoppedCodexOwnerMarker({
        daemonHomeDir,
        linkedDirectory,
        sessionId,
        remoteSessionId,
      });
      expect(unwrapDataKeyRpcResult(await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET),
        {
          machineId: seeded.machineId,
          sessionId,
          providerId: 'codex',
          remoteSessionId,
          source: { kind: 'codexHome', home: 'user' },
          enabled: false,
        },
      ), 'disable background follow before persisted takeover')).toEqual(
        expect.objectContaining({ ok: true, enabled: false }),
      );

      const ordinaryPage = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE),
        {
          machineId: seeded.machineId,
          providerId: 'codex',
          remoteSessionId,
          source: { kind: 'codexHome', home: 'user' },
          direction: 'older',
        },
      );
      expect(unwrapDataKeyRpcResult(ordinaryPage, 'ordinary linked transcript page')).toEqual(
        expect.objectContaining({ ok: true, tailCursor: expect.any(String) }),
      );

      const linkedMetadata = await fetchSessionMetadataV2({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        machineKeys: [auth.accountMachineKey],
      });
      const linked = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(linkedMetadata);
      if (!linked?.qualifiedIdentity) {
        throw new Error('Expected canonical qualified linked-session identity.');
      }
      const request = {
        v: 1 as const,
        idempotencyKey: `codex-takeover-${randomUUID()}`,
        sessionId,
        source: {
          machineId: seeded.machineId,
          remoteSessionId,
          qualifiedIdentity: linked.qualifiedIdentity,
          linkGeneration: String(linked.linkedAtMs),
        },
        plan: 'takeover' as const,
        targetStorageMode: 'persisted' as const,
        targetRuntimeMode: 'terminal' as const,
      };

      const start = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START),
        { request },
        180_000,
      );
      const startResult = requireRecord(
        unwrapDataKeyRpcResult(start, 'durable Codex takeover start'),
        'durable Codex takeover start',
      );
      expect(startResult).toEqual(expect.objectContaining({
        ok: true,
        progress: expect.objectContaining({
          status: 'awaiting_user_resume',
          phase: 'validating',
          currentStorageState: 'machine_only',
          revision: 0,
        }),
      }));
      const startProgress = requireRecord(startResult.progress, 'takeover start progress');
      const operationId = requireString(startProgress.operationId, 'takeover operation id');
      const startRevision = requireNumber(startProgress.revision, 'takeover start revision');

      const duplicateStart = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START),
        { request },
        180_000,
      );
      expect(unwrapDataKeyRpcResult(duplicateStart, 'idempotent Codex takeover start')).toEqual(startResult);

      const status = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET),
        { sessionId, operationId, revision: startRevision },
      );
      expect(unwrapDataKeyRpcResult(status, 'Codex takeover status')).toEqual(startResult);

      const requestsBeforeResume = await readFakeCodexAppServerRequestLog(appServerRequestLogPath);
      expect(requestsBeforeResume.filter((entry) => entry.method === 'thread/resume')).toEqual([]);

      const publishedBeforeResume = await fetchSessionMetadataV2({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        machineKeys: [auth.accountMachineKey],
      });
      expect(publishedBeforeResume.externalSessionOperationV1).toEqual({
        v: 1,
        progress: startProgress,
      });

      const importResume = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME),
        { sessionId, operationId, revision: startRevision },
        180_000,
      );
      const importResumeResult = requireRecord(
        unwrapDataKeyRpcResult(importResume, 'durable Codex takeover import resume'),
        'durable Codex takeover import resume',
      );
      expect(importResumeResult).toEqual(expect.objectContaining({
        ok: true,
        progress: expect.objectContaining({
          operationId,
          status: 'awaiting_user_resume',
          phase: 'admitting',
          currentStorageState: 'snapshot_complete',
          checkpoint: expect.objectContaining({
            importedItemCount: 1,
            requiredItemFailures: expect.objectContaining({ total: 0 }),
          }),
        }),
      }));
      const importProgress = requireRecord(importResumeResult.progress, 'imported takeover progress');
      const importRevision = requireNumber(importProgress.revision, 'imported takeover revision');
      expect(importRevision).toBeGreaterThan(startRevision);
      expect((await readFakeCodexAppServerRequestLog(appServerRequestLogPath))
        .filter((entry) => entry.method === 'thread/resume')).toEqual([]);

      // This is deliberately after the persisted-takeover import → admission
      // transition: the operation is now durable but non-terminal, so boot must
      // hydrate it without reading or resuming the native Codex thread.
      const appServerRequestsBeforeRestart = await readFakeCodexAppServerRequestLog(
        appServerRequestLogPath,
      );
      const originalDaemon = daemon;
      if (!originalDaemon) throw new Error('Expected running daemon before persisted takeover restart.');
      const originalDaemonPid = originalDaemon.state.pid;
      const replacement = await replaceTestDaemonWithoutStoppingSessions({
        testDir,
        happyHomeDir: daemonHomeDir,
        env: daemonEnv,
        originalDaemon,
      });
      retiredDaemon = originalDaemon;
      daemon = replacement;
      expect(replacement.state.pid).not.toBe(originalDaemonPid);

      let recoveredStatus: JsonRecord | null = null;
      await waitFor(async () => {
        try {
          const statusAfterRestart = requireRecord(
            unwrapDataKeyRpcResult(await machineRpc.call(
              route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET),
              { sessionId, operationId, revision: importRevision },
            ), 'Codex takeover status after daemon restart'),
            'Codex takeover status after daemon restart',
          );
          const progressAfterRestart = requireRecord(
            statusAfterRestart.progress,
            'Codex takeover progress after daemon restart',
          );
          if (
            statusAfterRestart.ok === true
            && progressAfterRestart.operationId === operationId
            && progressAfterRestart.revision === importRevision
            && progressAfterRestart.status === 'awaiting_user_resume'
            && progressAfterRestart.phase === 'admitting'
          ) {
            recoveredStatus = statusAfterRestart;
            return true;
          }
        } catch {
          // The replacement daemon may not have reconnected to the machine RPC route yet.
        }
        return false;
      }, {
        timeoutMs: 60_000,
        context: 'persisted takeover admission checkpoint hydrates after daemon restart',
      });
      expect(recoveredStatus).toEqual(importResumeResult);
      expect(await readFakeCodexAppServerRequestLog(appServerRequestLogPath))
        .toEqual(appServerRequestsBeforeRestart);

      const admissionResume = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME),
        { sessionId, operationId, revision: importRevision },
        180_000,
      );
      const admissionResumeResult = requireRecord(
        unwrapDataKeyRpcResult(admissionResume, 'durable Codex takeover admission resume'),
        'durable Codex takeover admission resume',
      );
      expect(admissionResumeResult).toEqual(expect.objectContaining({
        ok: true,
        progress: expect.objectContaining({
          operationId,
          status: 'completed',
          phase: 'finalizing',
          currentStorageState: 'hosted',
          checkpoint: expect.objectContaining({
            importedItemCount: 1,
            requiredItemFailures: expect.objectContaining({ total: 0 }),
          }),
        }),
      }));
      const completedProgress = requireRecord(
        admissionResumeResult.progress,
        'completed takeover progress',
      );
      const completedRevision = requireNumber(completedProgress.revision, 'completed takeover revision');
      expect(completedRevision).toBeGreaterThan(importRevision);

      await waitFor(async () => {
        const requests = await readFakeCodexAppServerRequestLog(appServerRequestLogPath);
        return requests.filter((entry) =>
          entry.method === 'thread/resume'
          && entry.params?.threadId === remoteSessionId).length === 1;
      }, {
        timeoutMs: 45_000,
        context: 'persisted takeover resumes the same Codex app-server thread exactly once',
      });

      const appServerRequests = await readFakeCodexAppServerRequestLog(appServerRequestLogPath);
      expect(appServerRequests.filter((entry) =>
        entry.method === 'thread/resume'
        && entry.params?.threadId === remoteSessionId)).toHaveLength(1);
      expect(appServerRequests.some((entry) =>
        entry.method === 'thread/interrupt'
        || entry.method === 'turn/interrupt')).toBe(false);

      const hostedMetadata = await fetchSessionMetadataV2({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        machineKeys: [auth.accountMachineKey],
      });
      expect(hostedMetadata.externalSessionV1).toBeUndefined();
      expect(hostedMetadata.externalSessionOperationV1).toEqual({
        v: 1,
        progress: completedProgress,
      });
      expect(await fetchPublicMessages({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
      })).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining(importedMarker),
        }),
      ]));

      const staleResume = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME),
        { sessionId, operationId, revision: startRevision },
      );
      expect(unwrapDataKeyRpcResult(staleResume, 'stale Codex takeover resume')).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'stale_revision' }),
      });
      expect(await readFakeCodexAppServerRequestLog(appServerRequestLogPath)).toEqual(appServerRequests);

      const terminalStatus = await machineRpc.call(
        route(RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET),
        { sessionId, operationId, revision: completedRevision },
      );
      expect(unwrapDataKeyRpcResult(terminalStatus, 'terminal Codex takeover status')).toEqual(
        admissionResumeResult,
      );
    } finally {
      ui.close();
    }
  }, 300_000);
});
