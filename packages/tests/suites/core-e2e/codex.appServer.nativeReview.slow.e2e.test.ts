import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  ExecutionRunActionResponseSchema,
  ExecutionRunGetResponseSchema,
  ExecutionRunStartResponseSchema,
  type ExecutionRunGetResponse,
} from '@happier-dev/protocol';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { openSessionStoredContent } from '../../../../apps/cli/src/session/transport/encryption/sessionStoredContentCodec';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { readDecryptedSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';
import { unwrapSerializedJsonValue } from '../../src/testkit/unwrapSerializedJsonValue';
import { waitFor } from '../../src/testkit/timing';
import {
  readFakeCodexAppServerRequestLog,
  writeFakeCodexAppServerScript,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { fetchAllSidechainMessages } from '../../src/testkit/sessions';

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

describe('core e2e: Codex app-server native review', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
    daemon = null;
    server = null;
  });

  it('runs Codex generic reviews with canonical JSON through public Actions', async () => {
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

    await seedCliAuthForTestAccount({ cliHome: daemonHomeDir, serverUrl: serverBaseUrl, auth, mode: 'legacy' });

    const requestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
    const fakeAppServer = await writeFakeCodexAppServerScript({ dir: testDir, requestLogPath,
      assistantReply: JSON.stringify({ summary: nativeReviewTextMarker, overviewMarkdown: nativeReviewTextMarker,
        findings: [{ id: 'schema-review-finding', title: 'Duplicate assistant text', severity: 'medium', category: 'correctness',
          summary: 'Persist the final assistant answer once.', filePath: '/fake/workspace/src/nativeReview.ts', startLine: 12, endLine: 14 }],
        questions: [], assumptions: [], reviewOutcome: 'complete' }),
    });
    const codexEnv = {
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_CODEX_PATH: fakeAppServer,
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
    const spawnRes = await daemonControlPostJson<{
      success?: boolean; sessionId?: string; errorCode?: string; errorMessage?: string;
    }>({
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

    expect(spawnRes.status, JSON.stringify({
      errorCode: spawnRes.data?.errorCode, errorMessage: spawnRes.data?.errorMessage,
    })).toBe(200);
    expect(spawnRes.data?.success).toBe(true);
    const sessionId = spawnRes.data?.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    const ui = await connectUiPersonActionClient({ serverUrl: serverBaseUrl, accountSecret: auth.accountSigningSeed });

    try {
      const content = await readDecryptedSessionMetadataV2({
        baseUrl: serverBaseUrl, token: auth.token, sessionId, machineKeys: [auth.accountMachineKey],
      });
      if (!content.selectedSecret) throw new Error('Created Session content key is unavailable');
      const contentKey = content.selectedSecret;
      const readContent = (value: unknown) => unwrapSerializedJsonValue(openSessionStoredContent({
        mode: 'e2ee', ctx: { encryptionKey: contentKey,
          encryptionVariant: content.selectedUsesDataKeyVariant ? 'dataKey' : 'legacy' }, content: value,
      }));
      const act = async (actionId: 'execution.run.start' | 'execution.run.get' | 'execution.run.action', input: unknown) => {
        const result = await ui.execute(actionId, input, { defaultSessionId: sessionId });
        if (!result.ok) throw new Error(JSON.stringify(result));
        return result.result;
      };

      const instructions = [
        'Review the app-server native review integration.',
        'Focus on avoiding duplicated final assistant text.',
      ].join('\n');

      const started = ExecutionRunStartResponseSchema.parse(await act('execution.run.start', {
        sessionId,
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
      }));

      let requests = await readFakeCodexAppServerRequestLog(requestLogPath);
      await waitFor(async () => {
        requests = await readFakeCodexAppServerRequestLog(requestLogPath);
        return requests.some((entry) => entry.method === 'review/start' || entry.method === 'turn/start');
      }, {
        timeoutMs: 45_000,
        intervalMs: 250,
        context: 'Codex app-server receives first review turn request',
      });
      // REVIEWS-1117 P01 U2: the native catalog projects this offered model's
      // structured JSON support through the Agent's declared contract.
      expect(requests.filter((entry) => entry.method === 'review/start')).toHaveLength(0);
      const turnStarts = requests.filter((entry) => entry.method === 'turn/start');
      expect(turnStarts).toHaveLength(1);
      expect(turnStarts[0]?.params).toEqual(expect.objectContaining({
        threadId: expect.any(String),
        input: expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('Review the app-server native review integration.') })]),
      }));

      let finished: ExecutionRunGetResponse | undefined;
      await waitFor(async () => {
        const res = ExecutionRunGetResponseSchema.parse(await act('execution.run.get', {
          sessionId, runId: started.runId, includeStructured: true,
        }));
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
        .map((row) => readContent(row.content))
        .map(readCodexMessageText)
        .filter((message): message is string => typeof message === 'string' && message.includes(nativeReviewTextMarker));
      expect(reviewMessages).toHaveLength(1);
      expect(turnStarts[0]?.params).toHaveProperty('outputSchema', expect.objectContaining({
        type: 'object', properties: expect.objectContaining({ findings: expect.any(Object) }),
      }));

      const findingId = String((payload?.findings?.[0] as { id?: unknown } | undefined)?.id ?? '');
      expect(findingId).not.toBe('');

      const acted = ExecutionRunActionResponseSchema.parse(await act('execution.run.action', {
        sessionId,
        runId: started.runId,
        actionId: 'review.triage',
        input: {
          findings: [{ id: findingId, status: 'accept', comment: 'Confirmed in native Codex review e2e' }],
        },
      }));
      expect(acted.ok).toBe(true);
    } finally {
      await ui.close();
    }
  }, 240_000);
});
