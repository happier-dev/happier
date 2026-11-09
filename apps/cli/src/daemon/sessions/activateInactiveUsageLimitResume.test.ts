import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { SessionRuntimeIssueV1, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { buildUsageLimitIssueFingerprint, SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { activateInactiveUsageLimitResume } from './activateInactiveUsageLimitResume';
import { createBackoffSessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/createBackoffSessionUsageLimitRecoveryControlAdapter';
import { UsageLimitRecoveryScheduler } from '../connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { resolveInactiveUsageLimitRecoverySchedulerResult } from '../connectedServices/usageLimitRecovery/resolveInactiveUsageLimitRecoverySchedulerResult';
import { routeSessionUsageLimitRecoveryCheckNow } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlRouter';
import { applyRegisteredSessionStateFieldMutationToMetadata } from '@/api/session/client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';

// Keep the recovery, authoring and Pending owners real; replace HTTP only.
const http = { get: vi.spyOn(axios, 'get'), post: vi.spyOn(axios, 'post') };

const sessionId = 'c123456789012345678901234';
const credentials = { token: 'recovery-test', encryption: null };
const issue: SessionRuntimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed',
  source: 'usage_limit', code: 'usage_limit', agentId: 'codex', agentTurnId: 'interrupted-turn', occurredAt: 100,
  usageLimit: { v: 1, resetAtMs: 200, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } };
const recovery: SessionUsageLimitRecoveryV1 = { v: 1, status: 'paused', armedAtMs: 110, resetAtMs: 200,
  nextCheckAtMs: null, attemptCount: 1, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'standard',
  issueFingerprint: 'usage-limit:codex:interrupted-turn:100:200', selectedAuth: { kind: 'native' } };
const metadata = { machineId: 'machine-1', path: '/repo', flavor: 'codex', codexSessionId: 'vendor-1',
  sessionUsageLimitRecoveryV1: recovery };
const rawSession = createSessionRecordFixture({ id: sessionId, active: false, encryptionMode: 'plain',
  metadata: JSON.stringify(metadata), latestTurnId: 'canonical-failed-turn',
  latestTurnStatus: 'failed', lastRuntimeIssue: issue });
const params = { credentials, sessionId, rawSession, metadata, nowMs: 200, isCurrent: () => true };

describe('activateInactiveUsageLimitResume', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    installAxiosRequestMethodAdapter();
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: rawSession } };
      throw new Error(`Unexpected read: ${url}`);
    });
    http.post.mockResolvedValue({ status: 200, data: { didWrite: true, terminal: false } });
  });

  it('admits the ready native backoff continuation instead of spawning an empty runtime', async () => {
    await expect(activateInactiveUsageLimitResume(params)).resolves.toEqual({ status: 'continued' });
    expect(http.post).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}/pending`),
      expect.objectContaining({ deliveryMode: 'continuation_if_no_queued_user_input',
        requestedAction: { v: 1, kind: 'send_now' } }), expect.anything());
    expect(http.post).toHaveBeenCalledOnce();
  });

  it('admits Pending from the actual due backoff result without cancelling the continuation first', async () => {
    const adapter = createBackoffSessionUsageLimitRecoveryControlAdapter({
      providerId: 'codex', nowMs: () => 200,
    });
    const checked = await adapter.checkNow!({
      token: credentials.token, credentials, sessionId, rawSession,
      metadata: { ...metadata, sessionUsageLimitRecoveryV1: { ...recovery, status: 'waiting', nextCheckAtMs: 200 } },
      currentMachineId: 'machine-1', sessionMachineId: 'machine-1', cwd: '/repo', mode: 'plain', ctx: null,
    });
    expect(checked).toMatchObject({ ok: true, status: 'ready' });
    const checkedMetadata = (checked as { metadata: Record<string, unknown> }).metadata;
    await expect(activateInactiveUsageLimitResume({ ...params, metadata: checkedMetadata })).resolves.toEqual({ status: 'continued' });
    expect(http.post).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}/pending`),
      expect.objectContaining({ deliveryMode: 'continuation_if_no_queued_user_input',
        requestedAction: { v: 1, kind: 'send_now' } }), expect.anything());
  });

  it('continues the same untimed failure after a native quota observation supplies its reset time', async () => {
    const untimedIssue: SessionRuntimeIssueV1 = { ...issue, usageLimit: { ...issue.usageLimit!, resetAtMs: null } };
    const observedRecovery: SessionUsageLimitRecoveryV1 = { ...recovery,
      issueFingerprint: buildUsageLimitIssueFingerprint(untimedIssue), resetAtMs: 200, nextCheckAtMs: 200 };
    const observedMetadata = { ...metadata, sessionUsageLimitRecoveryV1: observedRecovery };
    const observedSession = { ...rawSession, lastRuntimeIssue: untimedIssue, metadata: JSON.stringify(observedMetadata) };
    const originalRead = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: observedSession } } : await originalRead(url));
    await expect(activateInactiveUsageLimitResume({ ...params,
      rawSession: observedSession, metadata: observedMetadata })).resolves.toEqual({ status: 'continued' });
    expect(http.post).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}/pending`),
      expect.objectContaining({ deliveryMode: 'continuation_if_no_queued_user_input',
        requestedAction: { v: 1, kind: 'send_now' } }), expect.anything());
    expect(observedSession.lastRuntimeIssue.usageLimit?.resetAtMs).toBeNull();
    expect(observedRecovery.issueFingerprint).toBe(buildUsageLimitIssueFingerprint(untimedIssue));
  });

  it('keeps suppressed Pending admission distinct from an accepted continuation', async () => {
    let currentMetadata: Metadata = { ...createTestMetadata(), ...metadata,
      sessionUsageLimitRecoveryV1: { ...recovery, status: 'waiting', nextCheckAtMs: 200 } };
    const readRecovery = () => SessionUsageLimitRecoveryV1Schema.parse(currentMetadata.sessionUsageLimitRecoveryV1);
    let journalRecovery = readRecovery();
    const readHttp = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: { ...rawSession, metadata: JSON.stringify(currentMetadata) } } }
      : await readHttp(url));
    // The real Pending HTTP acknowledgement says the newer queued user input won; no row was written.
    http.post.mockResolvedValue({ status: 200, data: { didWrite: false, terminal: false, suppressed: true } });
    const adapter = createBackoffSessionUsageLimitRecoveryControlAdapter({ providerId: 'codex' });
    let routedResult: unknown;
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 200,
      store: {
        // The daemon's scheduler journal and the Session's registered field are separate persistence boundaries.
        read: () => journalRecovery, readAuthoritative: () => journalRecovery,
        write: (_sessionId, intent) => { journalRecovery = intent; },
      },
      recover: async () => {
        routedResult = await routeSessionUsageLimitRecoveryCheckNow({
          token: credentials.token, credentials, sessionId, rawSession,
          metadata: currentMetadata, currentMachineId: 'machine-1', mode: 'plain', ctx: null,
          // Compose the actual generic backoff control through its normal adapter hook.
          resolveAdapter: async () => adapter,
          callLiveSessionRpc: async () => ({ ok: false, errorCode: 'unsupported_session_runtime_method' }),
          stageUsageLimitRecoveryMutation: async mutation => {
            currentMetadata = applyRegisteredSessionStateFieldMutationToMetadata(currentMetadata, mutation);
          },
          resumeInactiveSessionWhenReady: input => activateInactiveUsageLimitResume({ ...params, ...input, nowMs: Date.now() }),
        });
        return resolveInactiveUsageLimitRecoverySchedulerResult({ result: routedResult });
      },
    });
    try {
      await scheduler.wake({ sessionId, reason: 'check_now' });
      expect(routedResult).toMatchObject({ ok: true, status: 'cancelled' });
      expect(readRecovery()).toMatchObject({ status: 'cancelled', attemptCount: recovery.attemptCount });
      expect(scheduler.read(sessionId)).toMatchObject({ status: 'cancelled', attemptCount: recovery.attemptCount });
      expect(http.post).toHaveBeenCalledOnce();
    } finally { scheduler.dispose(); }
  });

  it('refuses recovery without a valid durable recovery intent', async () => {
    await expect(activateInactiveUsageLimitResume({ ...params,
      metadata: { ...metadata, sessionUsageLimitRecoveryV1: { v: 1 } } })).resolves.toBe(false);
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    { v: 1, agentId: 'codex', machineId: 'machine-1', remoteSessionId: 'vendor-1',
      source: { kind: 'codexHome', home: 'user' }, linkedAtMs: 1 },
    { v: 1 },
  ])('refuses externally linked or unresolved Sessions so takeover owns admission: %j', async (externalSessionV1) => {
    await expect(activateInactiveUsageLimitResume({ ...params,
      metadata: { ...metadata, externalSessionV1 } })).resolves.toBe(false);
    expect(http.post).not.toHaveBeenCalled();
  });
});
