import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, type SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createInactiveUsageLimitRecoveryCheckOwner } from '@/daemon/connectedServices/usageLimitRecovery/inactiveUsageLimitRecoveryCheckOwner';
import { UsageLimitRecoveryScheduler } from '@/daemon/connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';

const network = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  callSessionRpc: vi.fn(),
  callMachineRpc: vi.fn(),
}));
// Keep session resolution, recovery routing, and issue/intent parsing real.
vi.mock('@/session/transport/http/sessionsHttp', async (original) => ({
  ...await original<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: network.fetchSessionById,
}));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: network.callSessionRpc }));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc: network.callMachineRpc }));
vi.mock('@/persistence', async (original) => ({
  ...await original<typeof import('@/persistence')>(),
  readSettings: async () => ({ machineId: 'machine-local' }),
}));

import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  resetServerFeaturesClientForTests();
});

describe('usage-limit control transport freshness', () => {
  it.each([true, false])('refreshes reused Action admission after the canonical feature decision changes from %s', async (initiallyEnabled) => {
    let enabled = initiallyEnabled;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, usageLimitRecovery: { enabled } } }, capabilities: {},
    })), { status: 200, headers: { 'content-type': 'application/json' } }));
    const sessionId = 'c123456789012345678901234';
    network.fetchSessionById.mockResolvedValue(createSessionRecordFixture({ id: sessionId, active: true,
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine-local' }) }));
    network.callSessionRpc.mockResolvedValue({ ok: true, status: 'waiting', sessionId });
    const actions = createCliActionDeps({ token: 'token',
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      sessionId, mode: 'plain', ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
    });
    const check = () => actions.sessionUsageLimitCheckNow?.({ sessionId });
    expect(await check()).toMatchObject(initiallyEnabled ? { ok: true, status: 'waiting' } : { ok: false, errorCode: 'feature_disabled' });
    enabled = !initiallyEnabled;
    resetServerFeaturesClientForTests();
    expect(await check()).toMatchObject(enabled ? { ok: true, status: 'waiting' } : { ok: false, errorCode: 'feature_disabled' });
    expect(network.callSessionRpc).toHaveBeenCalledOnce();
  });

  it.each(['cancelled', 'rearmed'] as const)('does not delegate an old scheduled check after recovery was %s', async (change) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, usageLimitRecovery: { enabled: true } } }, capabilities: {},
    })), { status: 200, headers: { 'content-type': 'application/json' } }));
    const sessionId = 'c123456789012345678901234';
    const now = Date.now();
    const recovery: SessionUsageLimitRecoveryV1 = {
      v: 1, status: 'waiting', issueFingerprint: 'old-limit', armedAtMs: now,
      resetAtMs: now + 60_000, nextCheckAtMs: now + 60_000, attemptCount: 0, maxAttempts: 3,
      lastProbeError: null, resumePromptMode: 'standard', selectedAuth: { kind: 'native' },
    };
    let rawSession = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
      metadata: JSON.stringify({ machineId: 'machine-local', sessionUsageLimitRecoveryV1: recovery }) });
    network.fetchSessionById.mockImplementation(async () => rawSession);
    network.callSessionRpc.mockResolvedValue({ ok: true, status: 'waiting', sessionId,
      metadata: { sessionUsageLimitRecoveryV1: recovery } });
    const owner = createInactiveUsageLimitRecoveryCheckOwner();
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => now });
    const persistenceErrors: unknown[] = [];
    const actions = createCliActionDeps({ token: 'token',
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      sessionId, mode: 'plain', ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      scheduleInactiveSessionUsageLimitRecoveryCheck: (input) => owner.schedule({ ...input, scheduler,
        onPersistenceError: (error) => { persistenceErrors.push(error); } }),
    });
    try {
      await expect(actions.sessionUsageLimitWaitResumeEnable?.({ sessionId })).resolves.toMatchObject({
        ok: true, status: 'waiting', metadata: { sessionUsageLimitRecoveryV1: recovery },
      });
      await vi.waitFor(() => expect(owner.hasRunner(sessionId)).toBe(true));
      const updated: SessionUsageLimitRecoveryV1 = change === 'cancelled'
        ? { ...recovery, status: 'cancelled' }
        : { ...recovery, issueFingerprint: 'new-limit', armedAtMs: now + 1 };
      rawSession = { ...rawSession,
        metadata: JSON.stringify({ machineId: 'machine-local', sessionUsageLimitRecoveryV1: updated }) };
      network.callSessionRpc.mockClear();
      await expect(owner.run(sessionId)).resolves.toMatchObject({ status: 'cancelled' });
      expect(network.callSessionRpc).not.toHaveBeenCalled();
      expect(persistenceErrors).toEqual([]);
    } finally { scheduler.dispose(); }
  });

  it('uses the current recovery authority when the same action instance checks again', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, usageLimitRecovery: { enabled: true } } },
      capabilities: {},
    })), { status: 200, headers: { 'content-type': 'application/json' } }));
    const sessionId = 'c123456789012345678901234';
    const recovery: SessionUsageLimitRecoveryV1 = {
      v: 1, status: 'waiting', issueFingerprint: 'limit', armedAtMs: 100,
      resetAtMs: 200, nextCheckAtMs: 200, attemptCount: 0, maxAttempts: 3,
      lastProbeError: null, resumePromptMode: 'standard', selectedAuth: { kind: 'native' },
    };
    let rawSession = createSessionRecordFixture({
      id: sessionId, active: true, encryptionMode: 'plain',
      metadata: JSON.stringify({ machineId: 'machine-local', sessionUsageLimitRecoveryV1: recovery }),
    });
    network.fetchSessionById.mockImplementation(async () => rawSession);
    network.callSessionRpc.mockResolvedValue({ ok: true, status: 'waiting' });
    network.callMachineRpc.mockResolvedValue({ ok: true, status: 'resumed' });
    const actions = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      sessionId, mode: 'plain', ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
    });
    await expect(actions.sessionUsageLimitCheckNow?.({ sessionId })).resolves.toMatchObject({
      ok: true, status: 'waiting',
    });
    rawSession = {
      ...rawSession,
      metadata: JSON.stringify({ machineId: 'machine-local', sessionUsageLimitRecoveryV1: {
        ...recovery, runtimeAuthRecoveryAttemptId: 'current-account-attempt',
      } }),
    };
    await expect(actions.sessionUsageLimitCheckNow?.({ sessionId })).resolves.toMatchObject({
      ok: true, status: 'resumed',
    });
    expect(network.callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-local', method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
    }));
  });
});
