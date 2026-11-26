import { afterAll, describe, expect, it } from 'vitest';
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
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { fetchAllMessages } from '../../src/testkit/sessions';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { readDecryptedSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';
import { unwrapSerializedJsonValue } from '../../src/testkit/unwrapSerializedJsonValue';
import { fakeClaudeLogContainsUserText } from '../../src/testkit/sessionHandoffUiMessages';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: execution runs (review) supports triage updates', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | null = null;

  afterAll(async () => {
    await ui?.close();
    await daemon?.stop().catch(() => {});
    await server?.stop();
  }, 60_000);

  it('emits review_findings.v2 meta and accepts review.triage without rewriting the result', async () => {
    const testDir = run.testDir(`execution-runs-review-triage-${randomUUID()}`);
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

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLog = resolve(join(testDir, 'fake-claude.jsonl'));

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      startupTimeoutMs: 90_000,
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
        HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
        HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'review-json',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });
    const controlToken = (daemon.state as { controlToken?: string }).controlToken;

    const spawnRes = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
        body: {
          directory: workspaceDir,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          terminal: { mode: 'plain' },
          environmentVariables: {
            HAPPIER_HOME_DIR: daemonHomeDir,
            HAPPIER_SERVER_URL: serverBaseUrl,
            HAPPIER_WEBAPP_URL: serverBaseUrl,
            HAPPIER_VARIANT: 'dev',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_CLAUDE_PATH: fakeClaudePath,
            HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
            HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: '1',
            HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'review-json',
          },
      },
    });

    expect(spawnRes.status, JSON.stringify(spawnRes.data, null, 2)).toBe(200);
    expect(spawnRes.data.success).toBe(true);
    const sessionId = spawnRes.data.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    const actions = await connectUiPersonActionClient({ serverUrl: serverBaseUrl, accountSecret: auth.accountSigningSeed });
    ui = actions;
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
      const result = await actions.execute(actionId, input, { sessionId });
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.result;
    };

    const started = ExecutionRunStartResponseSchema.parse(await act('execution.run.start', {
        sessionId,
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        modelId: 'claude-sonnet-4-5',
        connectedServices: null,
        instructions: 'Review this repository.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        // Mirrors the UI/voice/MCP action contract fan-out behavior:
        // execution-run substrate stays generic, while the review domain can interpret intentInput.
        intentInput: {
          engineId: 'claude',
          engineIds: ['claude'],
          instructions: 'Review this repository.',
          changeType: 'committed',
          base: { kind: 'none' },
        },
    }));

    const runId = started.runId;

    const completion: { result?: ExecutionRunGetResponse } = {};
    await waitFor(async () => {
      const res = ExecutionRunGetResponseSchema.parse(await act('execution.run.get', {
        sessionId, runId, includeStructured: true,
      }));
      if (res.run.status === 'running') return false;
      completion.result = res;
      return true;
    }, { timeoutMs: 60_000, intervalMs: 250 });

    const finishedRun = completion.result;
    if (!finishedRun) throw new Error('Review run did not finish');
    expect(finishedRun.run.status).toBe('succeeded');
    expect(finishedRun.structuredMeta?.kind).toBe('review_findings.v2');
    const payload = finishedRun.structuredMeta?.payload as any;
    expect(payload?.findings?.length ?? 0).toBeGreaterThanOrEqual(1);
    const findingId = String(payload.findings[0].id);

    const acted = ExecutionRunActionResponseSchema.parse(await act('execution.run.action', {
        sessionId,
        runId,
        actionId: 'review.triage',
        input: {
          findings: [{ id: findingId, status: 'accept', comment: 'Looks good' }],
        },
    }));
    expect(acted.ok).toBe(true);

    const updated = ExecutionRunGetResponseSchema.parse(await act('execution.run.get', {
      sessionId, runId, includeStructured: true,
    }));
    expect(updated.structuredMeta?.kind).toBe('review_findings.v2');
    const updatedPayload = updated.structuredMeta?.payload as any;
    // The decision lives in the finding's ReviewComment; the review result itself is never rewritten.
    expect(updatedPayload?.triage).toBeUndefined();

    // Deliver the finding summary as ordinary parent-agent input; this is not a Review.apply invocation.
    const applyPayload = {
      runId,
      callId: String((updated.structuredMeta?.payload as any)?.runRef?.callId ?? ''),
      acceptedFindingIds: [findingId],
      acceptedFindings: [
        {
          id: findingId,
          title: String(payload.findings[0].title ?? ''),
          summary: String(payload.findings[0].summary ?? ''),
        },
      ],
    };
    const applyText = `@happier/review.apply_accepted_findings\n${JSON.stringify(applyPayload)}`;
    const applySend = await actions.submitSessionMessage(sessionId, applyText);
    expect(applySend.type).toBe('success');

    await waitFor(async () => {
      const rows = await fetchAllMessages(serverBaseUrl, auth.token, sessionId);
      const decoded = rows
        .map((row) => readContent(row.content))
        .filter(Boolean) as any[];

      const applyMessage = decoded.find((m) => {
        const inlineText = typeof m?.text === 'string' ? m.text : null;
        const contentText =
          m?.content && typeof m.content === 'object' && typeof (m.content as any).text === 'string'
            ? String((m.content as any).text)
            : null;
        const text = inlineText ?? contentText;
        return typeof text === 'string' && text.includes('@happier/review.apply_accepted_findings');
      });
      return Boolean(applyMessage);
    }, { timeoutMs: 30_000, intervalMs: 250 });

    await waitFor(
      () => fakeClaudeLogContainsUserText(fakeClaudeLog, '@happier/review.apply_accepted_findings'),
      { timeoutMs: 30_000, intervalMs: 250 },
    );
  }, 300_000);
});
