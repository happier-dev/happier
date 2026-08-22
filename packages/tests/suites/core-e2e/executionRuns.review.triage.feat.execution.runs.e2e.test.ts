import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  ExecutionRunActionResponseSchema,
  ExecutionRunGetResponseSchema,
  ExecutionRunStartResponseSchema,
  SessionUserMessageSendResponseSchema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { waitFor } from '../../src/testkit/timing';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { fetchAllMessages } from '../../src/testkit/sessions';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { callLegacyEncryptedSessionRpc as callSessionRpc } from '../../src/testkit/sessionRpc';
import { fakeClaudeLogContainsUserText } from '../../src/testkit/sessionHandoffUiMessages';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: execution runs (review) supports triage updates', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop();
  }, 60_000);

  it('emits review_findings.v2 meta and allows review.triage action overlay', async () => {
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

    const secret = Uint8Array.from(randomBytes(32));
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
    const controlToken = (daemon.state as any)?.controlToken as string | undefined;

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

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    await waitFor(() => ui.isConnected(), { timeoutMs: 20_000 });

    const started = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_START,
      req: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      },
      secret,
      schema: ExecutionRunStartResponseSchema,
      timeoutMs: 40_000,
    });

    const runId = started.runId;

    let finished: any = null;
    await waitFor(async () => {
      const res = await callSessionRpc({
        ui,
        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
        req: { runId, includeStructured: true },
        secret,
        schema: ExecutionRunGetResponseSchema,
        timeoutMs: 40_000,
      });
      if (res.run.status === 'running') return false;
      finished = res;
      return true;
    }, { timeoutMs: 60_000, intervalMs: 250 });

    expect(finished?.run?.status).toBe('succeeded');
    expect(finished?.structuredMeta?.kind).toBe('review_findings.v2');
    const payload = finished.structuredMeta.payload as any;
    expect(payload?.findings?.length ?? 0).toBeGreaterThanOrEqual(1);
    const findingId = String(payload.findings[0].id);

    const acted = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
      req: {
        runId,
        actionId: 'review.triage',
        input: {
          findings: [{ id: findingId, status: 'accept', comment: 'Looks good' }],
        },
      },
      secret,
      schema: ExecutionRunActionResponseSchema,
      timeoutMs: 40_000,
    });
    expect(acted.ok).toBe(true);

    const updated = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
      req: { runId, includeStructured: true },
      secret,
      schema: ExecutionRunGetResponseSchema,
      timeoutMs: 40_000,
    });
    expect(updated.structuredMeta?.kind).toBe('review_findings.v2');
    const updatedPayload = updated.structuredMeta?.payload as any;
    expect(updatedPayload?.triage?.findings?.[0]?.id).toBe(findingId);
    expect(updatedPayload?.triage?.findings?.[0]?.status).toBe('accept');

    // Simulate the UI "apply accepted findings" message through the live parent-agent queue.
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
    const applySend = await callSessionRpc({
      ui,
      sessionId,
      method: SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
      req: {
        text: applyText,
        localId: `review-apply-${randomUUID()}`,
        meta: { source: 'ui', sentFrom: 'e2e' },
      },
      secret,
      schema: SessionUserMessageSendResponseSchema,
      timeoutMs: 40_000,
    });
    expect(applySend.ok).toBe(true);

    await waitFor(async () => {
      const rows = await fetchAllMessages(serverBaseUrl, auth.token, sessionId);
      const decoded = rows
        .map((row) => decryptLegacyBase64(row.content.c, secret))
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
