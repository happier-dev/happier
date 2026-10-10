import { beforeEach, describe, expect, it, vi } from 'vitest';

import { V2SessionRecordSchema, type SessionRuntimeIssueV1, type SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { buildNativeProviderAccountUsageSourceProfileId } from '../accountUsage/nativeSourceIdentity';

import { continueSessionAfterUsageLimitReset } from './continueSessionAfterUsageLimitReset';

const transport = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  enqueuePendingQueueV2MessageViaHttp: vi.fn(),
  callSessionRpc: vi.fn(),
}));
// Keep dispatcher, message owner, encryption, and Pending admission real; replace network only.
vi.mock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionById: transport.fetchSessionById }));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({ enqueuePendingQueueV2MessageViaHttp: transport.enqueuePendingQueueV2MessageViaHttp }));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: transport.callSessionRpc }));

const credentials: Credentials = { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } };
const sessionId = 'c123456789012345678901234';
const issue: SessionRuntimeIssueV1 = {
  v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
  provider: 'claude', providerTurnId: 'interrupted-turn', occurredAt: 100,
  usageLimit: { v: 1, resetAtMs: 200, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait',
    connectedService: { serviceId: 'claude-subscription', profileId: 'account-1', groupId: null } },
};
const recovery: SessionUsageLimitRecoveryV1 = {
  v: 1, status: 'waiting', issueFingerprint: 'recovery-attempt', runtimeAuthRecoveryAttemptId: 'recovery-attempt',
  armedAtMs: 110, resetAtMs: 200, nextCheckAtMs: 200, attemptCount: 0, maxAttempts: 3,
  lastProbeError: null, resumePromptMode: 'standard',
  selectedAuth: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'account-1' },
};

function fixture(overrides: Partial<RawSessionRecord> = {}) {
  const metadata = {
    claudeSessionId: 'saved-provider-thread',
    connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'account-1' } } },
    sessionUsageLimitRecoveryV1: recovery,
  };
  const rawSession = V2SessionRecordSchema.parse({
    id: sessionId, seq: 1, createdAt: 0, updatedAt: 100, active: true, activeAt: 100,
    encryptionMode: 'plain', metadata: JSON.stringify(metadata), metadataVersion: 1,
    agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
    latestTurnStatus: 'failed', lastRuntimeIssue: issue, ...overrides,
  });
  transport.fetchSessionById.mockImplementation(async () => rawSession);
  return { credentials, sessionId, rawSession, metadata, recovery, nowMs: 200,
    isCurrent: () => true, ensureRuntime: vi.fn(async () => true) };
}

describe('continueSessionAfterUsageLimitReset', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transport.enqueuePendingQueueV2MessageViaHttp.mockResolvedValue({ didWrite: true, terminal: false });
    transport.callSessionRpc.mockResolvedValue({ ok: true });
  });

  it('puts continuation in ordinary Pending and wakes a healthy runner at reset', async () => {
    const input = fixture();
    const result = await continueSessionAfterUsageLimitReset(input);
    expect(result).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledWith(expect.objectContaining({
      sessionId, body: expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-continuation:/),
        deliveryMode: 'continuation_if_no_queued_user_input', requestedAction: { v: 1, kind: 'send_now' },
        content: { t: 'plain', v: expect.objectContaining({ role: 'user', content: { type: 'text', text: 'Usage limits are lifted. Continue where you left off.' } }) },
      }),
    }));
    expect(transport.callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({ method: `${sessionId}:session.pendingQueue.wake.v1` }));
    expect(input.ensureRuntime).toHaveBeenCalled();
  });

  it('checks canonical runtime adoption after admission when the active projection outlives its runner', async () => {
    const input = fixture({ active: true });
    input.ensureRuntime.mockResolvedValue(false);
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'runtime_unavailable' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
  });

  it('does not admit a continuation when recovery is cancelled during session transport lookup', async () => {
    const input = fixture();
    let current = true;
    transport.fetchSessionById.mockImplementation(async () => {
      current = false;
      return input.rawSession;
    });
    expect(await continueSessionAfterUsageLimitReset({ ...input, isCurrent: () => current }))
      .toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    expect(transport.callSessionRpc).not.toHaveBeenCalled();
    expect(input.ensureRuntime).not.toHaveBeenCalled();
  });

  it('keeps admitted ordinary input when cancellation follows Pending acceptance and suppresses later recovery', async () => {
    const input = fixture({ active: false });
    let current = true;
    transport.enqueuePendingQueueV2MessageViaHttp.mockImplementation(async () => {
      current = false;
      return { didWrite: true, terminal: false };
    });
    const run = () => continueSessionAfterUsageLimitReset({ ...input, isCurrent: () => current });
    expect(await run()).toEqual({ status: 'superseded' });
    expect(await run()).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledTimes(1);
    expect(input.ensureRuntime).not.toHaveBeenCalled();
  });

  it('uses the persisted canonical failed turn when SDK issue evidence lacks a provider turn id', async () => {
    const input = fixture({ latestTurnId: 'canonical-failed-turn', lastRuntimeIssue: { ...issue, providerTurnId: undefined } });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
  });

  it('keeps the same interrupted issue qualified when terminal projection delivery follows recovery arming', async () => {
    const input = fixture({ latestTurnId: 'canonical-failed-turn', latestTurnStatusObservedAt: 150 });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
  });

  it.each(['completed', 'failed'] as const)('suppresses a newer %s turn observed during transport lookup', async (latestTurnStatus) => {
    const input = fixture({ latestTurnId: 'canonical-failed-turn' });
    transport.fetchSessionById.mockResolvedValue({ ...input.rawSession,
      latestTurnId: 'newer-canonical-turn', latestTurnStatus,
      lastRuntimeIssue: latestTurnStatus === 'failed' ? { ...issue, providerTurnId: 'newer-provider-turn', occurredAt: 120 } : issue,
    });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'suppressed' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    expect(input.ensureRuntime).not.toHaveBeenCalled();
  });

  it('suppresses a replaced canonical turn even when issue transport still repeats identical failure evidence', async () => {
    const input = fixture({ latestTurnId: 'canonical-failed-turn', lastRuntimeIssue: { ...issue, providerTurnId: undefined } });
    transport.fetchSessionById.mockResolvedValue({ ...input.rawSession, latestTurnId: 'newer-canonical-turn' });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'suppressed' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('suppresses updated account-source evidence during lookup even when the failure fingerprint is unchanged', async () => {
    const input = fixture();
    transport.fetchSessionById.mockResolvedValue({ ...input.rawSession, lastRuntimeIssue: {
      ...issue, usageLimit: { ...issue.usageLimit!, connectedService: {
        serviceId: 'claude-subscription', profileId: 'account-2', groupId: null,
      } },
    } });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'suppressed' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('retains one Pending identity while retrying unavailable runtime attachment', async () => {
    const input = fixture({ active: false });
    const pending = new Map<string, unknown>();
    transport.enqueuePendingQueueV2MessageViaHttp.mockImplementation(async ({ body }) => {
      pending.set(body.localId, body.content);
      return { didWrite: true, terminal: false };
    });
    input.ensureRuntime.mockImplementation(async () => {
      expect(pending.size).toBe(1);
      expect(input.metadata.claudeSessionId).toBe('saved-provider-thread');
      return false;
    });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'runtime_unavailable' });
    input.ensureRuntime.mockResolvedValueOnce(true);
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'continued' });
    expect(pending.size).toBe(1);
    expect(transport.enqueuePendingQueueV2MessageViaHttp.mock.calls[1]?.[0])
      .toEqual(transport.enqueuePendingQueueV2MessageViaHttp.mock.calls[0]?.[0]);
    expect(transport.callSessionRpc).not.toHaveBeenCalled();
  });

  it('uses custom continuation text without reconstructing original user input', async () => {
    const input = fixture();
    input.recovery = { ...input.recovery, resumePromptMode: 'custom' };
    await continueSessionAfterUsageLimitReset({ ...input, customResumePrompt: 'Resume the interrupted work' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp.mock.calls[0]?.[0].body.content.v.content.text)
      .toBe('Resume the interrupted work');
  });

  it('honors atomic Pending suppression when explicit input is already queued', async () => {
    const input = fixture({ active: false });
    transport.enqueuePendingQueueV2MessageViaHttp.mockResolvedValue({ didWrite: false, terminal: false, suppressed: true });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'suppressed' });
    expect(input.ensureRuntime).not.toHaveBeenCalled();
    expect(transport.callSessionRpc).not.toHaveBeenCalled();
  });

  it('does not ensure a runtime when Pending custody is unconfirmed', async () => {
    const input = fixture({ active: false });
    transport.enqueuePendingQueueV2MessageViaHttp.mockRejectedValue(new Error('network disconnected'));
    await expect(continueSessionAfterUsageLimitReset(input)).rejects.toThrow('continuation_prompt_send_failed:timeout');
    expect(input.ensureRuntime).not.toHaveBeenCalled();
  });

  it.each(['completed', 'cancelled', 'in_progress', null] as const)('rejects latest turn status %s despite historic issue evidence', async (latestTurnStatus) => {
    const input = fixture({ latestTurnStatus });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it.each([
    ['newer failed turn', { ...issue, providerTurnId: 'newer-turn', occurredAt: 111 }],
    ['new reset', { ...issue, usageLimit: { ...issue.usageLimit!, resetAtMs: 201 } }],
    ['new account', { ...issue, usageLimit: { ...issue.usageLimit!, connectedService: { serviceId: 'claude-subscription', profileId: 'account-2', groupId: null } } }],
    ['authentication failure', { ...issue, source: 'auth_error', usageLimit: undefined }],
    ['unidentified turn', { ...issue, providerTurnId: undefined }],
  ])('rejects %s as an obsolete interruption', async (_name, lastRuntimeIssue) => {
    const input = fixture({ lastRuntimeIssue: lastRuntimeIssue as SessionRuntimeIssueV1 });
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('rejects changed current bindings even when the latest issue still describes the failed account', async () => {
    const input = fixture();
    input.metadata.connectedServices.bindingsByServiceId['claude-subscription'].profileId = 'account-2';
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'exhausted', 'paused'] as const)('does not revive an owner-tagged %s attempt', async (status) => {
    const input = fixture();
    input.metadata.sessionUsageLimitRecoveryV1 = { ...recovery, status };
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('rejects a replacement attempt and checks cancellation again just before admission', async () => {
    const input = fixture();
    input.metadata.sessionUsageLimitRecoveryV1 = { ...recovery, runtimeAuthRecoveryAttemptId: 'replacement' };
    expect(await continueSessionAfterUsageLimitReset(input)).toEqual({ status: 'superseded' });
    input.metadata.sessionUsageLimitRecoveryV1 = recovery;
    const isCurrent = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await continueSessionAfterUsageLimitReset({ ...input, isCurrent })).toEqual({ status: 'superseded' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('waits before reset and keeps off mode passive when reset is due', async () => {
    const input = fixture();
    expect(await continueSessionAfterUsageLimitReset({ ...input, nowMs: 199 })).toEqual({ status: 'not_ready' });
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: { ...recovery, resumePromptMode: 'off' } }))
      .toEqual({ status: 'disabled' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
    expect(input.ensureRuntime).not.toHaveBeenCalled();
  });

  it('uses a due provider reset for a manual owned retry despite a later local backoff check', async () => {
    const input = fixture();
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: { ...recovery, nextCheckAtMs: 300 } }))
      .toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
  });

  it('continues a ready native boundary using the exact current issue fingerprint when turn id is absent', async () => {
    const nativeIssue: SessionRuntimeIssueV1 = { ...issue, providerTurnId: undefined,
      usageLimit: { ...issue.usageLimit!, connectedService: null } };
    const input = fixture({ active: false, lastRuntimeIssue: nativeIssue });
    const nativeRecovery: SessionUsageLimitRecoveryV1 = { ...recovery, status: 'paused',
      runtimeAuthRecoveryAttemptId: undefined, armedAtMs: 100, nextCheckAtMs: null,
      issueFingerprint: 'usage-limit:claude:unknown-turn:100:200', selectedAuth: { kind: 'native' } };
    input.rawSession.metadata = JSON.stringify({ sessionUsageLimitRecoveryV1: nativeRecovery });
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: nativeRecovery,
      metadata: { sessionUsageLimitRecoveryV1: nativeRecovery } })).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
    expect(input.ensureRuntime).toHaveBeenCalled();
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: { ...nativeRecovery, issueFingerprint: 'historic-issue' }, metadata: {} }))
      .toEqual({ status: 'superseded' });
  });

  it('retains ready native backoff without a provider reset instead of adding another clock owner', async () => {
    const nativeIssue: SessionRuntimeIssueV1 = { ...issue,
      usageLimit: { ...issue.usageLimit!, resetAtMs: null, connectedService: null } };
    const input = fixture({ lastRuntimeIssue: nativeIssue });
    const nativeRecovery: SessionUsageLimitRecoveryV1 = { ...recovery, status: 'paused',
      runtimeAuthRecoveryAttemptId: undefined, armedAtMs: 100, resetAtMs: null, nextCheckAtMs: null,
      issueFingerprint: 'usage-limit:claude:interrupted-turn:100:no-reset', selectedAuth: { kind: 'native' } };
    input.rawSession.metadata = JSON.stringify({ sessionUsageLimitRecoveryV1: nativeRecovery });
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: nativeRecovery,
      metadata: { sessionUsageLimitRecoveryV1: nativeRecovery } })).toEqual({ status: 'continued' });
  });

  it('admits native quota-source evidence without requiring a connected account binding', async () => {
    const sourceId = buildNativeProviderAccountUsageSourceProfileId({ kind: 'localCredential', providerId: 'claude', material: '/native/config' });
    const nativeIssue: SessionRuntimeIssueV1 = { ...issue, usageLimit: { ...issue.usageLimit!,
      connectedService: { serviceId: 'claude-subscription', profileId: sourceId, groupId: null } } };
    const input = fixture({ lastRuntimeIssue: nativeIssue });
    const nativeRecovery: SessionUsageLimitRecoveryV1 = { ...recovery, status: 'paused',
      runtimeAuthRecoveryAttemptId: undefined, armedAtMs: 100, nextCheckAtMs: null,
      issueFingerprint: 'usage-limit:claude:interrupted-turn:100:200', selectedAuth: { kind: 'native', serviceId: 'claude-subscription' } };
    const metadata = { sessionUsageLimitRecoveryV1: nativeRecovery };
    input.rawSession.metadata = JSON.stringify(metadata);
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: nativeRecovery, metadata })).toEqual({ status: 'continued' });
    expect(transport.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalled();
  });

  it('qualifies a group without requiring its metadata to expose the applied profile', async () => {
    const groupIssue: SessionRuntimeIssueV1 = { ...issue,
      usageLimit: { ...issue.usageLimit!, connectedService: { serviceId: 'claude-subscription', profileId: 'account-1', groupId: 'group-1' } } };
    const input = fixture({ lastRuntimeIssue: groupIssue });
    const groupRecovery: SessionUsageLimitRecoveryV1 = { ...recovery,
      selectedAuth: { kind: 'group', serviceId: 'claude-subscription', profileId: 'account-1', groupId: 'group-1' } };
    const metadata = { sessionUsageLimitRecoveryV1: groupRecovery,
      connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'group-1' } } } };
    input.rawSession.metadata = JSON.stringify(metadata);
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: groupRecovery, metadata })).toEqual({ status: 'continued' });
    metadata.connectedServices.bindingsByServiceId['claude-subscription'].groupId = 'group-2';
    expect(await continueSessionAfterUsageLimitReset({ ...input, recovery: groupRecovery, metadata })).toEqual({ status: 'superseded' });
  });
});
