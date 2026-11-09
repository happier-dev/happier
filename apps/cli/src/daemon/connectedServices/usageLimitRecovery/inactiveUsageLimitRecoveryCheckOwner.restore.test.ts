import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, type SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createAccountEncryptionCurrentnessFixture, createCompactSessionListRowFixture, createSessionReadBatchResponseFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { createPendingSessionActivationRecovery } from '../../sessions/pendingSessionActivationRecovery';
import { UsageLimitRecoveryScheduler } from './UsageLimitRecoveryScheduler';
import { createInactiveUsageLimitRecoveryCheckOwner } from './inactiveUsageLimitRecoveryCheckOwner';
import { resolveInactiveUsageLimitRecoverySchedulerResult } from './resolveInactiveUsageLimitRecoverySchedulerResult';

const sessionId = 'c123456789012345678901234';
const pending = (): SessionUsageLimitRecoveryV1 => ({ v: 1, status: 'waiting', issueFingerprint: 'limit', armedAtMs: 100,
  resetAtMs: 5_000, nextCheckAtMs: 5_000, attemptCount: 0, maxAttempts: 3, lastProbeError: null,
  resumePromptMode: 'standard', selectedAuth: { kind: 'native' } });

afterEach(() => { vi.restoreAllMocks(); });

function fixture(options: Readonly<{ unrelatedRows?: number }> = {}) {
  let intent = pending();
  let active = false;
  let latestTurnStatus: 'failed' | 'completed' = 'failed';
  let enabled = true;
  let ownerAccess = true;
  let unavailable = false;
  let current = true;
  let staleAfterCurrentness = false;
  let wakes = 0;
  let currentnessReads = 0;
  let exactSessionReads = 0;
  const row = () => createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active, latestTurnStatus,
    ...(ownerAccess ? {} : { share: { accessLevel: 'edit' as const, canApprovePermissions: false } }),
    metadata: JSON.stringify({ machineId: 'machine-1', [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: intent }) });
  const rows = () => [row(),
    ...Array.from({ length: options.unrelatedRows ?? 0 }, (_, index) => createSessionRecordFixture({
      id: `c${String(index).padStart(24, '0')}`, encryptionMode: 'plain', active: false, latestTurnStatus: 'completed',
      metadata: JSON.stringify({ machineId: 'machine-1' }),
    })),
    createSessionRecordFixture({ ...row(), id: 'shared-editor-session', share: { accessLevel: 'edit', canApprovePermissions: false } }),
  ];
  // The Home HTTP transport is external. Real selectors, envelope readers,
  // locality, reconnect scan, scheduler and registered local RPC remain live.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (unavailable) throw new Error('Home temporarily unavailable');
    if (path === '/v1/account/encryption/currentness') {
      currentnessReads += 1;
      if (staleAfterCurrentness) current = false;
      return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    }
    if (path.startsWith('/v2/sessions/')) {
      exactSessionReads += 1;
      const id = decodeURIComponent(path.slice('/v2/sessions/'.length));
      if (id === sessionId) return { status: 200, data: { session: row() } };
      if (id.startsWith('c00000000000000000000')) return { status: 200, data: { session: createSessionRecordFixture({
        id, encryptionMode: 'plain', active: false, latestTurnStatus: 'completed', metadata: JSON.stringify({ machineId: 'machine-1' }),
      }) } };
    }
    if (path === '/v2/sessions') return { status: 200, data: {
      sessions: rows().map(createCompactSessionListRowFixture), nextCursor: null, hasNext: false,
    } };
    throw new Error(`Unexpected Home read: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, request: unknown) => {
    if (new URL(String(url)).pathname !== '/v2/sessions/read-batch') throw new Error('Unexpected Home write');
    return { status: 200, data: createSessionReadBatchResponseFixture({ request, sessions: rows() }) };
  });
  installAxiosRequestMethodAdapter();
  const machine = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: () => {} });
  // The registered runtime control represents the running agent process boundary.
  machine.registerHandler(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW, async () => {
    wakes += 1;
    return { ok: true, status: 'waiting', metadata: { [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: intent } };
  });
  const owner = createInactiveUsageLimitRecoveryCheckOwner();
  let nowMs = 1_000;
  const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => nowMs,
    recover: async (_intent, context) => {
      const result = await owner.run(context.sessionId);
      return resolveInactiveUsageLimitRecoverySchedulerResult({ result });
    } });
  const restoreInput = () => ({
    credentials: { token: 'fixture-token', encryption: null } as const, machineId: 'machine-1', scheduler,
    currentMachineHost: 'worker', currentMachineHomeDir: '/users/worker', isCurrent: () => current,
    getServerFeaturesSnapshot: () => ({ status: 'ready' as const, features: FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, usageLimitRecovery: { enabled } } }, capabilities: {},
    }) }),
    runCheckNow: (currentSessionId: string) => machine.invokeLocal(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW, { sessionId: currentSessionId }),
  });
  const reconnect = createPendingSessionActivationRecovery({ token: 'fixture-token', activate: async () => {},
    warn: (_message, _input, error) => { throw error; },
    visitOwnedSessions: async sessions => await owner.restoreSessions({ ...restoreInput(), sessions }),
  });
  return { owner, scheduler, reconnect, wakes: () => wakes,
    currentnessReads: () => currentnessReads, exactSessionReads: () => exactSessionReads,
    setNow: (next: number) => { nowMs = next; },
    setActive: () => { active = true; }, setCompleted: () => { latestTurnStatus = 'completed'; },
    setIntent: (next: SessionUsageLimitRecoveryV1) => { intent = next; },
    disable: () => { enabled = false; }, revoke: () => { ownerAccess = false; },
    staleAfterCurrentness: () => { staleAfterCurrentness = true; },
    unavailable: () => { unavailable = true; }, available: () => { unavailable = false; } };
}

it('restores one eligible recovery from an Account-scale inventory with bounded Home reads', async () => {
  const f = fixture({ unrelatedRows: 1_000 });
  try {
    await f.reconnect.recoverAfterConnect();
    expect(f.owner.hasRunner(sessionId)).toBe(true);
    expect(f.currentnessReads()).toBe(1);
    expect(f.exactSessionReads()).toBe(0);
    await f.reconnect.recoverAfterConnect();
    expect(f.currentnessReads()).toBe(2);
    expect(f.exactSessionReads()).toBe(0);
  } finally { f.scheduler.dispose(); }
});

it('refuses the recovery inventory when its Account lifetime becomes stale', async () => {
  const f = fixture({ unrelatedRows: 1_000 });
  try {
    f.staleAfterCurrentness();
    await f.reconnect.recoverAfterConnect();
    expect(f.owner.hasRunner(sessionId)).toBe(false);
    expect(f.currentnessReads()).toBe(1);
    expect(f.exactSessionReads()).toBe(0);
  } finally { f.scheduler.dispose(); }
});

it('restores ordinary waiting recovery through the owner reconnect scan and registered machine control', async () => {
  const f = fixture();
  try {
    await f.reconnect.recoverAfterConnect();
    expect(f.owner.hasRunner(sessionId)).toBe(true);
    expect(f.owner.hasRunner('shared-editor-session')).toBe(false);
    await f.scheduler.wake({ sessionId, reason: 'check_now' });
    expect(f.wakes()).toBe(1);
    f.setActive();
    await f.owner.run(sessionId);
    expect(f.wakes()).toBe(2);
  } finally { f.scheduler.dispose(); }
});

it('finishes a restored admitted wait after the feature is disabled', async () => {
  const f = fixture();
  try {
    await f.reconnect.recoverAfterConnect();
    f.disable();
    await f.scheduler.wake({ sessionId, reason: 'check_now' });
    expect(f.wakes()).toBe(1);
  } finally { f.scheduler.dispose(); }
});

it('parks a failed admitted read without polling and resumes on reconnect availability', async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    await f.reconnect.recoverAfterConnect();
    f.unavailable();
    await f.scheduler.wake({ sessionId, reason: 'check_now' });
    expect(f.scheduler.read(sessionId)).toMatchObject({ status: 'waiting', nextCheckAtMs: null });
    await vi.advanceTimersByTimeAsync(600_001);
    expect(f.wakes()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    f.available();
    f.setNow(10_000);
    await f.reconnect.recoverAfterConnect();
    expect(f.wakes()).toBe(1);
  } finally { f.scheduler.dispose(); vi.useRealTimers(); }
});

it.each(['cancelled', 'replacement', 'completed', 'revoked'] as const)('does not revive %s recovery on a restored wake', async change => {
  const f = fixture();
  try {
    await f.reconnect.recoverAfterConnect();
    expect(f.owner.hasRunner(sessionId)).toBe(true);
    if (change === 'cancelled') f.setIntent({ ...pending(), status: 'cancelled', nextCheckAtMs: null });
    if (change === 'replacement') f.setIntent({ ...pending(), armedAtMs: 101, issueFingerprint: 'new-limit' });
    if (change === 'completed') f.setCompleted();
    if (change === 'revoked') f.revoke();
    await f.scheduler.wake({ sessionId, reason: 'check_now' });
    expect(f.wakes()).toBe(0);
    expect(f.scheduler.read(sessionId)?.status).toBe('cancelled');
  } finally { f.scheduler.dispose(); }
});

it.each(['active', 'terminal', 'runtime-auth', 'completed'] as const)('skips %s recovery during reconnect restoration', async state => {
  const f = fixture();
  try {
    if (state === 'active') f.setActive();
    if (state === 'terminal') f.setIntent({ ...pending(), status: 'exhausted', nextCheckAtMs: null });
    if (state === 'runtime-auth') f.setIntent({ ...pending(), runtimeAuthRecoveryAttemptId: 'auth-attempt' });
    if (state === 'completed') f.setCompleted();
    await f.reconnect.recoverAfterConnect();
    expect(f.owner.hasRunner(sessionId)).toBe(false);
    expect(f.wakes()).toBe(0);
  } finally { f.scheduler.dispose(); }
});

it('retains a restored wait when a fresh Home read fails and retries after availability returns', async () => {
  const f = fixture();
  try {
    await f.reconnect.recoverAfterConnect();
    expect(f.owner.hasRunner(sessionId)).toBe(true);
    f.unavailable();
    await expect(f.owner.run(sessionId)).rejects.toThrow('Home');
    expect(f.scheduler.read(sessionId)?.status).toBe('waiting');
    expect(f.wakes()).toBe(0);
    f.available();
    await f.owner.run(sessionId);
    expect(f.wakes()).toBe(1);
  } finally { f.scheduler.dispose(); }
});
