import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, buildUsageLimitIssueFingerprint, FeaturesResponseSchema,
  SessionUsageLimitRecoveryV1Schema, V2SessionRecordSchema, type AccountSettings,
  type SessionRuntimeIssueV1, type SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Credentials } from '@/persistence';
import type { Metadata } from '@/api/types';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { continueSessionAfterUsageLimitReset } from '@/daemon/connectedServices/continuation/continueSessionAfterUsageLimitReset';
import { routeSessionUsageLimitRecoveryCheckNow } from './sessionUsageLimitRecoveryControlRouter';
import { createSessionUsageLimitRecoveryRuntime } from './createSessionUsageLimitRecoveryRuntime';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import * as accountSettingsCache from '@/settings/accountSettings/accountSettingsCache';
import { DEFAULT_USAGE_LIMIT_CHECK_NOW_THROTTLE_MS } from './usageLimitCheckNowRateLimiter';
import { createCodexAppServerRuntime } from '@/backends/codex/appServer/runtime';
import { createCodexAppServerProcessEnv, createCodexAppServerTestEnvScope, writeFakeCodexAppServerScript } from '@/backends/codex/appServer/testkit/fakeCodexAppServer';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { waitForCondition } from '@/testkit/async/waitFor';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { hasSameUsageLimitRecoveryIdentity } from './mergeUsageLimitRecoveryIntent';
import { DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS } from './createBackoffSessionUsageLimitRecoveryControlAdapter';

const network = vi.hoisted(() => ({ fetchSessionById: vi.fn(), enqueue: vi.fn(), rpc: vi.fn(), socket: vi.fn() }));
// Only the relay network is replaced; routing, metadata convergence, timing, and Pending admission are real.
vi.mock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionById: network.fetchSessionById }));
vi.mock('@/api/session/sockets', () => ({ createSessionScopedSocket: network.socket }));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({ enqueuePendingQueueV2MessageViaHttp: network.enqueue }));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: network.rpc }));

const credentials: Credentials = { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } };
const sessionId = 'c123456789012345678901234';
const issue: SessionRuntimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit',
  source: 'usage_limit', provider: 'gemini', providerTurnId: 'interrupted-turn', occurredAt: 100,
  usageLimit: { v: 1, resetAtMs: 200, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } };

function createRawSession(metadata: Record<string, unknown>, overrides: Partial<RawSessionRecord> = {}): RawSessionRecord {
  return V2SessionRecordSchema.parse({ id: sessionId, seq: 1, createdAt: 0, updatedAt: 100, active: true,
    activeAt: 100, metadata: JSON.stringify(metadata), metadataVersion: 1, encryptionMode: 'plain',
    agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
    latestTurnStatus: 'failed', latestTurnId: 'failed-turn', lastRuntimeIssue: issue, ...overrides });
}

let fixtureSequence = 3;

function createLiveFixture(options: Readonly<{
  metadata?: Partial<Metadata>;
  issue?: SessionRuntimeIssueV1;
  settings?: AccountSettings;
}> = {}) {
  const fixtureSessionId = `c${String(fixtureSequence++).padStart(23, '0')}`;
  let metadata = createTestMetadata({ path: '/project', machineId: 'machine-local', flavor: 'gemini', ...options.metadata });
  const rawSession = createRawSession(metadata, { id: fixtureSessionId, lastRuntimeIssue: options.issue ?? issue });
  network.fetchSessionById.mockImplementation(async () => ({ ...rawSession, metadata: JSON.stringify(metadata) }));
  network.socket.mockImplementation(() => createApiSessionSocketStub({ connected: true,
    emit: (event, args) => {
      if (event !== 'update-metadata') throw new Error(`Unexpected network event ${event}`);
      const update = args[0] as { metadata: string; expectedVersion: number };
      const acknowledge = args[1];
      if (update.expectedVersion !== rawSession.metadataVersion) {
        if (typeof acknowledge === 'function') acknowledge({ result: 'version-mismatch',
          version: rawSession.metadataVersion, metadata: JSON.stringify(metadata) });
        return;
      }
      metadata = JSON.parse(update.metadata);
      rawSession.metadataVersion = update.expectedVersion + 1;
      if (typeof acknowledge === 'function') acknowledge({ result: 'success', version: rawSession.metadataVersion, metadata: update.metadata });
    },
  }));
  const updateMetadata = async (update: (current: Metadata) => Metadata) => {
    metadata = update(metadata);
    rawSession.metadataVersion += 1;
  };
  const updateMetadataWithResult = async <TResult>(update: (current: Metadata) => Readonly<{
    metadata: Metadata;
    result: TResult;
  }>): Promise<TResult> => {
    const updated = update(metadata);
    metadata = updated.metadata;
    rawSession.metadataVersion += 1;
    return updated.result;
  };
  const runtime = createSessionUsageLimitRecoveryRuntime({ sessionId: fixtureSessionId, getMetadata: () => metadata,
    updateMetadata, getCredentials: async () => credentials,
    getAccountSettings: () => options.settings ?? null });
  return { runtime, rawSession, sessionId: fixtureSessionId, getMetadata: () => metadata, updateMetadata, updateMetadataWithResult,
    readRecovery: () => SessionUsageLimitRecoveryV1Schema.parse(metadata.sessionUsageLimitRecoveryV1) };
}

async function createQuotaProbeServer(root: string, usedPercent: number, resetAtMs: number) {
  const requestLog = join(root, 'requests.jsonl');
  const script = await writeFakeCodexAppServerScript({ dir: root,
    importLines: ['import { appendFile } from "node:fs/promises";'],
    bodyLines: [
      'for await (const line of rl) {',
      '  if (!line.trim()) continue;',
      '  const msg = JSON.parse(line);',
      `  if (msg.method) await appendFile(${JSON.stringify(requestLog)}, JSON.stringify(msg) + "\\n");`,
      '  if (msg.id === undefined) continue;',
      '  const result = msg.method === "initialize" ? { serverInfo: { name: "fake-codex", version: "0.0.0" } }',
      `    : msg.method === "account/rateLimits/read" ? { rateLimits: { primary: { usedPercent: ${usedPercent}, resetsAt: ${resetAtMs / 1_000} } } } : {};`,
      '  process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");',
      '}',
    ],
  });
  return { script, requestLog };
}

describe('generic usage-limit continuation through the session control boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    network.enqueue.mockResolvedValue({ didWrite: true, terminal: false });
    network.rpc.mockResolvedValue({ ok: true });
    const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true,
      usageLimitRecovery: { enabled: true } } }, capabilities: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200 })));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); });

  it('continues a due native failed turn through Pending when its provider has no quota probe', async () => {
    const recovery: SessionUsageLimitRecoveryV1 = { v: 1, status: 'waiting',
      issueFingerprint: buildUsageLimitIssueFingerprint(issue), armedAtMs: 100, resetAtMs: 200, nextCheckAtMs: 200,
      attemptCount: 0, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'standard', selectedAuth: { kind: 'native' } };
    let metadata: Record<string, unknown> = { machineId: 'machine-local', flavor: 'gemini', path: '/project',
      sessionUsageLimitRecoveryV1: recovery };
    const rawSession = createRawSession(metadata);
    network.fetchSessionById.mockImplementation(async () => ({ ...rawSession, metadata: JSON.stringify(metadata) }));
    network.socket.mockImplementation(() => createApiSessionSocketStub({ connected: true,
      emit: (event, args) => {
        if (event !== 'update-metadata') throw new Error(`Unexpected network event ${event}`);
        const update = args[0] as { metadata: string; expectedVersion: number };
        metadata = JSON.parse(update.metadata) as Record<string, unknown>;
        const acknowledge = args[1];
        if (typeof acknowledge === 'function') acknowledge({ result: 'success', version: update.expectedVersion + 1, metadata: update.metadata });
      },
    }));
    const result = await routeSessionUsageLimitRecoveryCheckNow({ credentials, token: credentials.token, sessionId,
      rawSession, metadata, currentMachineId: 'machine-local', mode: 'plain',
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      callLiveSessionRpc: async () => ({ ok: false, errorCode: 'unsupported_session_runtime_method' }),
      resumeInactiveSessionWhenReady: async ({ rawSession: current, metadata: latest }) => {
        const intent = latest.sessionUsageLimitRecoveryV1 as SessionUsageLimitRecoveryV1;
        return (await continueSessionAfterUsageLimitReset({ credentials, sessionId, rawSession: current, metadata: latest,
          recovery: intent, nowMs: Date.now(), isCurrent: () => true, ensureRuntime: async () => true })).status === 'continued';
      },
    });
    expect(result).toMatchObject({ ok: true, status: 'resumed' });
    expect(network.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId, body: expect.objectContaining({
      deliveryMode: 'continuation_if_no_queued_user_input',
      content: { t: 'plain', v: expect.objectContaining({ content: { type: 'text', text: 'Usage limits are lifted. Continue where you left off.' } }) },
    }) }));
    expect(network.rpc).toHaveBeenCalledWith(expect.objectContaining({ method: `${sessionId}:session.pendingQueue.wake.v1` }));
  });

  it('uses the shared live runtime to continue native work without a provider thread-resume operation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300);
    const liveSessionId = 'c223456789012345678901234';
    let metadata = createTestMetadata({ path: '/project', machineId: 'machine-local', flavor: 'gemini' });
    const rawSession = createRawSession(metadata, { id: liveSessionId });
    network.fetchSessionById.mockImplementation(async () => ({ ...rawSession, metadata: JSON.stringify(metadata) }));
    network.socket.mockImplementation(() => createApiSessionSocketStub({ connected: true,
      emit: (_event, args) => {
        const update = args[0] as { metadata: string; expectedVersion: number };
        metadata = JSON.parse(update.metadata);
        const acknowledge = args[1];
        if (typeof acknowledge === 'function') acknowledge({ result: 'success', version: update.expectedVersion + 1, metadata: update.metadata });
      },
    }));
    const runtime = createSessionUsageLimitRecoveryRuntime({ sessionId: liveSessionId, getMetadata: () => metadata,
      updateMetadata: async (update) => { metadata = update(metadata); }, getCredentials: async () => credentials,
      getAccountSettings: () => null });
    try {
      expect(await runtime.controls.enableUsageLimitWaitResume({ sessionId: liveSessionId })).toMatchObject({ ok: true });
      expect(await runtime.controls.checkUsageLimitRecoveryNow({ sessionId: liveSessionId })).toMatchObject({ ok: true, status: 'resumed' });
      expect(network.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sessionId: liveSessionId }));
      expect(metadata.sessionUsageLimitRecoveryV1).toMatchObject({ status: 'cancelled' });
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it('continues through the real registered session RPC controls with no provider-owned handler', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(300);
    const fixture = createLiveFixture();
    const rpc = new RpcHandlerManager({ scopePrefix: fixture.sessionId, encryptionKey: null,
      encryptionVariant: 'plain', encryptionMode: 'plain', logger: () => {} });
    const registration = registerSessionHandlers(rpc, '/project', { getSessionMetadata: fixture.getMetadata,
      updateSessionMetadata: fixture.updateMetadata, sessionRuntimeControls: fixture.runtime.controls });
    try {
      expect(await rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
        { sessionId: fixture.sessionId })).toMatchObject({ ok: true });
      expect(await rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
        { sessionId: fixture.sessionId })).toMatchObject({ ok: true, status: 'resumed' });
      expect(fixture.readRecovery().status).toBe('cancelled');
      expect(network.enqueue).toHaveBeenCalledOnce();
    } finally { registration.dispose(); rpc.clearHandlers(); fixture.runtime.dispose(); }
  });

  it('cancels a runtime-auth-owned recovery through registered RPC metadata ownership when generic controls exist', async () => {
    const fixture = createLiveFixture({ metadata: { sessionUsageLimitRecoveryV1: {
      v: 1, status: 'waiting', issueFingerprint: 'linked-failure', runtimeAuthRecoveryAttemptId: 'credential-attempt',
      armedAtMs: 100, resetAtMs: 200, nextCheckAtMs: 200, attemptCount: 0, maxAttempts: 3,
      lastProbeError: null, resumePromptMode: 'standard', selectedAuth: { kind: 'native' },
    } } });
    const rpc = new RpcHandlerManager({ scopePrefix: fixture.sessionId, encryptionKey: null,
      encryptionVariant: 'plain', encryptionMode: 'plain', logger: () => {} });
    const notify = vi.fn(async () => {});
    const registration = registerSessionHandlers(rpc, '/project', { getSessionMetadata: fixture.getMetadata,
      updateSessionMetadata: fixture.updateMetadata, updateSessionMetadataWithResult: fixture.updateMetadataWithResult,
      sessionRuntimeControls: fixture.runtime.controls, notifyUsageLimitWaitResumeCancelled: notify });
    try {
      expect(await rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL, {
        sessionId: fixture.sessionId, issueFingerprint: 'linked-failure', armedAtMs: 100,
        runtimeAuthRecoveryAttemptId: 'credential-attempt',
      })).toMatchObject({ ok: true });
      expect(fixture.readRecovery()).toMatchObject({ status: 'cancelled', nextCheckAtMs: null,
        runtimeAuthRecoveryAttemptId: 'credential-attempt' });
      expect(notify).toHaveBeenCalledWith({ sessionId: fixture.sessionId, attemptId: 'credential-attempt' });
      expect(network.enqueue).not.toHaveBeenCalled();
    } finally { registration.dispose(); rpc.clearHandlers(); fixture.runtime.dispose(); }
  });

  it.each([true, false])('refreshes registered recovery RPC admission after the canonical feature decision changes from %s', async (initiallyEnabled) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(300);
    let enabled = initiallyEnabled;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, usageLimitRecovery: { enabled } } }, capabilities: {},
    })), { status: 200 })));
    const futureIssue: SessionRuntimeIssueV1 = { ...issue, usageLimit: { ...issue.usageLimit!, resetAtMs: 2_000 } };
    const fixture = createLiveFixture({ issue: futureIssue });
    const rpc = new RpcHandlerManager({ scopePrefix: fixture.sessionId, encryptionKey: null,
      encryptionVariant: 'plain', encryptionMode: 'plain', logger: () => {} });
    const registration = registerSessionHandlers(rpc, '/project', { getSessionMetadata: fixture.getMetadata,
      updateSessionMetadata: fixture.updateMetadata, sessionRuntimeControls: fixture.runtime.controls });
    try {
      const enable = () => rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE, { sessionId: fixture.sessionId });
      expect(await enable()).toMatchObject(initiallyEnabled ? { ok: true, status: 'waiting' } : { ok: false, errorCode: 'feature_disabled' });
      enabled = !initiallyEnabled;
      resetServerFeaturesClientForTests();
      expect(await enable()).toMatchObject(enabled ? { ok: true, status: 'waiting' } : { ok: false, errorCode: 'feature_disabled' });
      expect(network.enqueue).not.toHaveBeenCalled();
    } finally { registration.dispose(); rpc.clearHandlers(); fixture.runtime.dispose(); }
  });

  it.each(['off', 'custom'] as const)('uses the shared auto-wait owner with the account %s prompt preference', async (resumePromptMode) => {
    vi.useFakeTimers();
    vi.setSystemTime(300);
    const fixture = createLiveFixture({ settings: accountSettingsParse({ usageLimitRecoverySettingsV1: {
      v: 1, mode: 'auto_wait', resumePromptMode, customResumePrompt: 'Resume the interrupted task',
    } }) });
    try {
      await fixture.runtime.observeFailure(issue);
      expect(fixture.readRecovery()).toMatchObject({ status: 'waiting', resumePromptMode });
      await vi.advanceTimersByTimeAsync(1);
      if (resumePromptMode === 'off') {
        await vi.waitFor(() => expect(fixture.readRecovery().status).toBe('paused'));
        expect(network.enqueue).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(fixture.readRecovery().status).toBe('cancelled'));
        expect(network.enqueue).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({
          content: { t: 'plain', v: expect.objectContaining({ content: {
            type: 'text', text: 'Resume the interrupted task',
          } }) },
        }) }));
      }
    } finally { fixture.runtime.dispose(); }
  });

  it('keeps a scheduled recovery passive while the canonical server feature is disabled and resumes after re-enabling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300);
    let featureEnabled = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, usageLimitRecovery: { enabled: featureEnabled } } }, capabilities: {},
    })), { status: 200 })));
    const futureIssue: SessionRuntimeIssueV1 = { ...issue, usageLimit: { ...issue.usageLimit!, resetAtMs: 2_000 } };
    const fixture = createLiveFixture({ issue: futureIssue, settings: accountSettingsParse({
      usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait' },
    }) });
    try {
      await fixture.runtime.observeFailure(futureIssue);
      expect(fixture.readRecovery()).toMatchObject({ status: 'waiting', nextCheckAtMs: 2_000 });
      featureEnabled = false;
      resetServerFeaturesClientForTests();
      await vi.advanceTimersByTimeAsync(1_700);
      expect(network.enqueue).not.toHaveBeenCalled();
      expect(fixture.readRecovery()).toMatchObject({ status: 'waiting', lastProbeError: 'feature_disabled',
        nextCheckAtMs: 2_000 + DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS });
      featureEnabled = true;
      resetServerFeaturesClientForTests();
      await vi.advanceTimersByTimeAsync(DEFAULT_USAGE_LIMIT_RECOVERY_BACKOFF_MS);
      await vi.waitFor(() => expect(fixture.readRecovery().status).toBe('cancelled'));
      expect(network.enqueue).toHaveBeenCalledOnce();
    } finally { fixture.runtime.dispose(); }
  });

  it('arms only the current failure and replaces an older scheduled issue with a genuinely new one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300);
    const firstIssue: SessionRuntimeIssueV1 = { ...issue, usageLimit: { ...issue.usageLimit!, resetAtMs: 10_000 } };
    const fixture = createLiveFixture({ issue: firstIssue, settings: accountSettingsParse({
      usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait' },
    }) });
    try {
      await fixture.runtime.observeFailure(firstIssue);
      const first = fixture.readRecovery();
      await fixture.runtime.observeFailure(firstIssue);
      expect(fixture.readRecovery()).toEqual(first);
      const nextIssue: SessionRuntimeIssueV1 = { ...firstIssue, occurredAt: 400, providerTurnId: 'new-turn',
        usageLimit: { ...firstIssue.usageLimit!, resetAtMs: 20_000 } };
      fixture.rawSession.lastRuntimeIssue = nextIssue;
      vi.setSystemTime(500);
      await fixture.runtime.observeFailure(nextIssue);
      expect(fixture.readRecovery()).toMatchObject({ issueFingerprint: buildUsageLimitIssueFingerprint(nextIssue),
        armedAtMs: 500, nextCheckAtMs: 20_000 });
      await vi.advanceTimersByTimeAsync(9_500);
      expect(network.enqueue).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(network.enqueue).toHaveBeenCalledOnce();
    } finally { fixture.runtime.dispose(); }
  });

  it('restores null timing through the established fallback anchored to the recovery lifecycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300);
    const untimedIssue: SessionRuntimeIssueV1 = { ...issue, usageLimit: { ...issue.usageLimit!, resetAtMs: null } };
    const fixture = createLiveFixture({ issue: untimedIssue, metadata: { sessionUsageLimitRecoveryV1: {
      v: 1, status: 'checking', issueFingerprint: buildUsageLimitIssueFingerprint(untimedIssue),
      armedAtMs: 100, resetAtMs: null, nextCheckAtMs: null, attemptCount: 0, maxAttempts: 3,
      lastProbeError: null, resumePromptMode: 'standard', selectedAuth: { kind: 'native' },
    } } });
    try {
      await fixture.runtime.restore();
      expect(fixture.readRecovery()).toMatchObject({ status: 'waiting', nextCheckAtMs: 600_100 });
      await vi.advanceTimersByTimeAsync(599_799);
      expect(network.enqueue).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(network.enqueue).toHaveBeenCalledOnce();
    } finally { fixture.runtime.dispose(); }
  });

  it('schedules public enable for an untimed provider failure even when no quota probe exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300);
    const untimedIssue: SessionRuntimeIssueV1 = { ...issue, usageLimit: { ...issue.usageLimit!, resetAtMs: null } };
    const fixture = createLiveFixture({ issue: untimedIssue });
    try {
      expect(await fixture.runtime.controls.enableUsageLimitWaitResume({ sessionId: fixture.sessionId }))
        .toMatchObject({ ok: true });
      const nextCheckAtMs = fixture.readRecovery().nextCheckAtMs;
      expect(fixture.readRecovery().status).toBe('waiting');
      if (nextCheckAtMs === null) throw new Error('Public enable did not schedule an untimed recovery');
      expect(nextCheckAtMs).toBeGreaterThan(Date.now());
      await vi.advanceTimersByTimeAsync(nextCheckAtMs - Date.now() - 1);
      expect(network.enqueue).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(network.enqueue).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(fixture.readRecovery().status).toBe('cancelled'));
    } finally { fixture.runtime.dispose(); }
  });

  it('checks a fresh untimed failure once without rate-limiting its own implicit enable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300);
    const untimedIssue: SessionRuntimeIssueV1 = { ...issue, usageLimit: { ...issue.usageLimit!, resetAtMs: null } };
    const fixture = createLiveFixture({ issue: untimedIssue });
    try {
      expect(await fixture.runtime.controls.checkUsageLimitRecoveryNow({ sessionId: fixture.sessionId }))
        .toMatchObject({ ok: true, status: 'waiting' });
      expect(fixture.readRecovery()).toMatchObject({ status: 'waiting', attemptCount: 0 });
      expect(fixture.readRecovery().nextCheckAtMs).toBeGreaterThan(Date.now());
      expect(network.enqueue).not.toHaveBeenCalled();
    } finally { fixture.runtime.dispose(); }
  });

  it('learns an untimed Codex reset through a real quota-control subprocess before Pending continuation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAtMs = 1_700_000_000_000;
    const resetAtMs = startedAtMs + 60_000;
    vi.setSystemTime(startedAtMs);
    const root = await createTempDir('usage-limit-codex-quota-probe-');
    const scope = createCodexAppServerTestEnvScope();
    const { script, requestLog } = await createQuotaProbeServer(root, 100, resetAtMs);
    scope.patch(createCodexAppServerProcessEnv(script, { CODEX_HOME: root }));
    const untimedIssue: SessionRuntimeIssueV1 = { ...issue, provider: 'codex', occurredAt: startedAtMs,
      usageLimit: { ...issue.usageLimit!, resetAtMs: null } };
    const fixture = createLiveFixture({ issue: untimedIssue, metadata: { path: root, flavor: 'codex',
      agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'appServer' } },
    } });
    try {
      expect(await fixture.runtime.controls.enableUsageLimitWaitResume({ sessionId: fixture.sessionId }))
        .toMatchObject({ ok: true });
      const requests = (await readFile(requestLog, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { method: string });
      expect(requests.filter((request) => request.method === 'account/rateLimits/read')).toHaveLength(1);
      expect(fixture.readRecovery()).toMatchObject({ status: 'waiting', resetAtMs, nextCheckAtMs: resetAtMs,
        issueFingerprint: buildUsageLimitIssueFingerprint(untimedIssue), attemptCount: 0, lastProbeError: null });
      expect(network.enqueue).not.toHaveBeenCalled();
      vi.setSystemTime(resetAtMs);
      expect(await fixture.runtime.controls.checkUsageLimitRecoveryNow({ sessionId: fixture.sessionId }))
        .toMatchObject({ ok: true, status: 'resumed' });
      expect(fixture.rawSession.lastRuntimeIssue?.usageLimit?.resetAtMs).toBeNull();
      expect(network.enqueue).toHaveBeenCalledOnce();
      expect(fixture.readRecovery().status).toBe('cancelled');
    } finally { fixture.runtime.dispose(); scope.restore(); await removeTempDir(root); }
  });

  it('continues before a known reset when the real native quota probe proves readiness early', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAtMs = 1_700_000_000_000;
    const resetAtMs = startedAtMs + 60_000;
    vi.setSystemTime(startedAtMs);
    const root = await createTempDir('usage-limit-codex-early-ready-');
    const scope = createCodexAppServerTestEnvScope();
    const { script, requestLog } = await createQuotaProbeServer(root, 0, resetAtMs);
    scope.patch(createCodexAppServerProcessEnv(script, { CODEX_HOME: root }));
    const codexIssue: SessionRuntimeIssueV1 = { ...issue, provider: 'codex', occurredAt: startedAtMs,
      usageLimit: { ...issue.usageLimit!, resetAtMs } };
    const fixture = createLiveFixture({ issue: codexIssue, metadata: { path: root, flavor: 'codex',
      agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'appServer' } },
    } });
    try {
      expect(await fixture.runtime.controls.enableUsageLimitWaitResume({ sessionId: fixture.sessionId }))
        .toMatchObject({ ok: true });
      expect(fixture.readRecovery()).toMatchObject({ status: 'waiting', nextCheckAtMs: resetAtMs });
      const result = await fixture.runtime.controls.checkUsageLimitRecoveryNow({ sessionId: fixture.sessionId });
      const requests = (await readFile(requestLog, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { method: string });
      expect(requests.filter((request) => request.method === 'account/rateLimits/read')).toHaveLength(1);
      expect(Date.now()).toBeLessThan(resetAtMs);
      expect(result).toMatchObject({ ok: true, status: 'resumed' });
      expect(network.enqueue).toHaveBeenCalledOnce();
      expect(fixture.readRecovery().status).toBe('cancelled');
    } finally { fixture.runtime.dispose(); scope.restore(); await removeTempDir(root); }
  });

  it('preserves the continuation budget across repeated transient transport failures', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(300);
    const fixture = createLiveFixture();
    try {
      await fixture.runtime.controls.enableUsageLimitWaitResume({ sessionId: fixture.sessionId });
      network.fetchSessionById.mockRejectedValue(new Error('relay temporarily unavailable'));
      for (let probe = 0; probe < 4; probe += 1) {
        vi.setSystemTime(300 + probe * (DEFAULT_USAGE_LIMIT_CHECK_NOW_THROTTLE_MS + 1));
        expect(await fixture.runtime.controls.checkUsageLimitRecoveryNow({ sessionId: fixture.sessionId })).toMatchObject({ ok: true, status: 'waiting' });
        expect(fixture.readRecovery()).toMatchObject({ status: 'waiting', attemptCount: 0 });
      }
      network.fetchSessionById.mockImplementation(async () => ({ ...fixture.rawSession, metadata: JSON.stringify(fixture.getMetadata()) }));
      vi.setSystemTime(300 + 4 * (DEFAULT_USAGE_LIMIT_CHECK_NOW_THROTTLE_MS + 1));
      expect(await fixture.runtime.controls.checkUsageLimitRecoveryNow({ sessionId: fixture.sessionId })).toMatchObject({ ok: true, status: 'resumed' });
      expect(network.enqueue).toHaveBeenCalledOnce();
    } finally { fixture.runtime.dispose(); }
  });

  it('cancels the exact recovery while session lookup is in flight without admitting continuation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300);
    const fixture = createLiveFixture();
    let releaseLookup: ((value: RawSessionRecord) => void) | undefined;
    let enterLookup: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enterLookup = resolve; });
    try {
      await fixture.runtime.controls.enableUsageLimitWaitResume({ sessionId: fixture.sessionId });
      network.fetchSessionById.mockImplementationOnce(() => {
        enterLookup?.();
        return new Promise<RawSessionRecord>((resolve) => { releaseLookup = resolve; });
      });
      const checking = fixture.runtime.controls.checkUsageLimitRecoveryNow({ sessionId: fixture.sessionId });
      await entered;
      const recovery = fixture.readRecovery();
      expect(await fixture.runtime.controls.cancelUsageLimitWaitResume({ sessionId: fixture.sessionId,
        issueFingerprint: recovery.issueFingerprint, armedAtMs: recovery.armedAtMs })).toMatchObject({ ok: true });
      releaseLookup?.({ ...fixture.rawSession, metadata: JSON.stringify(fixture.getMetadata()) });
      await checking;
      expect(fixture.readRecovery().status).toBe('cancelled');
      expect(network.enqueue).not.toHaveBeenCalled();
    } finally { fixture.runtime.dispose(); }
  });

  it.each(['pending_acceptance', 'runtime_unavailable'] as const)(
    'preserves a replacement recovery when the older continuation awaits %s', async (phase) => {
      const original: SessionUsageLimitRecoveryV1 = { v: 1, status: 'waiting',
        issueFingerprint: buildUsageLimitIssueFingerprint(issue), armedAtMs: 100, resetAtMs: 200, nextCheckAtMs: 200,
        attemptCount: 0, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'standard', selectedAuth: { kind: 'native' } };
      const fixture = createLiveFixture({ metadata: { sessionUsageLimitRecoveryV1: original } });
      let releasePending: ((result: { didWrite: boolean; terminal: boolean }) => void) | undefined;
      let releaseRuntime: ((available: boolean) => void) | undefined;
      let enterBoundary: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => { enterBoundary = resolve; });
      if (phase === 'pending_acceptance') {
        network.enqueue.mockImplementationOnce(() => {
          enterBoundary?.();
          return new Promise<{ didWrite: boolean; terminal: boolean }>((resolve) => { releasePending = resolve; });
        });
      }
      try {
        const checking = routeSessionUsageLimitRecoveryCheckNow({ credentials, token: credentials.token,
          sessionId: fixture.sessionId, rawSession: { ...fixture.rawSession }, metadata: fixture.getMetadata(),
          currentMachineId: 'machine-local', mode: 'plain',
          ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
          callLiveSessionRpc: async () => ({ ok: false, errorCode: 'unsupported_session_runtime_method' }),
          resumeInactiveSessionWhenReady: async ({ rawSession, metadata }) => continueSessionAfterUsageLimitReset({
            credentials, sessionId: fixture.sessionId, rawSession, metadata,
            recovery: SessionUsageLimitRecoveryV1Schema.parse(metadata.sessionUsageLimitRecoveryV1), nowMs: Date.now(),
            isCurrent: () => {
              const current = fixture.readRecovery();
              return hasSameUsageLimitRecoveryIdentity(current, original)
                && current.status !== 'cancelled' && current.status !== 'exhausted';
            },
            ensureRuntime: async () => {
              if (phase !== 'runtime_unavailable') return true;
              enterBoundary?.();
              return await new Promise<boolean>((resolve) => { releaseRuntime = resolve; });
            },
          }),
        });
        await Promise.race([entered, checking.then(() => { throw new Error('Continuation did not reach its external boundary'); })]);
        // A same-issue rearm changes the epoch; the other case also changes the issue.
        const nextIssue: SessionRuntimeIssueV1 = phase === 'pending_acceptance' ? issue
          : { ...issue, occurredAt: Date.now(), providerTurnId: 'newer-provider-turn',
            usageLimit: { ...issue.usageLimit!, resetAtMs: Date.now() + 60_000 } };
        const replacement: SessionUsageLimitRecoveryV1 = { ...original,
          issueFingerprint: buildUsageLimitIssueFingerprint(nextIssue), armedAtMs: Date.now() + 1,
          resetAtMs: nextIssue.usageLimit!.resetAtMs, nextCheckAtMs: Date.now() + 60_000,
          lastProbeError: 'newer_recovery_pending' };
        fixture.rawSession.lastRuntimeIssue = nextIssue;
        await fixture.updateMetadata((metadata) => ({ ...metadata, sessionUsageLimitRecoveryV1: replacement }));
        releasePending?.({ didWrite: true, terminal: false });
        releaseRuntime?.(false);
        await checking;
        expect(fixture.readRecovery()).toEqual(replacement);
      } finally { fixture.runtime.dispose(); }
    },
  );

  it('uses a connected profile selection through the same live continuation owner', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(300);
    const connectedIssue: SessionRuntimeIssueV1 = { ...issue, usageLimit: { ...issue.usageLimit!,
      connectedService: { serviceId: 'gemini', profileId: 'account-1', groupId: null } } };
    const fixture = createLiveFixture({ issue: connectedIssue, metadata: { connectedServices: { v: 1,
      bindingsByServiceId: { gemini: { source: 'connected', selection: 'profile', profileId: 'account-1' } },
    } } });
    try {
      await fixture.runtime.controls.enableUsageLimitWaitResume({ sessionId: fixture.sessionId });
      expect(fixture.readRecovery().selectedAuth).toEqual({ kind: 'profile', serviceId: 'gemini', profileId: 'account-1' });
      expect(await fixture.runtime.controls.checkUsageLimitRecoveryNow({ sessionId: fixture.sessionId })).toMatchObject({ ok: true, status: 'resumed' });
      expect(network.enqueue).toHaveBeenCalledOnce();
    } finally { fixture.runtime.dispose(); }
  });

  it('remembers auto-wait through account settings persistence while preserving the prompt preference', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(300);
    const settings = accountSettingsParse({ usageLimitRecoverySettingsV1: {
      v: 1, mode: 'ask', resumePromptMode: 'custom', customResumePrompt: 'Keep going',
    } });
    const fixture = createLiveFixture({ settings });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { version: 5, content: { t: 'plain', v: settings } } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { success: true, version: 6 } });
    // Account settings cache is a filesystem boundary; keep its mutation/envelope logic real.
    vi.spyOn(accountSettingsCache, 'writeAccountSettingsCacheAtomic').mockResolvedValue(undefined);
    try {
      expect(await fixture.runtime.controls.enableUsageLimitWaitResume({ sessionId: fixture.sessionId, rememberPreference: true }))
        .toMatchObject({ ok: true });
      expect(post).toHaveBeenCalledWith(expect.stringContaining('/v2/account/settings'), expect.objectContaining({
        expectedVersion: 5, content: { t: 'plain', v: expect.objectContaining({ usageLimitRecoverySettingsV1: {
          ...settings.usageLimitRecoverySettingsV1, mode: 'auto_wait',
        } }) },
      }), expect.anything());
      expect(fixture.readRecovery().resumePromptMode).toBe('custom');
    } finally { fixture.runtime.dispose(); }
  });

  it('delivers auto-wait continuation through Pending into the next real provider turn', async () => {
    const root = await createTempDir('usage-limit-next-provider-turn-');
    const requestLog = join(root, 'requests.jsonl');
    const resetAt = new Date(Date.now() - 1_000).toISOString();
    const script = await writeFakeCodexAppServerScript({ dir: root,
      importLines: ['import { appendFile } from "node:fs/promises";'],
      setupLines: [`const requestLog = ${JSON.stringify(requestLog)};`, 'let turns = 0;'],
      bodyLines: [
        'for await (const line of rl) {',
        '  if (!line.trim()) continue;',
        '  const msg = JSON.parse(line);',
        '  if (msg.method) await appendFile(requestLog, JSON.stringify(msg) + "\\n");',
        '  if (msg.id === undefined) continue;',
        '  let result = { data: [], goal: null };',
        '  if (msg.method === "initialize") result = { serverInfo: { name: "fake-codex", version: "0.0.0" } };',
        '  if (msg.method === "thread/start") result = { thread: { id: "quota-thread" } };',
        '  if (msg.method === "turn/start") {',
        '    const count = ++turns;',
        '    const turn = { id: "provider-turn-" + count, status: "inProgress" };',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn } }) + "\\n");',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: "quota-thread", turn } }) + "\\n");',
        `      const error = count === 1 ? { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", resetsAt: ${JSON.stringify(resetAt)}, additionalDetails: null } : undefined;`,
        '      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "quota-thread",',
        '        turn: { id: turn.id, status: error ? "failed" : "completed", ...(error ? { error } : {}) } } }) + "\\n");',
        '    }, 8);',
        '    continue;',
        '  }',
        '  process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");',
        '}',
      ],
    });
    const fixture = createLiveFixture({ metadata: { flavor: 'codex', path: root }, settings: accountSettingsParse({
      usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait' },
    }) });
    let observation: Promise<void> | undefined;
    const mutations: Array<Readonly<{ action: string; turnId: string | undefined }>> = [];
    const published: unknown[] = [];
    const lifecycle = createSessionTurnLifecycle({ sessionId: fixture.sessionId,
      enqueueSessionTurn: async (mutation) => {
        mutations.push({ action: mutation.action, turnId: mutation.turnId });
        fixture.rawSession.latestTurnId = mutation.turnId;
        if (mutation.action === 'begin') fixture.rawSession.latestTurnStatus = 'in_progress';
        if (mutation.action === 'fail') {
          fixture.rawSession.latestTurnStatus = 'failed';
          fixture.rawSession.lastRuntimeIssue = mutation.issue;
        }
        if (mutation.action === 'complete') fixture.rawSession.latestTurnStatus = 'completed';
      },
      onTurnFailure: (failure) => { observation = fixture.runtime.observeFailure(failure); },
    });
    const provider = createCodexAppServerRuntime({ directory: root,
      processEnv: createCodexAppServerProcessEnv(script), onThinkingChange: () => {},
      session: { sessionId: fixture.sessionId, updateMetadata: fixture.updateMetadata,
        getMetadataSnapshot: fixture.getMetadata, sessionTurnLifecycle: lifecycle,
        sendAgentMessage: () => {}, sendAgentMessageCommitted: async () => {},
        sendCodexMessage: (message) => { published.push(message); }, sendSessionEvent: () => {},
      },
    });
    let pendingText: string | undefined;
    let delivered: Promise<void> | undefined;
    let firstTurnSettled: Promise<void> | undefined;
    network.enqueue.mockImplementation(async (request: { body: { content: { t: 'plain'; v: { content: { type: 'text'; text: string } } } } }) => {
      pendingText = request.body.content.v.content.text;
      return { didWrite: true, terminal: false };
    });
    network.rpc.mockImplementation(async (request: { method: string }) => {
      const text = pendingText;
      if (request.method === `${fixture.sessionId}:session.pendingQueue.wake.v1` && text) {
        // The ordinary Pending consumer drains after the previous prompt handler settles.
        await firstTurnSettled;
        delivered = provider.sendPrompt(text);
        await delivered;
      }
      return { ok: true };
    });
    try {
      await provider.startOrLoad({});
      const firstTurn = provider.sendPrompt('Do the interrupted work');
      firstTurnSettled = firstTurn.then(() => {}, () => {});
      await expect(firstTurn).rejects.toMatchObject({
        runtimeAuthClassification: { kind: 'usage_limit' },
      });
      await observation;
      await waitForCondition(() => delivered !== undefined, { timeoutMs: 5_000, intervalMs: 10,
        label: 'Pending wake delivers the accepted continuation to the provider' });
      await delivered;
      const requestsText = await readFile(requestLog, 'utf8');
      await waitForCondition(() => fixture.rawSession.latestTurnStatus === 'completed', { timeoutMs: 5_000, intervalMs: 10,
        label: 'provider completion reaches the canonical Session turn lifecycle',
        debug: () => JSON.stringify({ mutations, published, requestsText }),
      });
      expect(fixture.rawSession.latestTurnStatus).toBe('completed');
      // The request log is the external subprocess's JSON transport, not an internal spy.
      const requests = (await readFile(requestLog, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { method: string; params?: unknown });
      expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
      expect(requests.filter((request) => request.method === 'thread/resume')).toEqual([]);
      expect(requests.filter((request) => request.method === 'turn/start')[1]).toMatchObject({ params: {
        input: [{ type: 'text', text: 'Usage limits are lifted. Continue where you left off.' }],
      } });
    } finally {
      fixture.runtime.dispose();
      await provider.reset();
      await removeTempDir(root);
    }
  });

  it('reports an accepted usage failure only after its terminal mutation is persisted', async () => {
    const failures: SessionRuntimeIssueV1[] = [];
    let accept: (() => void) | undefined;
    const lifecycle = createSessionTurnLifecycle({ sessionId,
      enqueueSessionTurn: async (mutation) => {
        if (mutation.action === 'fail') await new Promise<void>((resolve) => { accept = resolve; });
      }, onTurnFailure: (failure) => failures.push(failure),
    });
    await lifecycle.beginTurn({ provider: 'gemini' });
    const failed = lifecycle.failTurn({ issue });
    expect(failures).toEqual([]);
    accept?.();
    await failed;
    expect(failures).toEqual([issue]);
  });
});
