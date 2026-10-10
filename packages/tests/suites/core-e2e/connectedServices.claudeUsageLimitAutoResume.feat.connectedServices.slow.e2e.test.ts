import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol';
import { createRecoveryIntentFileStore } from '@/daemon/connectedServices/recoveryScheduler/recoveryIntentFileStore';
import { buildRuntimeAuthRecoveryKey } from '@/daemon/connectedServices/runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import type { RuntimeAuthRecoveryIntent } from '@/daemon/connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';

import {
  CLAUDE_CODE_E2E_OAUTH_SCOPE,
  CLAUDE_SUBSCRIPTION_SERVICE_ID,
  asRecord as record,
  createConnectedServiceProfile,
  readRuntimeAuthRecoveryIntent,
  recoveryIntentPath,
  spawnConnectedClaudeSession,
  startConnectedServiceRecoveryTokenServer,
  startConnectedServicesClaudeDaemon,
  type ConnectedServiceRecoveryTokenServer,
  type StartedConnectedServicesClaudeDaemonFixture,
} from '../../src/testkit/connectedServicesRecovery';
import { fakeClaudeFixturePath, readFakeClaudeLogEvents as providerEvents } from '../../src/testkit/fakeClaude';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { enqueueEncryptedUiTextMessage } from '../../src/testkit/uiMessages';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { listPendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { sleep, waitFor } from '../../src/testkit/timing';

// Real source daemon, relay, durable scheduler, Pending admission and Agent SDK.
// Only the Claude executable and OAuth service are boundary fixtures.
const run = createRunDirs({ runLabel: 'core' });
const providerAcceptTimeoutMs = 60_000;

describe('core e2e: Claude due usage-limit continuation', () => {
  let fixture: StartedConnectedServicesClaudeDaemonFixture | null = null;
  let tokenServer: ConnectedServiceRecoveryTokenServer | null = null;
  let rpcSocket: SocketCollector | null = null;
  let pausedRunner: number | null = null;

  afterEach(async () => {
    if (pausedRunner !== null) {
      try { process.kill(pausedRunner, 'SIGCONT'); } catch { /* Runner may have exited. */ }
      pausedRunner = null;
    }
    rpcSocket?.close();
    rpcSocket = null;
    await fixture?.daemon.stop().catch(() => {});
    await fixture?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
    fixture = null;
    tokenServer = null;
  }, 60_000);

  async function startLimitedSession(options: { resumePromptMode?: 'standard' | 'custom' | 'off'; resetDelayMs?: number } = {}): Promise<{ sessionId: string; initialPrompt: string; runnerPid: number }> {
    const testDir = run.testDir(`claude-usage-limit-${randomUUID()}`);
    tokenServer = await startConnectedServiceRecoveryTokenServer({
      respond: () => ({ status: 200, body: {
        access_token: 'claude-usage-limit-access', refresh_token: 'claude-usage-limit-refresh',
        expires_in: 3600, token_type: 'Bearer', scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
      } }),
    });
    fixture = await startConnectedServicesClaudeDaemon({
      testDir, testName: 'claude-usage-limit-auto-resume', tokenUrl: tokenServer.tokenUrl,
      fakeClaudePath: fakeClaudeFixturePath(), fakeClaudeLogPath: resolve(testDir, 'fake-claude.jsonl'),
      fakeClaudeScenario: 'usage-limit-once',
      accountSettings: {
        claudeUnifiedTerminalEnabled: false,
        usageLimitRecoverySettingsV1: {
          resumePromptMode: options.resumePromptMode ?? 'standard',
          customResumePrompt: 'Continue the interrupted Claude work carefully.',
        },
      },
      serverExtraEnv: { HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED: '1' },
      extraEnv: {
        HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED: '1',
        HAPPIER_E2E_FAKE_CLAUDE_ALLOW_ACCESS_ONLY_NATIVE_OAUTH: '1',
        HAPPIER_E2E_FAKE_CLAUDE_RESET_DELAY_MS: String(options.resetDelayMs ?? 10000),
        HAPPIER_E2E_FAKE_CLAUDE_CONTINUATION_ACCEPT_SIGNAL: resolve(testDir, 'fake-claude.jsonl.accept'),
        HAPPIER_E2E_FAKE_CLAUDE_CONTINUATION_ACCEPT_TIMEOUT_MS: String(providerAcceptTimeoutMs),
      },
    });
    await createConnectedServiceProfile({
      fixture, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'work',
      providerEmail: 'claude-usage-limit@example.test', idToken: null,
      accessToken: 'claude-usage-limit-access', refreshToken: 'claude-usage-limit-refresh',
      scope: CLAUDE_CODE_E2E_OAUTH_SCOPE, tokenType: 'Bearer',
      providerAccountId: 'acct-claude-usage-limit', expiresAt: Date.now() + 3600_000,
    });
    const sessionId = await spawnConnectedClaudeSession({ fixture, sessionId: randomUUID(), profileId: 'work' });
    const initialPrompt = `CLAUDE_INTERRUPTED_WORK_${randomUUID()}`;
    await enqueueEncryptedUiTextMessage({
      baseUrl: fixture.serverBaseUrl, token: fixture.auth.token, secret: fixture.accountSecret,
      sessionId, text: initialPrompt,
    });
    await waitFor(async () => {
      const session = await fetchSessionV2(fixture!.serverBaseUrl, fixture!.auth.token, sessionId);
      const intent = await readIntent(sessionId);
      const metadata = record(decryptLegacyBase64Normalized(session.metadata, fixture!.accountSecret));
      const projection = SessionUsageLimitRecoveryV1Schema.safeParse(metadata?.sessionUsageLimitRecoveryV1);
      return session.latestTurnStatus === 'failed' && session.lastRuntimeIssue?.source === 'usage_limit'
        && intent?.status === 'waiting' && projection.success
        && projection.data.runtimeAuthRecoveryAttemptId === intent.attemptId;
    }, { timeoutMs: 60_000, context: 'SDK failure reaches durable wait and failed canonical turn' });
    const listed = await daemonControlPostJson<{ children?: Array<{ happySessionId?: string; pid?: number }> }>({
      port: fixture.daemonPort, path: '/list', controlToken: fixture.controlToken, body: {},
    });
    const child = listed.data.children?.find((item) => item.happySessionId === sessionId);
    if (typeof child?.pid !== 'number') throw new Error(`Missing healthy Claude runner: ${JSON.stringify(listed.data)}`);
    return { sessionId, initialPrompt, runnerPid: child.pid };
  }

  async function readIntent(sessionId: string) {
    if (!fixture) throw new Error('Missing Claude fixture');
    return readRuntimeAuthRecoveryIntent({
      fixture, sessionId, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'work', groupId: null,
    });
  }

  async function recoveryDiagnostics(sessionId: string): Promise<string> {
    const current = fixture!;
    const session = await fetchSessionV2(current.serverBaseUrl, current.auth.token, sessionId);
    const metadata = record(decryptLegacyBase64Normalized(session.metadata, current.accountSecret));
    const issue = session.lastRuntimeIssue;
    const intent = await readIntent(sessionId);
    return JSON.stringify({
      sessionId, latestTurnStatus: session.latestTurnStatus,
      issue: issue ? {
        source: issue.source, provider: issue.provider, providerTurnId: issue.providerTurnId,
        occurredAt: issue.occurredAt, resetAtMs: issue.usageLimit?.resetAtMs,
        connectedService: issue.usageLimit?.connectedService,
      } : null,
      bindings: metadata?.connectedServices,
      projectedRecovery: metadata?.sessionUsageLimitRecoveryV1,
      durableRecovery: intent ? {
        status: intent.status, armedAtMs: intent.armedAtMs, attemptId: intent.attemptId,
        lastError: intent.lastError, terminalReason: intent.terminalReason,
        classification: intent.classification,
      } : null,
    });
  }

  async function connectRpc(): Promise<SocketCollector> {
    if (!fixture) throw new Error('Missing Claude fixture');
    rpcSocket = createUserScopedSocketCollector(fixture.serverBaseUrl, fixture.auth.token);
    rpcSocket.connect();
    await waitFor(() => rpcSocket!.isConnected(), { timeoutMs: 20_000, context: 'recovery control transport connected' });
    return rpcSocket;
  }

  async function callRpc(targetId: string, method: string, sessionId: string, request: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    if (!fixture || !rpcSocket) throw new Error('Missing recovery RPC transport');
    const ack = await rpcSocket.rpcCall<{ ok?: boolean; result?: string; errorCode?: string; error?: string }>(
      `${targetId}:${method}`, encryptLegacyBase64({ ...request, sessionId }, fixture.accountSecret), 60_000,
      { kind: 'session.write', sessionId },
    );
    return ack.ok === true && typeof ack.result === 'string'
      ? decryptLegacyBase64Normalized(ack.result, fixture.accountSecret)
      : ack;
  }

  async function waitPastReset(sessionId: string): Promise<void> {
    const intent = await readIntent(sessionId);
    const resetAtMs = record(intent?.classification)?.resetsAtMs;
    if (typeof resetAtMs !== 'number') throw new Error(`Missing reset: ${JSON.stringify(intent)}`);
    await sleep(Math.max(0, resetAtMs - Date.now()));
  }

  async function checkNowThroughCli(sessionId: string, resumePromptMode: 'custom' | 'off', label: string): Promise<unknown> {
    const current = fixture!;
    const testDir = dirname(current.fakeClaudeLogPath);
    const env = { ...process.env, CI: '1', HAPPIER_HOME_DIR: current.daemonHomeDir,
      HAPPIER_SERVER_URL: current.serverBaseUrl, HAPPIER_WEBAPP_URL: current.serverBaseUrl,
      HAPPIER_ACTIVE_SERVER_ID: current.serverId };
    const launch = await resolveCliTestLaunchSpec({ testDir, env }, { snapshotDir: resolve(testDir, 'cli-source'), preferSourceEntrypoint: true });
    const stdoutPath = resolve(testDir, `${label}.stdout.log`);
    await runLoggedCommand({ command: launch.command,
      args: [...launch.args, 'session', 'actions', 'execute', sessionId, 'session.usageLimit.checkNow',
        '--input-json', JSON.stringify({ sessionId, resumePromptMode }), '--json'],
      cwd: launch.cwd ?? testDir, env: { ...env, ...launch.env }, stdoutPath,
      stderrPath: resolve(testDir, `${label}.stderr.log`), timeoutMs: providerAcceptTimeoutMs,
    });
    return JSON.parse(await readFile(stdoutPath, 'utf8')) as unknown;
  }

  async function deferTimerPastManualObservation(sessionId: string): Promise<void> {
    const current = fixture!;
    const store = createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(recoveryIntentPath(current));
    const recoveryKey = buildRuntimeAuthRecoveryKey({ sessionId, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'work', groupId: null });
    await store.transact!(recoveryKey, ({ intent, effectClaimToken }) => {
      if (!intent || intent.status !== 'waiting' || effectClaimToken) throw new Error('Expected an unclaimed waiting recovery');
      // Exercise a due provider reset before the local scheduled wake, using the real durable owner.
      return { intent: { ...intent, nextRetryAtMs: Date.now() + providerAcceptTimeoutMs }, effectClaimToken, result: undefined };
    });
  }

  async function expectContinued(sessionId: string): Promise<void> {
    const current = fixture!;
    try {
      await waitFor(async () => {
        const intent = await readIntent(sessionId);
        if (intent?.status === 'cancelled' || intent?.status === 'exhausted') {
          throw new Error('Due Claude recovery terminalized');
        }
        return intent?.status === 'resumed_awaiting_proof';
      }, { timeoutMs: 60_000, shouldRetryOnError: () => false, context: 'Pending continuation waits for provider outcome proof' });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; recovery=${await recoveryDiagnostics(sessionId)}`, { cause: error });
    }
    expect((await providerEvents(current.fakeClaudeLogPath)).filter((event) => event.type === 'sdk_continuation_accepted')).toHaveLength(0);
    await writeFile(`${current.fakeClaudeLogPath}.accept`, 'accept\n', 'utf8');
    await waitFor(async () => (await providerEvents(current.fakeClaudeLogPath)).some((event) => event.type === 'sdk_continuation_accepted'), {
      timeoutMs: providerAcceptTimeoutMs, context: 'due continuation accepted by Claude SDK boundary',
    });
    await waitFor(async () => (await readIntent(sessionId))?.status === 'recovered', {
      timeoutMs: 20_000, context: 'provider activity settles recovery',
    });
    const events = await providerEvents(current.fakeClaudeLogPath);
    const failure = events.find((event) => event.type === 'sdk_usage_limit');
    const accepted = events.filter((event) => event.type === 'sdk_continuation_accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.sessionId).toBe(failure?.sessionId);
    const rows = await fetchMessagesSince({ baseUrl: current.serverBaseUrl, token: current.auth.token, sessionId, afterSeq: 0 });
    expect(rows.filter((row) => row.localId?.startsWith('connected-service-continuation:'))).toHaveLength(1);
  }

  async function expectNoSyntheticAdmission(sessionId: string): Promise<void> {
    const current = fixture!;
    const query = { baseUrl: current.serverBaseUrl, token: current.auth.token, sessionId };
    const [messages, pending] = await Promise.all([
      fetchMessagesSince({ ...query, afterSeq: 0 }),
      listPendingQueueV2({ ...query, includeDiscarded: true }),
    ]);
    expect(messages.some((row) => row.localId?.startsWith('connected-service-continuation:'))).toBe(false);
    expect(pending.data.pending?.some((row) => row.localId.startsWith('connected-service-continuation:'))).toBe(false);
  }

  it('continues the failed turn after reset with the healthy runner and no UI', async () => {
    const { sessionId, initialPrompt, runnerPid } = await startLimitedSession();
    const current = fixture!;
    await expectContinued(sessionId);
    const events = await providerEvents(current.fakeClaudeLogPath);
    expect(events.filter((event) => event.type === 'sdk_stdin' && event.userTextPreview === initialPrompt)).toHaveLength(1);
    process.kill(runnerPid, 0);
  }, 360_000);

  it('resumes an absent runner using the interrupted Claude provider thread', async () => {
    const { sessionId, runnerPid } = await startLimitedSession();
    // Abrupt disappearance differs from Stop: Stop intentionally cancels recovery.
    const sdkPids = (await providerEvents(fixture!.fakeClaudeLogPath))
      .filter((event) => event.type === 'invocation' && event.mode === 'sdk')
      .map((event) => event.pid).filter((pid): pid is number => typeof pid === 'number');
    process.kill(runnerPid, 'SIGKILL');
    for (const pid of sdkPids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* SDK child may have exited with its parent. */ }
    }
    await expectContinued(sessionId);
    const listed = await daemonControlPostJson<{ children?: Array<{ happySessionId?: string; pid?: number }> }>({
      port: fixture!.daemonPort, path: '/list', controlToken: fixture!.controlToken, body: {},
    });
    const resumed = listed.data.children?.find((child) => child.happySessionId === sessionId);
    expect(resumed).toMatchObject({ pid: expect.any(Number) });
    expect(resumed?.pid).not.toBe(runnerPid);
  }, 360_000);

  it('executes public CLI Check now with an explicit custom override before the deferred timer', async () => {
    const { sessionId, runnerPid } = await startLimitedSession({ resumePromptMode: 'off' });
    await connectRpc();
    const live = record(await callRpc(sessionId, SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, sessionId));
    expect(live?.ok).toBe(false);
    expect(['unsupported_session_runtime_method', 'RPC_METHOD_NOT_AVAILABLE', 'RPC_METHOD_NOT_FOUND']).toContain(live?.errorCode ?? live?.error);
    await deferTimerPastManualObservation(sessionId);
    await waitPastReset(sessionId);
    expect((await readIntent(sessionId))?.status).toBe('waiting');
    await expectNoSyntheticAdmission(sessionId);
    const checks = await Promise.all([
      checkNowThroughCli(sessionId, 'custom', 'manual-first'),
      checkNowThroughCli(sessionId, 'custom', 'manual-second'),
    ]);
    for (const check of checks) expect(check).toMatchObject({ ok: true, data: { result: { ok: true, status: 'waiting' } } });
    await expectContinued(sessionId);
    expect((await providerEvents(fixture!.fakeClaudeLogPath)).some((event) => event.type === 'sdk_stdin'
      && typeof event.userTextPreview === 'string'
      && event.userTextPreview.includes('Continue the interrupted Claude work carefully.'))).toBe(true);
    process.kill(runnerPid, 0);
  }, 360_000);

  it.each([false, true])('qualifies a reconnected profile against the failed quota account (account replaced=%s)', async (replaceAccount) => {
    const { sessionId, runnerPid } = await startLimitedSession();
    const current = fixture!;
    const failed = await readIntent(sessionId);
    expect(record(failed?.classification)?.sourceProviderAccountId).toBe('acct-claude-usage-limit');
    const credentialRevision = await createConnectedServiceProfile({
      fixture: current, serviceId: CLAUDE_SUBSCRIPTION_SERVICE_ID, profileId: 'work',
      providerEmail: 'claude-usage-limit@example.test', idToken: null,
      accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh',
      scope: CLAUDE_CODE_E2E_OAUTH_SCOPE, tokenType: 'Bearer',
      providerAccountId: replaceAccount ? 'acct-replacement' : 'acct-claude-usage-limit',
      expiresAt: Date.now() + 3600_000, allowProviderIdentityChange: replaceAccount,
    });
    expect(credentialRevision).not.toBe(record(failed?.classification)?.credentialRevision);
    if (replaceAccount) {
      await waitPastReset(sessionId);
      const daemonLogPath = current.daemon.state.daemonLogPath;
      if (!daemonLogPath) throw new Error('Missing source-daemon diagnostic log');
      // A changed source supersedes and removes the obsolete owner so a future failure can re-arm.
      await waitFor(async () => {
        if (await readIntent(sessionId)) return false;
        const log = await readFile(daemonLogPath, 'utf8');
        return log.includes('"event":"runtime_auth_recovery_superseded"')
          && log.includes('"reason":"usage_limit_continuation_superseded"');
      }, {
        timeoutMs: providerAcceptTimeoutMs, context: 'changed quota account retires the old healthy-runner recovery owner',
      });
      expect((await providerEvents(current.fakeClaudeLogPath)).filter((event) => event.type === 'sdk_continuation_accepted')).toHaveLength(0);
      await expectNoSyntheticAdmission(sessionId);
    } else {
      await expectContinued(sessionId);
    }
    process.kill(runnerPid, 0);
  }, 360_000);

  it('keeps a cancelled recovery terminal when Check now sees the old failed turn', async () => {
    const { sessionId } = await startLimitedSession();
    await connectRpc();
    const current = fixture!;
    const session = await fetchSessionV2(current.serverBaseUrl, current.auth.token, sessionId);
    const metadata = record(decryptLegacyBase64Normalized(session.metadata, current.accountSecret));
    const recovery = SessionUsageLimitRecoveryV1Schema.parse(metadata?.sessionUsageLimitRecoveryV1);
    const cancelled = await callRpc(current.machineId, RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL, sessionId, {
      issueFingerprint: recovery.issueFingerprint,
      armedAtMs: recovery.armedAtMs,
      runtimeAuthRecoveryAttemptId: recovery.runtimeAuthRecoveryAttemptId,
    });
    expect(cancelled).toMatchObject({ ok: true, status: 'cancelled' });
    await waitFor(async () => (await readIntent(sessionId))?.status === 'cancelled', { timeoutMs: 10_000, context: 'explicit recovery cancellation persisted' });
    await waitPastReset(sessionId);
    await callRpc(fixture!.machineId, RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW, sessionId);
    await sleep(1000);
    expect((await readIntent(sessionId))?.status).toBe('cancelled');
    expect((await providerEvents(fixture!.fakeClaudeLogPath)).filter((event) => event.type === 'sdk_continuation_accepted')).toHaveLength(0);
    await expectNoSyntheticAdmission(sessionId);
  }, 360_000);

  it('keeps resumePromptMode off passive when reset becomes due', async () => {
    const { sessionId } = await startLimitedSession({ resumePromptMode: 'off' });
    expect((await readIntent(sessionId))?.resumePromptMode).toBe('off');
    await waitPastReset(sessionId);
    await waitFor(async () => (await readIntent(sessionId))?.status === 'cancelled', {
      timeoutMs: 15_000, context: 'disabled prompt mode settles without continuation',
    });
    const current = fixture!;
    expect((await providerEvents(current.fakeClaudeLogPath)).filter((event) => event.type === 'sdk_continuation_accepted')).toHaveLength(0);
    await expectNoSyntheticAdmission(sessionId);
  }, 360_000);

  it.skipIf(process.platform === 'win32')('suppresses continuation while newer explicit user input remains queued', async () => {
    const { sessionId, runnerPid } = await startLimitedSession();
    process.kill(runnerPid, 'SIGSTOP');
    pausedRunner = runnerPid;
    const current = fixture!;
    await enqueueEncryptedUiTextMessage({
      baseUrl: current.serverBaseUrl, token: current.auth.token, secret: current.accountSecret,
      sessionId, text: `NEWER_EXPLICIT_WORK_${randomUUID()}`,
    });
    const queued = await listPendingQueueV2({ baseUrl: current.serverBaseUrl, token: current.auth.token, sessionId });
    expect(queued.data.pending?.some((row) => row.status === 'queued')).toBe(true);
    await waitPastReset(sessionId);
    await waitFor(async () => (await readIntent(sessionId))?.status === 'cancelled', {
      timeoutMs: 15_000, context: 'queued explicit user input suppresses obsolete continuation',
    });
    expect((await providerEvents(current.fakeClaudeLogPath)).filter((event) => event.type === 'sdk_continuation_accepted')).toHaveLength(0);
    await expectNoSyntheticAdmission(sessionId);
  }, 360_000);
});
