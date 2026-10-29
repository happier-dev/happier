import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, AgentSessionRuntimeEventSchema, buildUsageLimitIssueFingerprint, type AgentSessionRuntimeEvent, type SessionRuntimeIssueV1, type SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { SessionMessageContentSchema, UserMessageSchema } from '@/api/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { enqueuePendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { registerSessionUserMessageSendHandler } from '@/rpc/handlers/sessionUserMessageSend';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withCodexNativeAttachFixture } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';

import { createSessionUsageLimitRecoveryRuntime } from './createSessionUsageLimitRecoveryRuntime';

describe('native usage-limit recovery composition', () => {
  afterEach(() => vi.restoreAllMocks());

  it('replaces an older daemon-owned wait when a new accepted quota failure arrives', async () => {
    const issue: SessionRuntimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit',
      code: 'usage_limit', agentId: 'codex', agentTurnId: 'new-turn', occurredAt: 300,
      usageLimit: { v: 1, resetAtMs: 900_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } };
    const old: SessionUsageLimitRecoveryV1 = { v: 1, status: 'waiting', issueFingerprint: 'old-failure',
      runtimeAuthRecoveryAttemptId: 'old-attempt', armedAtMs: 100, resetAtMs: 200, nextCheckAtMs: 200,
      attemptCount: 1, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'off', selectedAuth: { kind: 'native' } };
    let metadata = createTestMetadata({ sessionUsageLimitRecoveryV1: old });
    const recovery = createSessionUsageLimitRecoveryRuntime({ sessionId: 'new-quota-failure', currentMachineId: null,
      getMetadata: () => metadata, updateMetadata: async update => { metadata = update(metadata); },
      readContext: async () => null, runRequest: async operation => await operation(), isFeatureEnabled: async () => true,
      nowMs: () => 400, getAccountSettings: () => accountSettingsParse({ usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait' } }),
    });
    try {
      await recovery.observeFailure(issue);
      expect(metadata.sessionUsageLimitRecoveryV1).toMatchObject({
        issueFingerprint: buildUsageLimitIssueFingerprint(issue), resetAtMs: 900_000, armedAtMs: 400,
      });
      expect(metadata.sessionUsageLimitRecoveryV1?.runtimeAuthRecoveryAttemptId).toBeUndefined();
      const armed = metadata.sessionUsageLimitRecoveryV1;
      await recovery.observeFailure(issue);
      expect(metadata.sessionUsageLimitRecoveryV1).toEqual(armed);
    } finally { recovery.dispose(); }
  });

  it.each(['due-intent', 'healthy-no-intent', 'failed-no-intent'] as const)('admits fresh user input through its generic recovery owner (%s)', async scenario => {
    const sessionId = 'c123456789012345678901234';
    const credentials = { token: 'fresh-input-quota-test', encryption: null };
    const issue: SessionRuntimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit',
      code: 'usage_limit', agentId: 'codex', agentTurnId: 'interrupted-turn', occurredAt: 100,
      usageLimit: { v: 1, resetAtMs: 200, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } };
    const intent: SessionUsageLimitRecoveryV1 = { v: 1, status: 'waiting', issueFingerprint: buildUsageLimitIssueFingerprint(issue),
      armedAtMs: 110, resetAtMs: 200, nextCheckAtMs: 200, attemptCount: 0, maxAttempts: 3,
      lastProbeError: null, resumePromptMode: 'standard', selectedAuth: { kind: 'native' } };
    let metadata = createTestMetadata({ flavor: 'codex', machineId: 'machine-local',
      ...(scenario === 'due-intent' ? { sessionUsageLimitRecoveryV1: intent } : {}) });
    const raw = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
      metadata: JSON.stringify(metadata), latestTurnStatus: scenario === 'healthy-no-intent' ? null : 'failed',
      latestTurnId: scenario === 'healthy-no-intent' ? null : 'failed-turn',
      lastRuntimeIssue: scenario === 'healthy-no-intent' ? null : issue });
    const recovery = createSessionUsageLimitRecoveryRuntime({ sessionId, currentMachineId: 'machine-local',
      getMetadata: () => metadata, updateMetadata: async update => { metadata = update(metadata); },
      readContext: async () => ({ credentials, rawSession: raw, metadata, mode: 'plain', ctx: null }),
      runRequest: async operation => await operation(), isFeatureEnabled: async () => true, nowMs: () => 300,
      getAccountSettings: () => accountSettingsParse({ usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait' } }),
    });
    const automaticPending: unknown[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: {
        session: { ...raw, metadata: JSON.stringify(metadata) },
      } };
      throw new Error(`Unexpected Home read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, input: unknown) => {
      if (!String(url).endsWith(`/v2/sessions/${sessionId}/pending`)) throw new Error(`Unexpected Home write: ${url}`);
      automaticPending.push(input);
      return { status: 200, data: { didWrite: true, terminal: false } };
    });
    const admitted: unknown[] = [];
    const rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
    const controls = recovery.controls;
    registerSessionUserMessageSendHandler(rpc, { workingDirectory: metadata.path, sessionId,
      getSessionMetadata: () => metadata, sessionRuntimeControls: controls,
      // The host's installed generic owner yields fresh input to ordinary Pending;
      // a provider-owned override still falls through to native revalidation.
      revalidateExplicitUserRequest: () => controls.checkUsageLimitRecoveryNow === recovery.controls.checkUsageLimitRecoveryNow
        ? { status: 'ready' } : null,
      // Pending transport is the external boundary; the registered RPC and generic controls stay real.
      enqueueSessionUserMessage: async request => { admitted.push(request); },
    });
    try {
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, {
        text: 'Use this newer request instead.', localId: 'newer-user-input', meta: {},
      })).resolves.toEqual({ ok: true });
      expect(admitted).toEqual([{ text: 'Use this newer request instead.', localId: 'newer-user-input',
        meta: { source: 'ui', sentFrom: 'ui' } }]);
      expect(automaticPending).toEqual([]);
    } finally { recovery.dispose(); rpc.clearHandlers(); }
  });

  it.each(['current-attempt', 'stale-attempt'])('cancels only the exact runtime-auth-owned recovery (%s)', async attemptId => {
    const sessionId = 'auth-owned-quota-session';
    const intent: SessionUsageLimitRecoveryV1 = { v: 1, status: 'waiting', issueFingerprint: 'quota-failure',
      runtimeAuthRecoveryAttemptId: 'current-attempt', armedAtMs: 100, resetAtMs: 200, nextCheckAtMs: 200,
      attemptCount: 0, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'standard', selectedAuth: { kind: 'native' } };
    let metadata = createTestMetadata({ sessionUsageLimitRecoveryV1: intent });
    const recovery = createSessionUsageLimitRecoveryRuntime({ sessionId, currentMachineId: 'machine-local',
      getMetadata: () => metadata, updateMetadata: async update => { metadata = update(metadata); },
      readContext: async () => null, runRequest: async operation => await operation(), getAccountSettings: () => null,
    });
    try {
      const result = await recovery.controls.cancelUsageLimitWaitResume({ sessionId, issueFingerprint: intent.issueFingerprint,
        armedAtMs: intent.armedAtMs, runtimeAuthRecoveryAttemptId: attemptId });
      if (attemptId === 'current-attempt') {
        expect(result).toMatchObject({ ok: true });
        expect(metadata.sessionUsageLimitRecoveryV1).toEqual({ ...intent, status: 'cancelled', nextCheckAtMs: null });
      } else {
        expect(result).toMatchObject({ ok: false, errorCode: 'usage_limit_recovery_attempt_superseded' });
        expect(metadata.sessionUsageLimitRecoveryV1).toEqual(intent);
      }
    } finally { recovery.dispose(); }
  });

  it('remembers auto-wait as the Account preference when an explicit enable asks for it', async () => {
    const sessionId = 'remember-quota-preference';
    const credentials = { token: 'remember-quota-test', encryption: null };
    const issue: SessionRuntimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit',
      code: 'usage_limit', agentId: 'codex', agentTurnId: 'interrupted-turn', occurredAt: 100,
      usageLimit: { v: 1, resetAtMs: 200, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } };
    let metadata = createTestMetadata({ flavor: 'codex', machineId: 'machine-local' });
    const raw = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
      metadata: JSON.stringify(metadata), latestTurnStatus: 'failed', latestTurnId: 'failed-turn', lastRuntimeIssue: issue });
    const recovery = createSessionUsageLimitRecoveryRuntime({ sessionId, currentMachineId: 'machine-local',
      getMetadata: () => metadata, updateMetadata: async update => { metadata = update(metadata); },
      readContext: async () => ({ credentials, rawSession: raw, metadata, mode: 'plain', ctx: null }),
      runRequest: async operation => await operation(), isFeatureEnabled: async () => true, nowMs: () => 150,
      getAccountSettings: () => null,
    });
    // Account Settings HTTP is the external boundary; mutation preparation and retry stay real.
    let stored: Record<string, unknown> = { usageLimitRecoverySettingsV1: { v: 1, mode: 'ask', customResumePrompt: 'Keep going.' } };
    let version = 4;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: stored }, version } };
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      throw new Error(`Unexpected Home read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, input: unknown) => {
      if (!String(url).endsWith('/v2/account/settings')) throw new Error(`Unexpected Home write: ${url}`);
      const body = input as { content: { t: 'plain'; v: Record<string, unknown> } };
      stored = body.content.v;
      version += 1;
      return { status: 200, data: { success: true, version } };
    });
    try {
      await expect(recovery.controls.enableUsageLimitWaitResume({ sessionId, rememberPreference: true }))
        .resolves.toMatchObject({ ok: true });
      expect(accountSettingsParse(stored).usageLimitRecoverySettingsV1).toMatchObject({
        v: 1, mode: 'auto_wait', customResumePrompt: 'Keep going.' });
    } finally { recovery.dispose(); }
  });

  it('delivers auto-wait continuation through Pending into the next real Codex turn', async () => {
    const resetAt = new Date(Date.now() - 1_000).toISOString();
    await withCodexNativeAttachFixture(async native => {
      const sessionId = 'actual-happier-session';
      const credentials = { token: 'quota-composition-test', encryption: null };
      let metadata = createTestMetadata({ path: native.directory, machineId: 'machine-local', flavor: 'codex' });
      const raw = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
        metadata: JSON.stringify(metadata), latestTurnStatus: null, latestTurnId: null, lastRuntimeIssue: null });
      const recovery = createSessionUsageLimitRecoveryRuntime({ sessionId, currentMachineId: 'machine-local',
        getMetadata: () => metadata,
        updateMetadata: async update => { metadata = update(metadata); },
        readContext: async () => ({ credentials, rawSession: raw, metadata, mode: 'plain', ctx: null }),
        runRequest: async operation => await operation(),
        isFeatureEnabled: async () => true,
        getAccountSettings: () => accountSettingsParse({ usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait' } }),
      });
      const events: AgentSessionRuntimeEvent[] = [];
      const lifecycle = createSessionTurnLifecycle({ agentId: 'codex', session: {
        sessionId,
        // Home persistence is an external boundary. Its projection is updated from
        // actual canonical lifecycle mutations, including the classified failure.
        enqueueSessionTurnMutation: async mutation => {
          if (!('turnId' in mutation)) return;
          raw.latestTurnId = mutation.turnId;
          raw.latestTurnStatusObservedAt = mutation.observedAt;
          if (mutation.action === 'begin') raw.latestTurnStatus = 'in_progress';
          if (mutation.action === 'fail') { raw.latestTurnStatus = 'failed'; raw.lastRuntimeIssue = mutation.issue; }
          if (mutation.action === 'complete') raw.latestTurnStatus = 'completed';
        },
      },
      // This is the public terminal-acceptance hook installed by the host Session;
      // ApiSessionClient hook installation is covered separately by its owner tests.
      onAcceptedTurnFailure: async (_event, issue) => await recovery.observeFailure(issue),
      });
      const session = await native.openConfiguredSession();
      const subscription = session.watch(input => {
        const event = AgentSessionRuntimeEventSchema.parse(input);
        events.push(event);
        lifecycle.observeRuntimeEvent(event);
      });
      let delivered: Promise<unknown> | undefined;
      const pendingBodies: Array<Parameters<typeof enqueuePendingQueueV2MessageViaHttp>[0]['body']> = [];
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        } };
        if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: {
          session: { ...raw, metadata: JSON.stringify(metadata) },
        } };
        throw new Error(`Unexpected Home read: ${url}`);
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, input: unknown) => {
        if (!String(url).endsWith(`/v2/sessions/${sessionId}/pending`)) throw new Error(`Unexpected Home write: ${url}`);
        // Axios is the external HTTP boundary. Read the actual authored envelope
        // with its canonical schema before delivering its admitted Pending input.
        const body = input as Parameters<typeof enqueuePendingQueueV2MessageViaHttp>[0]['body'];
        pendingBodies.push(body);
        if (!('content' in body)) throw new Error('Expected plain Pending content');
        const content = SessionMessageContentSchema.parse(body.content);
        if (content.t !== 'plain') throw new Error('Expected a plain Pending continuation');
        const message = UserMessageSchema.parse(content.v);
        delivered = session.send({ inputIds: [body.localId], input: { text: message.content.text },
          delivery: { kind: 'newTurn', turnId: 'continued-turn' } });
        return { status: 200, data: { didWrite: true, terminal: false } };
      });
      try {
        await expect(session.send({ inputIds: ['interrupted-input'], input: { text: 'Do the interrupted work' },
          delivery: { kind: 'newTurn', turnId: 'interrupted-turn' } })).resolves.toMatchObject({ status: 'admitted' });
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-failed', turnId: 'interrupted-turn' })));
        await lifecycle.drainAcceptedLifecycle();
        expect(raw.lastRuntimeIssue).toMatchObject({ source: 'usage_limit', usageLimit: { recoverability: 'wait' } });
        await vi.waitFor(() => expect(delivered).toBeDefined());
        await expect(delivered).resolves.toMatchObject({ status: 'admitted' });
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-complete', turnId: 'continued-turn' })));
        await lifecycle.drainAcceptedLifecycle();
        expect(raw.latestTurnStatus).toBe('completed');
        expect(pendingBodies).toEqual([expect.objectContaining({
          deliveryMode: 'continuation_if_no_queued_user_input', requestedAction: { v: 1, kind: 'send_now' },
        })]);
        const turns = native.requests.filter(request => request.method === 'turn/start');
        expect(turns).toHaveLength(2);
        expect(turns[1]).toMatchObject({ params: { threadId: 'fresh-thread',
          input: [{ type: 'text', text: 'Usage limits are lifted. Continue where you left off.' }],
        } });
        expect(native.requests.filter(request => request.method === 'thread/resume')).toEqual([]);
      } finally {
        recovery.dispose();
        subscription.dispose();
        await lifecycle.drainAcceptedLifecycle();
      }
    }, {
      onTurnStart: ({ socket, params, turnId }) => {
        const error = turnId === 'provider-turn-1' ? {
          message: 'Usage limit reached', codexErrorInfo: 'UsageLimitExceeded', resetsAt: resetAt, additionalDetails: null,
        } : undefined;
        socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: params.threadId,
          turn: { id: turnId, status: error ? 'failed' : 'completed', ...(error ? { error } : {}) },
        } }));
      },
    });
  });
});
