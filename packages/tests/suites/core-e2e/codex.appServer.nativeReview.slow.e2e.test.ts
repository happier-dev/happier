import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  ExecutionRunActionResponseSchema,
  ExecutionRunGetResponseSchema,
  ExecutionRunStartResponseSchema,
  SessionUserMessageSendResponseSchema,
  type ExecutionRunGetResponse,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { callLegacyEncryptedSessionRpc as callSessionRpc } from '../../src/testkit/sessionRpc';
import { waitFor } from '../../src/testkit/timing';
import {
  readFakeCodexAppServerRequestLog,
  writeFakeCodexAppServerScript,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { fetchAllMessages, fetchAllSidechainMessages } from '../../src/testkit/sessions';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';

const run = createRunDirs({ runLabel: 'core' });
const nativeReviewTextMarker = 'Native Codex review completed.';

function readCodexMessageText(record: unknown): string | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const content = (record as { content?: unknown }).content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const data = (content as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

function readHappierMeta(record: unknown): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const meta = (record as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  return (meta as { happier?: unknown }).happier ?? null;
}

describe('core e2e: Codex app-server native review', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
    daemon = null;
    server = null;
  });

  it('routes Codex review runs through native review/start', async () => {
    const testDir = run.testDir(`codex-app-server-native-review-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, token: auth.token, secret });

    const requestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
    const fakeAppServer = await writeFakeCodexAppServerScript({ dir: testDir, requestLogPath });
    const codexEnv = {
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
      HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
      HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };
    const daemonEnv = {
      ...process.env,
      ...codexEnv,
    };

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });
    const controlToken = (daemon.state as { controlToken?: string }).controlToken;
    const spawnRes = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        agent: 'codex',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        codexBackendMode: 'appServer',
        terminal: { mode: 'plain' },
        environmentVariables: codexEnv,
      },
      timeoutMs: 60_000,
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data?.success).toBe(true);
    const sessionId = spawnRes.data?.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), {
        timeoutMs: 20_000,
        context: 'Codex native review e2e UI socket connects',
      });

      const instructions = [
        'Review the app-server native review integration.',
        'Focus on avoiding duplicated final assistant text.',
      ].join('\n');

      const started = await callSessionRpc({
        ui,
        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_START,
        req: {
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions,
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
          intentInput: {
            engineId: 'codex',
            engineIds: ['codex'],
            instructions,
            changeType: 'committed',
            base: { kind: 'none' },
          },
        },
        secret,
        schema: ExecutionRunStartResponseSchema,
        timeoutMs: 40_000,
      });

      let requests = await readFakeCodexAppServerRequestLog(requestLogPath);
      await waitFor(async () => {
        requests = await readFakeCodexAppServerRequestLog(requestLogPath);
        return requests.some((entry) => entry.method === 'review/start' || entry.method === 'turn/start');
      }, {
        timeoutMs: 45_000,
        intervalMs: 250,
        context: 'Codex app-server receives first review turn request',
      });
      const reviewStarts = requests.filter((entry) => entry.method === 'review/start');
      expect(reviewStarts).toHaveLength(1);
      expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(0);
      expect(reviewStarts[0]?.params).toEqual(expect.objectContaining({
        threadId: expect.any(String),
        delivery: 'inline',
        target: expect.objectContaining({
          type: 'custom',
          instructions: expect.stringContaining('Review the app-server native review integration.'),
        }),
      }));

      let finished: ExecutionRunGetResponse | undefined;
      await waitFor(async () => {
        const res = await callSessionRpc({
          ui,
          sessionId,
          method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
          req: { runId: started.runId, includeStructured: true },
          secret,
          schema: ExecutionRunGetResponseSchema,
          timeoutMs: 40_000,
        });
        if (res.run.status === 'running') return false;
        finished = res;
        return true;
      }, {
        timeoutMs: 90_000,
        intervalMs: 250,
        context: 'Codex native review execution run finishes',
      });

      const finishedRun = finished;
      if (!finishedRun) {
        throw new Error('Codex native review execution run did not finish');
      }
      expect(finishedRun.run.status).toBe('succeeded');
      expect(finishedRun.run.intent).toBe('review');
      expect(finishedRun.structuredMeta?.kind).toBe('review_findings.v2');
      expect(finishedRun.run.availableActionIds).toContain('review.triage');

      const payload = finishedRun.structuredMeta?.payload as { findings?: unknown[]; overviewMarkdown?: unknown } | undefined;
      expect(payload?.findings?.length ?? 0).toBe(1);
      expect(String(payload?.overviewMarkdown ?? '')).toContain(nativeReviewTextMarker);

      const sidechainRows = await fetchAllSidechainMessages({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        sidechainId: started.sidechainId,
      });
      const reviewMessages = sidechainRows
        .map((row) => decryptLegacyBase64Normalized(row.content.c, secret))
        .map(readCodexMessageText)
        .filter((message): message is string => typeof message === 'string' && message.includes(nativeReviewTextMarker));
      expect(reviewMessages).toHaveLength(1);

      const findingId = String((payload?.findings?.[0] as { id?: unknown } | undefined)?.id ?? '');
      expect(findingId).not.toBe('');

      const acted = await callSessionRpc({
        ui,
        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
        req: {
          runId: started.runId,
          actionId: 'review.triage',
          input: {
            findings: [{ id: findingId, status: 'accept', comment: 'Confirmed in native Codex review e2e' }],
          },
        },
        secret,
        schema: ExecutionRunActionResponseSchema,
        timeoutMs: 40_000,
      });
      expect(acted.ok).toBe(true);

      const inlineReviewResult = await callSessionRpc({
        ui,
        sessionId,
        method: SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
        req: {
          text: '/codex.review focus on inline regressions',
          localId: `inline-review-${randomUUID()}`,
          meta: { source: 'codex-native-review-e2e' },
        },
        secret,
        schema: SessionUserMessageSendResponseSchema,
        timeoutMs: 40_000,
      });
      expect(inlineReviewResult.ok).toBe(true);

      await waitFor(async () => {
        requests = await readFakeCodexAppServerRequestLog(requestLogPath);
        return requests.filter((entry) => entry.method === 'review/start').length >= 2;
      }, {
        timeoutMs: 45_000,
        intervalMs: 250,
        context: 'Codex app-server receives inline review command request',
      });

      const inlineReviewStarts = requests.filter((entry) => entry.method === 'review/start');
      expect(inlineReviewStarts[1]?.params).toEqual(expect.objectContaining({
        threadId: expect.any(String),
        delivery: 'inline',
        target: expect.objectContaining({
          type: 'custom',
          instructions: expect.stringContaining('focus on inline regressions'),
        }),
      }));

      await waitFor(async () => {
        const mainRows = await fetchAllMessages(serverBaseUrl, auth.token, sessionId);
        const decoded = mainRows.map((row) => decryptLegacyBase64Normalized(row.content.c, secret));
        return decoded.some((record) => {
          const text = readCodexMessageText(record);
          const meta = readHappierMeta(record) as { kind?: unknown; payload?: { runRef?: { runId?: unknown }; overviewMarkdown?: unknown } } | null;
          return text?.includes(nativeReviewTextMarker)
            && meta?.kind === 'review_findings.v2'
            && typeof meta.payload?.runRef?.runId === 'string'
            && meta.payload.runRef.runId.startsWith(`session-review:${sessionId}:`)
            && String(meta.payload.overviewMarkdown ?? '').includes(nativeReviewTextMarker);
        });
      }, {
        timeoutMs: 45_000,
        intervalMs: 250,
        context: 'Inline Codex review command commits structured review findings to main transcript',
      });
    } finally {
      ui.close();
    }
  }, 240_000);
});
