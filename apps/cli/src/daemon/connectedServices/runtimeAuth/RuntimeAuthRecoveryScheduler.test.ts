import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RuntimeAuthRecoveryScheduler,
  type RuntimeAuthRecoveryDiagnostic,
  type RuntimeAuthRecoveryIntent,
} from './RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthRecoveryKey } from './recoveryKey/runtimeAuthRecoveryKey';
import type { ConnectedServiceRuntimeFailureClassification } from './types';
import type { DurableRecoveryStore } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import { decideConnectedServiceRecovery } from './ConnectedServiceRecoveryPolicy';
import { createConnectedServiceContinuationMessageDispatcher } from '../continuation/createConnectedServiceContinuationMessageDispatcher';

function classification(): ConnectedServiceRuntimeFailureClassification {
  return {
    kind: 'usage_limit',
    serviceId: 'openai-codex',
    profileId: 'primary',
    groupId: 'team',
    resetsAtMs: null,
    planType: null,
    rateLimits: null,
    source: 'structured_provider_error',
  } as ConnectedServiceRuntimeFailureClassification;
}

function classificationFor(
  patch: Partial<ConnectedServiceRuntimeFailureClassification>,
): ConnectedServiceRuntimeFailureClassification {
  return {
    ...classification(),
    ...patch,
  } as ConnectedServiceRuntimeFailureClassification;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('RuntimeAuthRecoveryScheduler', () => {
  it.each(['checking', 'waiting'] as const)('coalesces manual mode changes after an existing claim (%s)', async (status) => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claimed-mode-'));
    const store = createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(join(dir, 'recovery.json'));
    const admitted = createDeferred<void>();
    const finish = createDeferred<void>();
    const continueAfterUsageLimitReset = vi.fn(async () => {
      admitted.resolve(); await finish.promise;
      return { ok: true, status: 'continuation_enqueued' };
    });
    const deps = { nowMs: () => 1000, recover: async () => ({}), continueAfterUsageLimitReset, durableStore: store };
    const scheduler = new RuntimeAuthRecoveryScheduler(deps);
    const otherOwner = new RuntimeAuthRecoveryScheduler(deps);
    let timer: Promise<unknown> | null = null;
    try {
      const source = classificationFor({ groupId: null, resetsAtMs: 1000 });
      const begun = await scheduler.beginClassifiedFailure({ sessionId: 'mode-race', switchesThisTurn: 0,
        resumePromptMode: 'standard', classification: source });
      if (!begun.attemptId) throw new Error('Expected armed attempt');
      timer = scheduler.wake({ sessionId: 'mode-race', reason: 'timer' });
      await admitted.promise;
      const key = buildRuntimeAuthRecoveryKey({ sessionId: 'mode-race', ...source });
      // A new report can project waiting while the previous effect still owns its claim.
      await store.transact!(key, (current) => ({ ...current, intent: { ...current.intent!, status }, result: undefined }));
      await otherOwner.wake({ sessionId: 'mode-race', reason: 'manual',
        attemptId: begun.attemptId, resumePromptMode: 'custom' });
      expect(store.read(key)).toMatchObject({ resumePromptMode: 'standard' });
      finish.resolve(); await timer;
      expect(store.read(key)).toMatchObject({ resumePromptMode: 'standard', status: 'resumed_awaiting_proof' });
      expect(continueAfterUsageLimitReset).toHaveBeenCalledOnce();
    } finally { finish.resolve(); await timer; scheduler.dispose(); otherOwner.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it.each([0, 27])('continues a profile limit at reset plus %i ms and waits for provider proof', async (offset) => {
    let nowMs = 1_000;
    const pending: string[] = [];
    const dispatcher = createConnectedServiceContinuationMessageDispatcher({
      credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      // Pending submission is the transport boundary; the real dispatcher owns identity/admission.
      sendMessage: async (request) => {
        pending.push(request.message);
        return { ok: true, sessionId: 'session-reset', localId: request.localId!, waited: false };
      },
    });
    const failure = classificationFor({ serviceId: 'claude-subscription', groupId: null, resetsAtMs: 60_000 });
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      jitterMs: () => 0,
      recover: async () => {
        const action = decideConnectedServiceRecovery({
          actor: 'automatic', issue: failure,
          selection: { kind: 'profile', serviceId: failure.serviceId, profileId: 'primary' },
        });
        return { status: 'recovery_action_required', action: { kind: action.action, reason: 'usage_limit' } };
      },
      continueAfterUsageLimitReset: async (intent) => {
        await dispatcher.enqueueInterruptedOriginContinuation({
          sessionId: intent.sessionId, attemptId: intent.attemptId!, interruptedOriginId: 'failed-turn',
          interruption: 'provider_failed_turn', resumePromptMode: intent.resumePromptMode ?? 'standard',
          recoveryKind: intent.classification.kind,
        });
        return { ok: true, status: 'continuation_enqueued' };
      },
    });
    try {
      await scheduler.beginClassifiedFailure({ sessionId: 'session-reset', switchesThisTurn: 0, classification: failure });
      nowMs = 2_000;
      await scheduler.wake({ sessionId: 'session-reset', reason: 'manual' });
      expect(pending).toEqual([]);
      nowMs = 60_000 + offset;
      await scheduler.wake({ sessionId: 'session-reset', reason: 'timer' });
      expect(pending).toEqual(['Usage limits are lifted. Continue where you left off.']);
      expect(scheduler.readForSession('session-reset')[0]).toMatchObject({ status: 'resumed_awaiting_proof' });
      const recoveryKey = buildRuntimeAuthRecoveryKey({ sessionId: 'session-reset', serviceId: failure.serviceId, profileId: 'primary', groupId: null });
      await scheduler.markProviderOutcomeProofByKey({ recoveryKey, proofKind: 'provider_activity' });
      expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'recovered' });
    } finally { scheduler.dispose(); }
  });

  it('bounds the proof wait without resending the admitted continuation', async () => {
    let nowMs = 1000;
    const continueAfterUsageLimitReset = vi.fn(async () => ({ ok: true, status: 'continuation_enqueued' }));
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs, maxAttempts: 3, providerOutcomePendingWaitMs: 100, jitterMs: () => 0,
      recover: async () => ({ status: 'recovery_action_required', action: { kind: 'profile_action_required', reason: 'usage_limit' } }),
      continueAfterUsageLimitReset,
    });
    try {
      await scheduler.beginClassifiedFailure({ sessionId: 'proof-wait', switchesThisTurn: 0,
        classification: classificationFor({ groupId: null, resetsAtMs: 1000 }) });
      await scheduler.wake({ sessionId: 'proof-wait', reason: 'manual' });
      for (let count = 0; count < 4; count += 1) {
        nowMs += 100;
        await scheduler.wake({ sessionId: 'proof-wait', reason: 'manual' });
      }
      expect(continueAfterUsageLimitReset).toHaveBeenCalledTimes(1);
      expect(scheduler.read('proof-wait')).toMatchObject({ status: 'exhausted', attemptCount: 3 });
    } finally { scheduler.dispose(); }
  });

  it('does not mistake a generic local repair proof wait for admitted continuation', async () => {
    let nowMs = 1000;
    const continueAfterUsageLimitReset = vi.fn(async () => ({ ok: true, status: 'continuation_enqueued' }));
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => nowMs, continueAfterUsageLimitReset,
      recover: async () => ({ status: 'credential_refreshed' }) });
    try {
      const failure = classificationFor({ groupId: null, resetsAtMs: 2000 });
      await scheduler.beginClassifiedFailure({ sessionId: 'local-repair', switchesThisTurn: 0, classification: failure });
      const recoveryKey = buildRuntimeAuthRecoveryKey({ sessionId: 'local-repair', ...failure });
      await scheduler.markAwaitingProviderOutcomeProofForResultByKey({ recoveryKey, result: { status: 'credential_refreshed' } });
      nowMs = 2000;
      await scheduler.wake({ sessionId: 'local-repair', reason: 'manual' });
      expect(continueAfterUsageLimitReset).toHaveBeenCalledTimes(1);
    } finally { scheduler.dispose(); }
  });

  it('waits for a fresh later reset and permits its new failed turn to continue', async () => {
    let nowMs = 1000;
    const continueAfterUsageLimitReset = vi.fn(async () => ({ ok: true, status: 'continuation_enqueued' }));
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => nowMs, continueAfterUsageLimitReset,
      recover: async () => ({ status: 'recovery_action_required', action: { kind: 'profile_action_required', reason: 'usage_limit' } }) });
    try {
      const failure = classificationFor({ groupId: null, resetsAtMs: 1000 });
      await scheduler.beginClassifiedFailure({ sessionId: 'new-limit', switchesThisTurn: 0, classification: failure });
      await scheduler.wake({ sessionId: 'new-limit', reason: 'manual' });
      nowMs = 1100;
      await scheduler.beginClassifiedFailure({ sessionId: 'new-limit', switchesThisTurn: 0,
        classification: { ...failure, resetsAtMs: 3000 } });
      await scheduler.wake({ sessionId: 'new-limit', reason: 'manual' });
      expect(continueAfterUsageLimitReset).toHaveBeenCalledTimes(1);
      nowMs = 3000;
      await scheduler.wake({ sessionId: 'new-limit', reason: 'manual' });
      expect(continueAfterUsageLimitReset).toHaveBeenCalledTimes(2);
      expect(scheduler.read('new-limit')?.status).toBe('resumed_awaiting_proof');
    } finally { scheduler.dispose(); }
  });

  it.each(['suppressed', 'disabled'])('settles a %s continuation without losing the cancellation projection', async (reason) => {
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 1000,
      recover: async () => ({}),
      continueAfterUsageLimitReset: async () => ({ status: 'continuation_cancelled', reason: `usage_limit_continuation_${reason}` }) });
    try {
      await scheduler.beginClassifiedFailure({ sessionId: 'no-prompt', switchesThisTurn: 0,
        classification: classificationFor({ groupId: null, resetsAtMs: 1000 }) });
      await scheduler.wake({ sessionId: 'no-prompt', reason: 'manual' });
      const settled = scheduler.read('no-prompt');
      expect(settled).toMatchObject({ status: 'cancelled', terminalReason: `usage_limit_continuation_${reason}` });
      expect(settled?.pendingVisibleEvents?.some((event) => event.transition === 'terminal')).toBe(true);
    } finally { scheduler.dispose(); }
  });

  it('keeps the initial in-band working attempt unarmed and arms only a typed retry', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: vi.fn(),
    });
    const intake = await scheduler.beginClassifiedFailure({
      reportId: 'runtime-auth-report:initial-in-band-owner',
      sessionId: 'session-initial-in-band-owner',
      switchesThisTurn: 0,
      classification: classification(),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-initial-in-band-owner',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    expect(scheduler.readByKey(recoveryKey)?.lastSettledTransition).toBe('working');
    expect(scheduler.readByKey(recoveryKey)?.nextRetryAtMs).toBeNull();

    await scheduler.enqueueHandlerFailure({
      reportId: 'runtime-auth-report:initial-in-band-owner',
      expectedAttemptId: intake.attemptId,
      sessionId: 'session-initial-in-band-owner',
      switchesThisTurn: 0,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    expect(scheduler.readByKey(recoveryKey)?.lastSettledTransition).toBe('scheduled');
    expect(scheduler.readByKey(recoveryKey)?.nextRetryAtMs).toBe(1_100);
    scheduler.dispose();
  });

  it('does not let quota proof clear a non-quota recovery intent', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 1_000, recover: vi.fn() });
    await scheduler.beginClassifiedFailure({
      sessionId: 'session-auth-proof-scope',
      switchesThisTurn: 0,
      classification: classificationFor({ kind: 'auth_expired' }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-auth-proof-scope',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.markProviderOutcomeProofByKey({ recoveryKey, proofKind: 'quota_probe_fresh' });

    expect(scheduler.readByKey(recoveryKey)).not.toMatchObject({ status: 'recovered' });
  });

  it('does not let pre-boundary quota proof clear the current recovery attempt', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 2_000, recover: vi.fn() });
    const begun = await scheduler.beginClassifiedFailure({
      reportId: 'runtime-auth-report:post-boundary',
      sessionId: 'session-post-boundary',
      switchesThisTurn: 0,
      classification: classification(),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-post-boundary',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.markProviderOutcomeProofByKey({
      recoveryKey,
      proofKind: 'quota_probe_fresh',
      expectedAttemptId: begun.attemptId,
      observedAtMs: 1_999,
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting' });

    await scheduler.markProviderOutcomeProofByKey({
      recoveryKey,
      proofKind: 'quota_probe_fresh',
      expectedAttemptId: begun.attemptId,
      observedAtMs: 2_000,
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'recovered' });
  });

  it('cancels only the exact stable attempt id and rejects a delayed prior-attempt cancel', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({ nowMs: () => 1_000, recover: vi.fn() });
    const first = await scheduler.beginClassifiedFailure({
      reportId: 'report-a',
      sessionId: 'session-exact-cancel',
      switchesThisTurn: 0,
      classification: classification(),
    });
    expect(first.attemptId).toBeDefined();
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-exact-cancel',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });
    await scheduler.markProviderOutcomeProofByKey({
      recoveryKey,
      proofKind: 'provider_activity',
    });
    await scheduler.beginClassifiedFailure({
      reportId: 'report-b',
      sessionId: 'session-exact-cancel',
      switchesThisTurn: 0,
      classification: classification(),
    });
    const current = scheduler.readForSession('session-exact-cancel')[0];
    expect(current?.attemptId).not.toBe(first.attemptId);

    await expect(scheduler.cancelExact({
      sessionId: 'session-exact-cancel',
      attemptId: first.attemptId!,
    })).resolves.toEqual([]);
    expect(scheduler.readForSession('session-exact-cancel')[0]?.status).not.toBe('cancelled');

    await expect(scheduler.cancelExact({
      sessionId: 'session-exact-cancel',
      attemptId: current!.attemptId!,
    })).resolves.toHaveLength(1);
    expect(scheduler.readForSession('session-exact-cancel')[0]?.status).toBe('cancelled');
  });
  it('exposes persisted runtime-auth recovery as passive state after controller replacement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-passive-'));
    const filePath = join(dir, 'runtime-auth.json');
    let nowMs = 1_000;
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    const createScheduler = () => new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover,
      durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(filePath),
    });
    try {
      const first = createScheduler();
      await first.beginClassifiedFailure({
        reportId: 'runtime-auth-report:passive',
        sessionId: 'session-passive',
        switchesThisTurn: 0,
        classification: classification(),
        resumePromptMode: 'off',
      });
      first.dispose();

      const replacement = createScheduler();
      expect(replacement.hydratePassive()).toEqual([
        expect.objectContaining({ resumePromptMode: 'off' }),
      ]);
      expect(recover).not.toHaveBeenCalled();
      nowMs = 1_200;
      await replacement.wake({ sessionId: 'session-passive', reason: 'manual' });
      expect(recover).toHaveBeenCalledWith(expect.objectContaining({ resumePromptMode: 'off' }));
      replacement.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps and returns the first durable prompt mode when same evidence retains the attempt', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      recover: vi.fn(),
    });
    const first = await scheduler.beginClassifiedFailure({
      reportId: 'first-report',
      sessionId: 'session',
      switchesThisTurn: 0,
      classification: classification(),
      resumePromptMode: 'off',
    });
    const duplicate = await scheduler.beginClassifiedFailure({
      reportId: 'duplicate-report',
      sessionId: 'session',
      switchesThisTurn: 0,
      classification: classification(),
      resumePromptMode: 'custom',
    });
    const [intent] = scheduler.readForSession('session');
    expect(first).toMatchObject({ resumePromptMode: 'off' });
    expect(duplicate).toMatchObject({
      attemptId: first.attemptId,
      resumePromptMode: 'off',
    });
    expect(intent).toMatchObject({
      attemptId: first.attemptId,
      resumePromptMode: 'off',
    });
    scheduler.dispose();
  });

  it('does not let an older successful effect remove newer failure evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-success-fence-'));
    const filePath = join(dir, 'runtime-auth.json');
    const recoveryStarted = createDeferred<void>();
    const recoveryOutcome = createDeferred<unknown>();
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let wake: Promise<Readonly<{ status: string }>> | null = null;
    let first: RuntimeAuthRecoveryScheduler | null = null;
    let second: RuntimeAuthRecoveryScheduler | null = null;
    const createScheduler = () => new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => {
        recoveryStarted.resolve();
        return await recoveryOutcome.promise;
      },
      durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(filePath),
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    try {
      first = createScheduler();
      second = createScheduler();
      const recoveryKey = buildRuntimeAuthRecoveryKey({
        sessionId: 'session-fenced',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team',
      });
      const older = await first.beginClassifiedFailure({
        reportId: 'runtime-auth-report:old',
        sessionId: 'session-fenced',
        switchesThisTurn: 0,
        classification: classificationFor({ sourceKey: 'old-evidence' }),
      });
      wake = first.wakeByKey({ recoveryKey, reason: 'manual' });
      await recoveryStarted.promise;
      const newer = await second.beginClassifiedFailure({
        reportId: 'runtime-auth-report:new',
        sessionId: 'session-fenced',
        switchesThisTurn: 0,
        classification: classificationFor({ sourceKey: 'new-evidence' }),
      });
      expect(newer.attemptId).not.toBe(older.attemptId);

      recoveryOutcome.resolve({ status: 'switch_attempted', result: { proofKind: 'provider_activity' } });
      await wake;

      expect(createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(filePath).read(recoveryKey)).toMatchObject({
        attemptId: newer.attemptId,
        classification: expect.objectContaining({ sourceKey: 'new-evidence' }),
      });
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        event: 'runtime_auth_recovery_success',
      }));
    } finally {
      recoveryOutcome.resolve({ status: 'switch_attempted', result: { proofKind: 'provider_activity' } });
      await wake?.catch(() => undefined);
      first?.dispose();
      second?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let a targeted wake claim a replacement attempt after waiting for durable custody', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-targeted-wake-'));
    const filePath = join(dir, 'runtime-auth.json');
    const claimStarted = createDeferred<void>();
    const releaseClaim = createDeferred<void>();
    const baseStore = createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(filePath);
    const baseTransact = baseStore.transact!;
    let blockNextTransaction = false;
    const blockedStore: DurableRecoveryStore<RuntimeAuthRecoveryIntent> = {
      ...baseStore,
      transact: async <TResult>(
        recoveryKey: string,
        transaction: (current: Readonly<{ intent: RuntimeAuthRecoveryIntent | null; effectClaimToken: string | null }>) => Readonly<{
          intent: RuntimeAuthRecoveryIntent | null; effectClaimToken: string | null; result: TResult;
        }>,
      ) => {
        if (blockNextTransaction) {
          blockNextTransaction = false;
          claimStarted.resolve();
          await releaseClaim.promise;
        }
        return await baseTransact<TResult>(recoveryKey, transaction);
      },
    };
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' }));
    const first = new RuntimeAuthRecoveryScheduler({ nowMs: () => 1_000, recover, durableStore: blockedStore });
    const second = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 2_000, recover,
      durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(filePath),
    });
    let wake: Promise<Readonly<{ status: string }>> | undefined;
    try {
      const sessionId = 'session-targeted-wake';
      const original = await first.beginClassifiedFailure({
        sessionId, reportId: 'targeted-old', switchesThisTurn: 0,
        classification: classificationFor({ sourceKey: 'old-source' }),
      });
      blockNextTransaction = true;
      wake = first.wake({ sessionId, reason: 'manual', attemptId: original.attemptId! });
      await claimStarted.promise;
      const replacement = await second.beginClassifiedFailure({
        sessionId, reportId: 'targeted-new', switchesThisTurn: 0,
        classification: classificationFor({ sourceKey: 'new-source' }),
      });
      expect(replacement.attemptId).not.toBe(original.attemptId);
      releaseClaim.resolve();
      expect(await wake).toEqual({ status: 'inactive' });
      expect(recover).not.toHaveBeenCalled();
      expect(first.readForSession(sessionId)[0]).toMatchObject({ attemptId: replacement.attemptId, attemptCount: 0 });
      await first.wake({ sessionId, reason: 'manual', attemptId: replacement.attemptId! });
      expect(recover).toHaveBeenCalledOnce();
    } finally {
      releaseClaim.resolve();
      await wake?.catch(() => undefined);
      first.dispose();
      second.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['terminal', (scheduler: RuntimeAuthRecoveryScheduler, recoveryKey: string) => scheduler.markTerminalByKey({
      recoveryKey,
      terminalReason: 'stale_terminal_proof',
    })],
    ['recovered', (scheduler: RuntimeAuthRecoveryScheduler, recoveryKey: string) => scheduler.markSucceededByKey(recoveryKey)],
  ] as const)('does not let a stale external %s settlement replace a newer source epoch', async (_kind, settle) => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-external-settlement-fence-'));
    const filePath = join(dir, 'runtime-auth.json');
    const settlementStarted = createDeferred<void>();
    const releaseSettlement = createDeferred<void>();
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const baseStore = createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(filePath);
    const baseTransact = baseStore.transact!;
    let blockNextTransaction = false;
    const blockedSettlementStore: DurableRecoveryStore<RuntimeAuthRecoveryIntent> = {
      ...baseStore,
      transact: async <TResult>(
        recoveryKey: string,
        transaction: (current: Readonly<{
          intent: RuntimeAuthRecoveryIntent | null;
          effectClaimToken: string | null;
        }>) => Readonly<{
          intent: RuntimeAuthRecoveryIntent | null;
          effectClaimToken: string | null;
          result: TResult;
        }>,
      ) => {
        if (blockNextTransaction) {
          blockNextTransaction = false;
          settlementStarted.resolve();
          await releaseSettlement.promise;
        }
        return await baseTransact<TResult>(recoveryKey, transaction);
      },
    };
    const first = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      recover: async () => ({ status: 'credential_refreshed' }),
      durableStore: blockedSettlementStore,
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    const second = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async () => ({ status: 'credential_refreshed' }),
      durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(filePath),
    });
    try {
      const recoveryKey = buildRuntimeAuthRecoveryKey({
        sessionId: 'session-external-fence',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team',
      });
      await first.beginClassifiedFailure({
        reportId: 'runtime-auth-report:external-old',
        sessionId: 'session-external-fence',
        switchesThisTurn: 0,
        classification: classificationFor({ sourceKey: 'old-source-epoch' }),
      });

      blockNextTransaction = true;
      const staleSettlement = settle(first, recoveryKey);
      await settlementStarted.promise;
      const newer = await second.beginClassifiedFailure({
        reportId: 'runtime-auth-report:external-new',
        sessionId: 'session-external-fence',
        switchesThisTurn: 0,
        classification: classificationFor({ sourceKey: 'new-source-epoch' }),
      });
      releaseSettlement.resolve();
      const settlementResult = await staleSettlement;

      expect(settlementResult).toMatchObject({
        status: 'waiting',
        attemptId: newer.attemptId,
        classification: expect.objectContaining({ sourceKey: 'new-source-epoch' }),
      });
      expect(createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(filePath).read(recoveryKey)).toMatchObject({
        status: 'waiting',
        attemptId: newer.attemptId,
        classification: expect.objectContaining({ sourceKey: 'new-source-epoch' }),
      });
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        event: expect.stringMatching(/runtime_auth_recovery_(terminal|success)/),
      }));
    } finally {
      releaseSettlement.resolve();
      first.dispose();
      second.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['proof-wait', async (scheduler: RuntimeAuthRecoveryScheduler, recoveryKey: string, expectedAttemptId: string) => {
      const mark = scheduler.markAwaitingProviderOutcomeProofForResultByKey.bind(scheduler) as (input: Readonly<{
        recoveryKey: string;
        result: unknown;
        expectedAttemptId: string;
      }>) => Promise<RuntimeAuthRecoveryIntent | null>;
      return await mark({
        recoveryKey,
        expectedAttemptId,
        result: { status: 'credential_refreshed', restartRequested: true },
      });
    }],
    ['durable-wait', async (scheduler: RuntimeAuthRecoveryScheduler, recoveryKey: string, expectedAttemptId: string) => {
      const mark = scheduler.markDurableWaitForResultByKey.bind(scheduler) as (input: Readonly<{
        recoveryKey: string;
        result: unknown;
        classificationResetsAtMs: number | null;
        expectedAttemptId: string;
      }>) => Promise<RuntimeAuthRecoveryIntent | null>;
      return await mark({
        recoveryKey,
        expectedAttemptId,
        result: {
          status: 'recovery_action_required',
          action: {
            kind: 'connected_service_required',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'team',
            reason: 'usage_limit',
          },
        },
        classificationResetsAtMs: 60_000,
      });
    }],
  ] as const)('does not let a stale in-band %s result mutate a newer source epoch', async (_kind, mark) => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-runtime-auth-in-band-fence-'));
    const filePath = join(dir, 'runtime-auth.json');
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      recover: async () => ({ status: 'credential_refreshed' }),
      durableStore: createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(filePath),
    });
    try {
      const recoveryKey = buildRuntimeAuthRecoveryKey({
        sessionId: 'session-in-band-fence',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team',
      });
      const older = await scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:in-band-old',
        sessionId: 'session-in-band-fence',
        switchesThisTurn: 0,
        classification: classificationFor({ sourceKey: 'old-in-band-source' }),
      });
      const newer = await scheduler.beginClassifiedFailure({
        reportId: 'runtime-auth-report:in-band-new',
        sessionId: 'session-in-band-fence',
        switchesThisTurn: 0,
        classification: classificationFor({ sourceKey: 'new-in-band-source' }),
      });

      const result = await mark(scheduler, recoveryKey, older.attemptId!);

      expect(result).toMatchObject({
        status: 'waiting',
        attemptId: newer.attemptId,
        attemptCount: 0,
        classification: expect.objectContaining({ sourceKey: 'new-in-band-source' }),
      });
      expect(createRecoveryIntentFileStore<RuntimeAuthRecoveryIntent>(filePath).read(recoveryKey)).toMatchObject({
        status: 'waiting',
        attemptId: newer.attemptId,
        attemptCount: 0,
        classification: expect.objectContaining({ sourceKey: 'new-in-band-source' }),
      });
    } finally {
      scheduler.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });


  it('persists one attempt identity across same-evidence intake and advances the settled transition monotonically', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    const begin = scheduler.beginClassifiedFailure.bind(scheduler);
    const enqueueHandler = scheduler.enqueueHandlerFailure.bind(scheduler);

    const intake = await begin({
      reportId: 'runtime-auth-report:attempt-a',
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ sourceKey: 'provider-event-a' }),
    });
    const attemptId = intake.attemptId;
    expect(attemptId).toEqual(expect.stringMatching(/^runtime-auth-attempt:/));
    expect(intake).toMatchObject({ transition: 'working' });

    const retained = await enqueueHandler({
      reportId: 'runtime-auth-report:attempt-a',
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ sourceKey: 'provider-event-a' }),
      error: new Error('timeout of 5000ms exceeded'),
    });
    expect(retained).toMatchObject({ attemptId, transition: 'scheduled' });
    expect(diagnostics.filter((event) => event.event === 'runtime_auth_recovery_enqueue')).toHaveLength(1);

    const duplicate = await enqueueHandler({
      reportId: 'runtime-auth-report:attempt-a-replayed-through-outbox',
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ sourceKey: 'provider-event-a' }),
      error: new Error('timeout of 5000ms exceeded'),
      expectedAttemptId: attemptId,
    });
    expect(duplicate).toMatchObject({ status: 'stale', attemptId, transition: 'scheduled' });
    expect(diagnostics.filter((event) => event.event === 'runtime_auth_recovery_enqueue')).toHaveLength(1);

    const replay = await begin({
      reportId: 'runtime-auth-report:attempt-a-replayed-through-outbox',
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ sourceKey: 'provider-event-a' }),
    });
    expect(replay).toMatchObject({ attemptId, transition: 'scheduled' });
    expect(diagnostics.filter((event) => event.event === 'runtime_auth_recovery_enqueue')).toHaveLength(1);

    const nextEvidence = await begin({
      reportId: 'runtime-auth-report:attempt-b',
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ sourceKey: 'provider-event-b' }),
    });
    expect(nextEvidence.attemptId).not.toBe(attemptId);
    expect(nextEvidence).toMatchObject({ transition: 'working' });
  });

  it('atomically merges same-evidence attempts across two scheduler controllers sharing one durable store', async () => {
    const values = new Map<string, RuntimeAuthRecoveryIntent>();
    let mergeChain = Promise.resolve();
    const durableStore = {
      read: (key: string) => values.get(key) ?? null,
      readAll: () => [...values.entries()] as ReadonlyArray<readonly [string, RuntimeAuthRecoveryIntent]>,
      write: (key: string, intent: RuntimeAuthRecoveryIntent) => {
        values.set(key, intent);
      },
      remove: (key: string) => {
        values.delete(key);
      },
      merge: async (
        key: string,
        next: RuntimeAuthRecoveryIntent,
        merge: (previous: RuntimeAuthRecoveryIntent | null, next: RuntimeAuthRecoveryIntent) => RuntimeAuthRecoveryIntent,
      ) => {
        let merged!: RuntimeAuthRecoveryIntent;
        mergeChain = mergeChain.then(() => {
          merged = merge(values.get(key) ?? null, next);
          values.set(key, merged);
        });
        await mergeChain;
        return merged;
      },
    };
    const createScheduler = () => new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      durableStore,
    } as ConstructorParameters<typeof RuntimeAuthRecoveryScheduler>[0]);
    const first = createScheduler();
    const second = createScheduler();
    const begin = (scheduler: RuntimeAuthRecoveryScheduler, reportId: string) => (
      scheduler.beginClassifiedFailure as (input: Readonly<{
        reportId: string;
        sessionId: string;
        switchesThisTurn: number;
        classification: ConnectedServiceRuntimeFailureClassification;
      }>) => Promise<Readonly<{ attemptId?: string }>>
    )({
      reportId,
      sessionId: 'session-shared',
      switchesThisTurn: 0,
      classification: classificationFor({ sourceKey: 'shared-provider-event' }),
    });

    const [firstResult, secondResult] = await Promise.all([
      begin(first, 'runtime-auth-report:controller-a'),
      begin(second, 'runtime-auth-report:controller-b'),
    ]);

    expect(firstResult.attemptId).toBeDefined();
    expect(secondResult.attemptId).toBe(firstResult.attemptId);
    expect(values).toHaveLength(1);
    expect([...values.values()][0]).toMatchObject({
      v: 2,
      attemptId: firstResult.attemptId,
      lastSettledTransition: 'working',
    });
    first.dispose();
    second.dispose();
  });

  it('persists recovered settlement for replay while allowing a new report epoch to re-arm', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-recovered',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });
    await scheduler.beginClassifiedFailure({
      reportId: 'runtime-auth-report:recovered-a',
      sessionId: 'session-recovered',
      switchesThisTurn: 0,
      classification: classification(),
    });
    const attemptId = scheduler.readByKey(recoveryKey)?.attemptId;

    await scheduler.markProviderOutcomeProofByKey({
      recoveryKey,
      proofKind: 'provider_activity',
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'recovered',
      attemptId,
      lastSettledTransition: 'recovered',
    });

    await scheduler.beginClassifiedFailure({
      reportId: 'runtime-auth-report:recovered-a',
      sessionId: 'session-recovered',
      switchesThisTurn: 0,
      classification: classification(),
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'recovered', attemptId });

    await scheduler.beginClassifiedFailure({
      reportId: 'runtime-auth-report:recovered-b',
      sessionId: 'session-recovered',
      switchesThisTurn: 0,
      classification: classification(),
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting' });
    expect(scheduler.readByKey(recoveryKey)?.attemptId).not.toBe(attemptId);
  });

  it('preserves terminal settlement only for the same attempt and re-arms a fresh report epoch', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_action_required' as const,
        action: {
          kind: 'reconnect_profile' as const,
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team',
          reason: 'usage_limit' as const,
        },
      }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-terminal-new-attempt',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });
    const first = await scheduler.beginClassifiedFailure({
      reportId: 'runtime-auth-report:terminal-a',
      sessionId: 'session-terminal-new-attempt',
      switchesThisTurn: 0,
      classification: classification(),
    });

    await scheduler.wakeByKey({ recoveryKey, reason: 'manual' });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'cancelled',
      attemptId: first.attemptId,
      lastSettledTransition: 'terminal',
    });

    await scheduler.beginClassifiedFailure({
      reportId: 'runtime-auth-report:terminal-a',
      sessionId: 'session-terminal-new-attempt',
      switchesThisTurn: 0,
      classification: classification(),
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'cancelled',
      attemptId: first.attemptId,
    });

    const fresh = await scheduler.beginClassifiedFailure({
      reportId: 'runtime-auth-report:terminal-b',
      sessionId: 'session-terminal-new-attempt',
      switchesThisTurn: 0,
      classification: classification(),
    });
    expect(fresh.attemptId).not.toBe(first.attemptId);
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'waiting',
      attemptId: fresh.attemptId,
      lastSettledTransition: 'working',
    });
    expect(scheduler.readByKey(recoveryKey)).not.toMatchObject({
      pendingVisibleEvents: expect.arrayContaining([
        expect.objectContaining({ attemptId: first.attemptId, transition: 'terminal' }),
      ]),
    });
  });

  it('creates live-daemon intake for a classified failure before local repair runs', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    const result = await (scheduler as unknown as {
      beginClassifiedFailure(input: Readonly<{
        sessionId: string;
        switchesThisTurn: number;
        classification: ConnectedServiceRuntimeFailureClassification;
      }>): Promise<unknown>;
    }).beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
    });

    expect(result).toMatchObject({ status: 'scheduled', retryable: true });
    expect(scheduler.readByKey(buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    }))).toMatchObject({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
      status: 'waiting',
      attemptCount: 0,
      failurePhase: 'handler',
      failureReason: 'classified_failure_reported',
      lastErrorClassification: {
        kind: 'rate_limited',
        retryable: true,
      },
    });
    // Crash-safe intake is internal state, not yet a user-visible promise. The immediate handler
    // may settle terminal milliseconds later; only a retained retry may project scheduled.
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_enqueue');
  });

  it('allowlist-sanitizes runtime classifications before retaining recovery state', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: {
        ...classification(),
        rateLimits: {
          accessToken: 'secret-access-token',
          rawBody: 'provider-body',
        },
        action: {
          kind: 'open_url',
          url: 'https://example.com/recover?token=secret-access-token',
        },
        rawProviderPayload: {
          authorization: 'Bearer secret-access-token',
        },
      } as ConnectedServiceRuntimeFailureClassification & Record<string, unknown>,
    });

    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });
    const serialized = JSON.stringify(scheduler.readByKey(recoveryKey));
    expect(serialized).not.toContain('secret-access-token');
    expect(serialized).not.toContain('provider-body');
    expect(serialized).not.toContain('rawProviderPayload');
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      classification: {
        rateLimits: null,
        action: null,
      },
    });
  });

  it('persists the concrete terminal recovery status when recovery ends action-required', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_action_required' as const,
        action: {
          kind: 'reconnect_profile' as const,
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'team',
          reason: 'usage_limit' as const,
        },
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
    });
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'terminal' });

    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'cancelled',
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
      terminalReason: 'recovery_action_required',
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'runtime_auth_recovery_terminal',
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
      reason: 'recovery_action_required',
      attemptId: expect.stringMatching(/^runtime-auth-attempt:/),
      transition: 'terminal',
      transcriptEvent: expect.objectContaining({
        type: 'connected-service-runtime-auth-recovery',
        status: 'cancelled',
        terminal: true,
        reason: 'recovery_action_required',
      }),
    }));
  });

  it('keeps group-exhausted no_eligible_member waiting until the earliest FUTURE reset and counts the attempt', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'no_eligible_member' as const,
        generation: 12,
        groupExhausted: true,
        retryAtMs: 9_000,
        excluded: [],
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ resetsAtMs: 5_000 }),
    });
    // Both the original intent `nextRetryAtMs` (5_000) and the classified reset (5_000)
    // have ELAPSED by the time the coordinator answers; only the coordinator's fresh
    // retryAtMs (9_000) is in the future. RD-REC-1: stale candidates must not collapse
    // the durable wait to "now".
    nowMs = 6_000;
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'waiting' });

    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'waiting',
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
      nextRetryAtMs: 9_000,
      lastError: 'no_eligible_member',
      attemptCount: 1,
    });
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'runtime_auth_recovery_terminal',
    }));
  });

  it('rechecks a transiently unavailable alternative before the exhausted account weekly reset', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000, baseBackoffMs: 100, maxBackoffMs: 1_000, jitterMs: () => 0,
      recover: async () => ({
        status: 'no_eligible_member' as const, generation: 12, groupExhausted: true,
        retryAtMs: 600_000,
        excluded: [{ profileId: 'backup', reason: 'credential_unavailable' }],
      }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1', serviceId: 'openai-codex', profileId: 'primary', groupId: 'team',
    });
    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1', switchesThisTurn: 0, classification: classificationFor({ resetsAtMs: 600_000 }),
    });
    await scheduler.wakeByKey({ recoveryKey, reason: 'manual' });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting', nextRetryAtMs: 31_000 });
  });

  it('uses the group-exhausted floor when no_eligible_member has no future reset evidence', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 250,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'no_eligible_member' as const,
        generation: 12,
        groupExhausted: true,
        retryAtMs: null,
        excluded: [],
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ resetsAtMs: 3_000 }),
    });
    // Every timestamp the result/classification/intent carries is in the past.
    nowMs = 5_000;
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'waiting' });

    const intent = scheduler.readByKey(recoveryKey);
    expect(intent).toMatchObject({
      status: 'waiting',
      lastError: 'no_eligible_member',
      attemptCount: 1,
      nextRetryAtMs: 35_000,
    });
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'runtime_auth_recovery_terminal',
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'runtime_auth_recovery_dead_letter',
    }));
  });

  it('lets unknown-reset group-exhausted no_eligible_member backoff grow above the floor', async () => {
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 10_000,
      maxBackoffMs: 45_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'no_eligible_member' as const,
        generation: 12,
        groupExhausted: true,
        retryAtMs: null,
        excluded: [],
      }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ resetsAtMs: 3_000 }),
    });

    nowMs = 5_000;
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      attemptCount: 1,
      nextRetryAtMs: 35_000,
    });

    nowMs = 35_000;
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      attemptCount: 2,
      nextRetryAtMs: 75_000,
    });

    nowMs = 75_000;
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      attemptCount: 3,
      nextRetryAtMs: 120_000,
    });
  });

  it('increments group-exhausted no_eligible_member attempts without dead-lettering durable waits at the attempt ceiling', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => ({
        status: 'no_eligible_member' as const,
        generation: 12,
        groupExhausted: true,
        retryAtMs: nowMs + 4_000,
        excluded: [],
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
    });

    // Drive far more wakes than maxAttempts: group-exhausted + known wait = durable
    // wait, never terminal (F0).
    for (let i = 0; i < 5; i += 1) {
      nowMs += 10_000;
      await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
        .resolves.toEqual({ status: 'waiting' });
    }

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      lastError: 'no_eligible_member',
      attemptCount: 5,
    });
    const events = diagnostics.map((event) => event.event);
    expect(events).not.toContain('runtime_auth_recovery_dead_letter');
    expect(events).not.toContain('runtime_auth_recovery_terminal');
  });

  it('resets no_eligible_member backoff and leaves the replacement in-band attempt unarmed when the failure evidence changes', async () => {
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'no_eligible_member' as const,
        generation: 12,
        groupExhausted: true,
        retryAtMs: null,
        excluded: [],
      }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
    });
    nowMs = 5_000;
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      attemptCount: 1,
      nextRetryAtMs: 35_000,
    });

    nowMs = 5_100;
    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ resetsAtMs: 20_000 }),
    });

    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      attemptCount: 0,
      nextRetryAtMs: null,
      classification: expect.objectContaining({ resetsAtMs: 20_000 }),
    });
  });

  it('keeps switch_limit_reached as a durable wait instead of terminalizing the recovery', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'switch_attempted' as const,
        result: { status: 'switch_limit_reached' as const, generation: 3 },
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 3,
      classification: classification(),
    });
    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    const intent = scheduler.read('session-1');
    expect(intent).toMatchObject({
      status: 'waiting',
      lastError: 'switch_limit_reached',
      attemptCount: 1,
    });
    expect(intent?.nextRetryAtMs ?? 0).toBeGreaterThan(nowMs);
    const events = diagnostics.map((event) => event.event);
    expect(events).not.toContain('runtime_auth_recovery_terminal');
    expect(events).not.toContain('runtime_auth_recovery_dead_letter');
  });

  it('rearms a switch_limit_reached durable wait at the earliest known future reset', async () => {
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'switch_attempted' as const,
        result: { status: 'switch_limit_reached' as const, generation: 3 },
      }),
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 3,
      classification: classificationFor({ resetsAtMs: 60_000 }),
    });
    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      lastError: 'switch_limit_reached',
      nextRetryAtMs: 60_000,
    });
  });

  it('keeps a settings-unavailable continuity apply failure retryable instead of terminalizing it (incident Jun-11 H-A)', async () => {
    // A freshly restarted daemon resolves switch continuity against a NULL account-settings
    // snapshot. That infrastructure gap must wait-and-retry, not dead-end the recovery as
    // non_retryable_apply_failure while state sharing is in fact enabled.
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'switch_attempted' as const,
        result: {
          status: 'generation_apply_failed' as const,
          errorCode: 'provider_state_sharing_settings_unavailable',
          generation: 68,
        },
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
    });
    nowMs = 2_000;
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'waiting' });

    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'waiting',
      lastError: 'provider_state_sharing_settings_unavailable',
    });
    const events = diagnostics.map((event) => event.event);
    expect(events).not.toContain('runtime_auth_recovery_terminal');
    expect(events).not.toContain('runtime_auth_recovery_dead_letter');
  });

  it('classifies a settings-unavailable apply failure intake as retryable (in-band enqueueApplyFailure path)', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'noop' }),
    });

    await expect(scheduler.enqueueApplyFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
      result: {
        status: 'generation_apply_failed',
        errorCode: 'provider_state_sharing_settings_unavailable',
      },
    })).resolves.toMatchObject({ status: 'scheduled', retryable: true });
  });

  it('classifies missing resume-state continuity as retryable until durable reconstruction is exhausted', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'noop' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await expect(scheduler.enqueueApplyFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
      result: {
        status: 'generation_apply_failed',
        errorCode: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          failurePhase: 'continuity',
          durableContinuity: {
            trackedSession: null,
            trackedSpawnOptions: null,
            persistedSessionMetadata: null,
            vendorResumeId: null,
            candidatePersistedSessionFile: null,
            materializationIdentity: null,
          },
        },
      },
    })).resolves.toMatchObject({ status: 'scheduled', retryable: true });

    expect(scheduler.readByKey(buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    }))).toMatchObject({
      status: 'waiting',
      failurePhase: 'apply',
      failureReason: 'durable_continuity_reconstruction_retrying',
      lastError: 'provider_session_state_unavailable_for_resume',
      lastErrorClassification: { kind: 'dependency_unavailable', retryable: true },
    });
    const events = diagnostics.map((event) => event.event);
    expect(events).not.toContain('runtime_auth_recovery_terminal');
    expect(events).not.toContain('runtime_auth_recovery_dead_letter');
  });

  it('terminalizes missing resume-state continuity only when durable reconstruction is exhausted', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'noop' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await expect(scheduler.enqueueApplyFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
      result: {
        status: 'generation_apply_failed',
        errorCode: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          failurePhase: 'continuity',
          durableContinuity: {
            status: 'exhausted',
            trackedSession: null,
            trackedSpawnOptions: null,
            persistedSessionMetadata: null,
            vendorResumeId: null,
            candidatePersistedSessionFile: null,
            materializationIdentity: null,
          },
        },
      },
    })).resolves.toMatchObject({ status: 'terminal_non_retry', retryable: false });

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'runtime_auth_recovery_terminal',
      reason: 'provider_session_state_unavailable_after_reconstruction',
      failurePhase: 'apply',
    }));
  });

  it('arms a durable wait (not terminal) for a non-group recovery_action_required with a known future reset (F0 extension)', async () => {
    // Incident Jun-11 F-NEW-1 / FIX-4: profile-pinned/native selections have no switch target, but a
    // usage limit with a computable reset is a WAIT, not a terminal recovery_action_required.
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_action_required' as const,
        action: {
          kind: 'connected_service_required' as const,
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: null,
          reason: 'usage_limit' as const,
        },
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: null,
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ groupId: null, resetsAtMs: 60_000 }),
    });
    nowMs = 2_000;
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'waiting' });

    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'waiting',
      lastError: 'awaiting_limit_reset',
      nextRetryAtMs: 60_000,
      attemptCount: 1,
    });
    const events = diagnostics.map((event) => event.event);
    expect(events).not.toContain('runtime_auth_recovery_terminal');
    expect(events).not.toContain('runtime_auth_recovery_dead_letter');
  });

  it('arms a durable wait for a profile_action_required limit failure with a known future reset', async () => {
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_action_required' as const,
        action: {
          kind: 'profile_action_required' as const,
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: null,
          reason: 'rate_limit' as const,
        },
      }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: null,
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ kind: 'rate_limit', groupId: null, resetsAtMs: 45_000 }),
    });
    nowMs = 2_000;
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'waiting' });

    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'waiting',
      lastError: 'awaiting_limit_reset',
      nextRetryAtMs: 45_000,
    });
  });

  it('keeps a non-group recovery_action_required terminal when no wait-until is computable', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_action_required' as const,
        action: {
          kind: 'connected_service_required' as const,
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: null,
          reason: 'usage_limit' as const,
        },
      }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: null,
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ groupId: null, resetsAtMs: null }),
    });
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'terminal' });

    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'cancelled',
      terminalReason: 'recovery_action_required',
    });
  });

  it('keeps credential recovery_action_required (reconnect_profile) terminal even when a reset is known', async () => {
    // A credential failure needs user action regardless of any limit-reset horizon; the F0
    // extension applies only to waitable limit kinds on non-group selections.
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_action_required' as const,
        action: {
          kind: 'reconnect_profile' as const,
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: null,
          reason: 'auth_expired' as const,
        },
      }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: null,
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ kind: 'auth_expired', groupId: null, resetsAtMs: 60_000 }),
    });
    await expect(scheduler.wakeByKey({
      recoveryKey,
      reason: 'manual',
    })).resolves.toEqual({ status: 'terminal' });
  });

  it('re-arms a durable wait through markDurableWaitForResultByKey for a non-group recovery_action_required result (in-band parity)', async () => {
    // RD-REC-13 parity: the in-band controlServer path classifies through the same durable-wait
    // owner, so a recovery_action_required result with a computable reset re-arms the intent
    // instead of being marked terminal.
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 2_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'noop' }),
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: null,
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({ groupId: null, resetsAtMs: 60_000 }),
    });
    await expect(scheduler.markDurableWaitForResultByKey({
      recoveryKey,
      result: {
        status: 'recovery_action_required',
        action: {
          kind: 'connected_service_required',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: null,
          reason: 'usage_limit',
        },
      },
      classificationResetsAtMs: 60_000,
    })).resolves.toMatchObject({
      status: 'waiting',
      nextRetryAtMs: 60_000,
      lastError: 'awaiting_limit_reset',
    });
  });

  it('keeps separate runtime-auth recovery intents for two services in one session', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
    });
    const codex = classificationFor({
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    });
    const anthropic = classificationFor({
      serviceId: 'anthropic',
      profileId: 'backup',
      groupId: 'anthropic-group',
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: codex,
      error: new Error('timeout of 5000ms exceeded'),
    });
    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: anthropic,
      error: new Error('timeout of 5000ms exceeded'),
    });

    expect(scheduler.readByKey(buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    }))).toMatchObject({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    });
    expect(scheduler.readByKey(buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'anthropic',
      profileId: 'backup',
      groupId: 'anthropic-group',
    }))).toMatchObject({
      sessionId: 'session-1',
      serviceId: 'anthropic',
      profileId: 'backup',
      groupId: 'anthropic-group',
    });
    expect(scheduler.readForSession('session-1').map((intent) => intent.serviceId).sort()).toEqual([
      'anthropic',
      'openai-codex',
    ]);
  });

  it('classifies state-sharing lock contention as retryable handler dependency contention', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    const result = await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
      error: Object.assign(new Error('state sharing lock unavailable'), {
        code: 'state_sharing_lock_unavailable',
        owner: {
          pid: 1234,
          providerId: 'claude',
          acquiredAtMs: 900,
          ageMs: 100,
          alive: true,
        },
      }),
    });

    expect(result).toMatchObject({
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: 1_100,
    });
    expect(scheduler.readByKey(buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    }))).toMatchObject({
      status: 'waiting',
      lastErrorClassification: {
        kind: 'dependency_unavailable',
        retryable: true,
      },
    });
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      event: 'runtime_auth_recovery_terminal',
    }));
  });

  it('marks one composite recovery key succeeded with provider proof without clobbering sibling intents', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const codex = classificationFor({
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    });
    const anthropic = classificationFor({
      serviceId: 'anthropic',
      profileId: 'backup',
      groupId: 'anthropic-group',
    });
    const codexKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    });
    const anthropicKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'anthropic',
      profileId: 'backup',
      groupId: 'anthropic-group',
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: codex,
      error: new Error('timeout of 5000ms exceeded'),
    });
    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: anthropic,
      error: new Error('timeout of 5000ms exceeded'),
    });

    await scheduler.markProviderOutcomeProofByKey({
      recoveryKey: codexKey,
      proofKind: 'provider_activity',
    });

    expect(scheduler.readByKey(codexKey)).toMatchObject({
      status: 'recovered',
      lastSettledTransition: 'recovered',
    });
    expect(scheduler.readByKey(anthropicKey)).toMatchObject({
      status: 'waiting',
      serviceId: 'anthropic',
      profileId: 'backup',
      groupId: 'anthropic-group',
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'runtime_auth_recovery_success',
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    }));
  });

  it('marks a composite recovery key succeeded only through provider-outcome proof', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
      }),
    });

    await expect(scheduler.markProviderOutcomeProofByKey({
      recoveryKey,
      proofKind: 'provider_activity',
    })).resolves.toMatchObject({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'recovered',
      lastSettledTransition: 'recovered',
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'runtime_auth_recovery_success',
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    }));
  });

  it('marks a composite recovery key terminal through terminal provider-outcome proof', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classificationFor({
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-group',
      }),
    });

    await expect(scheduler.markProviderOutcomeProofByKey({
      recoveryKey,
      proofKind: 'terminal_action_required',
    })).resolves.toMatchObject({
      status: 'cancelled',
      terminalReason: 'terminal_action_required',
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'cancelled',
      terminalReason: 'terminal_action_required',
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: 'runtime_auth_recovery_terminal',
      reason: 'terminal_action_required',
    }));
  });

  it('records scheduled recovery diagnostics with typed runtime-auth recovery transcript events', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    const scheduled = diagnostics.find((event) => event.event === 'runtime_auth_recovery_enqueue');
    expect(scheduled?.transcriptEvent).toMatchObject({
      type: 'connected-service-runtime-auth-recovery',
      status: 'retry_scheduled',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
      nextRetryAtMs: 1_100,
      terminal: false,
      diagnostic: {
        code: 'recovery_retry_scheduled',
        source: 'runtime_auth_recovery',
        failurePhase: 'runtime_auth_recovery',
      },
    });
  });

  it('records dead-letter diagnostics with typed runtime-auth recovery transcript events', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => ({
        status: 'generation_apply_failed',
        errorCode: 'hot_apply_failed',
        diagnostics: {
          underlyingError: 'timeout of 5000ms exceeded',
        },
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await scheduler.wake({ sessionId: 'session-1', reason: 'manual' });

    const deadLetter = diagnostics.find((event) => event.event === 'runtime_auth_recovery_dead_letter');
    expect(deadLetter?.transcriptEvent).toMatchObject({
      type: 'connected-service-runtime-auth-recovery',
      status: 'dead_lettered',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
      terminal: true,
      diagnostic: {
        code: 'recovery_dead_lettered',
        source: 'runtime_auth_recovery',
        failurePhase: 'runtime_auth_recovery',
      },
    });
  });

  it('backs off retryable apply failures instead of persisting checking intents as immediately due', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const retryableApplyFailure = {
        status: 'generation_apply_failed',
        errorCode: 'hot_apply_failed',
        diagnostics: {
          underlyingError: 'timeout of 5000ms exceeded',
        },
      };
      const scheduler = new RuntimeAuthRecoveryScheduler({
        nowMs: () => now,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        recover: async () => retryableApplyFailure,
      });

      await scheduler.enqueueApplyFailure({
        sessionId: 'session-1',
        switchesThisTurn: 1,
        classification: classification(),
        result: retryableApplyFailure,
      });

      await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
        .resolves.toEqual({ status: 'waiting' });

      const intent = scheduler.read('session-1');
      expect(intent).toMatchObject({
        status: 'waiting',
        attemptCount: 1,
        failurePhase: 'apply',
        lastErrorClassification: { kind: 'timeout', retryable: true },
      } satisfies Partial<RuntimeAuthRecoveryIntent>);
      expect(intent?.nextRetryAtMs).toBe(now + 200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off retryable handler failures instead of persisting checking intents as immediately due', async () => {
    vi.useFakeTimers();
    try {
      let now = 2_000;
      const scheduler = new RuntimeAuthRecoveryScheduler({
        nowMs: () => now,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        recover: async () => {
          throw new Error('timeout of 5000ms exceeded');
        },
      });

      await scheduler.enqueueHandlerFailure({
        sessionId: 'session-1',
        switchesThisTurn: 1,
        classification: classification(),
        error: new Error('timeout of 5000ms exceeded'),
      });

      await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
        .resolves.toEqual({ status: 'waiting' });

      const intent = scheduler.read('session-1');
      expect(intent).toMatchObject({
        status: 'waiting',
        attemptCount: 1,
        failurePhase: 'handler',
        lastErrorClassification: { kind: 'timeout', retryable: true },
      } satisfies Partial<RuntimeAuthRecoveryIntent>);
      expect(intent?.nextRetryAtMs).toBe(now + 200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves attempt state when the same runtime-auth failure is reported again', async () => {
    let now = 2_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => now,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 3,
      recover: async () => {
        throw new Error('timeout of 5000ms exceeded');
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 2_200,
    } satisfies Partial<RuntimeAuthRecoveryIntent>);

    now = 2_050;
    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 2,
      classification: classification(),
      error: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 2_200,
      switchesThisTurn: 2,
      lastErrorClassification: { kind: 'network', retryable: true },
    } satisfies Partial<RuntimeAuthRecoveryIntent>);
  });

  it('does not double-enqueue when the same runtime-auth failure is reported through two paths (single owner per recovery key)', async () => {
    // S3: the control-server endpoint enqueues on failure; a sibling report path may also enqueue.
    // Both are keyed by {sessionId, serviceId, profileId, groupId} and coalesce via upsert-merge,
    // so a single failure can never produce two competing durable recovery intents/timers.
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 3,
      recover: async () => ({ status: 'session_endpoint_unavailable', reason: 'down' }),
    });

    const failure = {
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    } as const;

    // Apply-failure path + handler-failure path for the SAME failure.
    await scheduler.enqueueApplyFailure({
      sessionId: failure.sessionId,
      switchesThisTurn: failure.switchesThisTurn,
      classification: failure.classification,
      result: { status: 'generation_apply_failed', errorCode: 'hot_apply_failed', diagnostics: { underlyingError: 'connect ECONNREFUSED' } },
    });
    await scheduler.enqueueHandlerFailure(failure);

    // Exactly one durable intent for the session despite two enqueues.
    expect(scheduler.readForSession('session-1')).toHaveLength(1);
  });

  it('coalesces duplicate runtime-auth reports for the same failing access-token fingerprint', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 3,
      recover: async () => ({ status: 'session_endpoint_unavailable', reason: 'down' }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classificationFor({
        kind: 'auth_expired',
        serviceId: 'claude-subscription',
        groupId: 'claude',
        profileId: 'member-a',
        failingAccessTokenFingerprint: 'sha256:aaaaaaaa',
      }),
      error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 2,
      classification: classificationFor({
        kind: 'auth_expired',
        serviceId: 'claude-subscription',
        groupId: 'claude',
        profileId: 'member-b',
        failingAccessTokenFingerprint: 'sha256:aaaaaaaa',
      }),
      error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });

    expect(scheduler.readForSession('session-1')).toHaveLength(1);
    expect(scheduler.read('session-1')).toMatchObject({
      serviceId: 'claude-subscription',
      groupId: 'claude',
      profileId: 'member-b',
      switchesThisTurn: 2,
      classification: expect.objectContaining({
        failingAccessTokenFingerprint: 'sha256:aaaaaaaa',
      }),
    } satisfies Partial<RuntimeAuthRecoveryIntent>);
  });

  it('coalesces group-backed recoveries even when the reported profile changes within the same group', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 3,
      recover: async () => ({ status: 'credential_refreshed' }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classificationFor({
        serviceId: 'openai-codex',
        groupId: 'codex-group',
        profileId: 'member-a',
      }),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 2,
      classification: classificationFor({
        serviceId: 'openai-codex',
        groupId: 'codex-group',
        profileId: 'member-b',
      }),
      error: new Error('timeout of 5000ms exceeded'),
    });

    expect(scheduler.readForSession('session-1')).toHaveLength(1);
    expect(scheduler.read('session-1')).toMatchObject({
      serviceId: 'openai-codex',
      groupId: 'codex-group',
      profileId: 'member-b',
      switchesThisTurn: 2,
    } satisfies Partial<RuntimeAuthRecoveryIntent>);
  });

  it('does not revive an exhausted runtime-auth recovery intent when the provider reports the same failure again', async () => {
    let now = 3_000;
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => now,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => {
        throw new Error('timeout of 5000ms exceeded');
      },
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'exhausted' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'exhausted',
      attemptCount: 1,
      maxAttempts: 1,
    } satisfies Partial<RuntimeAuthRecoveryIntent>);

    now = 3_050;
    await expect(scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 2,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    })).resolves.toMatchObject({
      status: 'exhausted',
      retryable: false,
    });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'exhausted',
      attemptCount: 1,
      maxAttempts: 1,
      nextRetryAtMs: null,
    } satisfies Partial<RuntimeAuthRecoveryIntent>);
    expect(diagnostics.filter((event) => event.event === 'runtime_auth_recovery_dead_letter')).toHaveLength(1);
  });

  // BANNER self-heal: an exhausted dead-letter is "recovery unproven", not "account
  // broken". Later POSITIVE provider-outcome proof on the same key (a real healthy
  // turn on that profile) is the strongest possible evidence the account works, so
  // it must clear the dead-letter and publish a terminal `recovered` resolution.
  // Honest dead-letters are untouched: a genuinely broken account never produces proof.
  it('clears an exhausted dead-letter on later recovered provider-outcome proof and emits a recovered resolution', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 3_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => {
        throw new Error('timeout of 5000ms exceeded');
      },
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'exhausted' });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'exhausted' });

    await expect(scheduler.markProviderOutcomeProofByKey({
      recoveryKey,
      proofKind: 'provider_activity',
    })).resolves.toMatchObject({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'recovered',
      lastSettledTransition: 'recovered',
    });
    const resolution = diagnostics.find((event) => (
      event.event === 'runtime_auth_recovery_success'
      && event.reason === 'dead_letter_resolved_by_provider_outcome_proof'
    ));
    expect(resolution).toMatchObject({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });
    expect(resolution?.transcriptEvent).toMatchObject({
      type: 'connected-service-runtime-auth-recovery',
      status: 'recovered',
      terminal: true,
      reason: 'dead_letter_resolved_by_provider_outcome_proof',
    });

    // The cleared key is free to re-arm a fresh recovery on a NEW failure.
    await expect(scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    })).resolves.toMatchObject({ status: 'scheduled', retryable: true });
  });

  it('does not clear an exhausted dead-letter through non-proof success or terminal proof', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 3_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => {
        throw new Error('timeout of 5000ms exceeded');
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'exhausted' });

    // Internal success claims are exactly what the dead-letter distrusts.
    await scheduler.markSucceededByKey(recoveryKey);
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'exhausted' });

    // Terminal proof never resurrects/clears an exhausted record either.
    await scheduler.markProviderOutcomeProofByKey({
      recoveryKey,
      proofKind: 'terminal_action_required',
    });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'exhausted' });
  });

  it('coalesces duplicate reports while a same-key recovery check is in flight', async () => {
    const recoverStarted = createDeferred<void>();
    const recoverOutcome = createDeferred<unknown>();
    const recover = vi.fn(async () => {
      recoverStarted.resolve();
      return await recoverOutcome.promise;
    });
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 4_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 3,
      recover,
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    const wakePromise = scheduler.wake({ sessionId: 'session-1', reason: 'manual' });
    await recoverStarted.promise;

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 2,
      classification: classification(),
      error: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    });

    expect(recover).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'checking',
      attemptCount: 1,
      switchesThisTurn: 2,
      lastErrorClassification: { kind: 'network', retryable: true },
    } satisfies Partial<RuntimeAuthRecoveryIntent>);

    recoverOutcome.resolve({
      status: 'generation_apply_failed',
      errorCode: 'hot_apply_failed',
      diagnostics: {
        underlyingError: 'timeout of 5000ms exceeded',
      },
    });
    await expect(wakePromise).resolves.toEqual({ status: 'waiting' });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      switchesThisTurn: 2,
      failurePhase: 'handler',
      // A transient network handler failure now carries the specific endpoint-unavailable reason.
      failureReason: 'session_endpoint_unavailable',
      lastError: 'socket reset',
      lastErrorClassification: { kind: 'network', retryable: true },
    } satisfies Partial<RuntimeAuthRecoveryIntent>);
  });

  it('routes thrown generation apply failures through apply-failure retry classification', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 3_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
    });
    const error = new Error('connected_service_auth_generation_apply_failed:post_switch_verification_failed');
    Object.assign(error, {
      connectedServiceAuthGenerationApplyFailure: {
        diagnostics: {
          retryable: true,
          verification: {
            reason: 'active_account_probe_missing_account_id',
          },
        },
      },
    });

    await expect(scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error,
    })).resolves.toMatchObject({
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: 3_100,
    });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      failurePhase: 'apply',
      failureReason: 'post_switch_verification_failed',
      lastError: 'active_account_probe_missing_account_id',
      lastErrorClassification: { kind: 'protocol_error', retryable: true },
    } satisfies Partial<RuntimeAuthRecoveryIntent>);
  });

  it('backs off stale-process restart failures during recovery instead of cancelling the intent', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 4_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          errorCode: 'restart_failed',
          diagnostics: {
            failurePhase: 'restart',
            retryable: true,
            underlyingError: 'Error: kill ESRCH',
          },
        },
      }),
    });

    await scheduler.enqueueApplyFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      result: {
        status: 'generation_apply_failed',
        errorCode: 'provider_account_adoption_mismatch',
        diagnostics: {
          retryable: true,
          verification: { reason: 'provider_account_adoption_mismatch' },
        },
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      failurePhase: 'apply',
      lastError: 'restart_failed',
      lastErrorClassification: { kind: 'protocol_error', retryable: true },
    } satisfies Partial<RuntimeAuthRecoveryIntent>);
  });

  it('keeps restart acceptance without provider-outcome proof in resumed_awaiting_proof', async () => {
    const diagnostics: string[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed', restartRequested: true }),
      recordDiagnostic: (event) => {
        diagnostics.push(event.event);
      },
    });

    await scheduler.enqueueApplyFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      result: {
        status: 'generation_apply_failed',
        errorCode: 'hot_apply_failed',
        diagnostics: {
          underlyingError: 'timeout of 5000ms exceeded',
        },
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      lastError: 'recovery_unproven_awaiting_provider_outcome',
    });
    expect(diagnostics).not.toContain('runtime_auth_recovery_success');
    expect(diagnostics).not.toContain('runtime_auth_recovery_terminal');
  });

  it('uses the configured provider-outcome pending wait window after credential_refreshed without proof', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      providerOutcomePendingWaitMs: 5_000,
      recover: async () => ({ status: 'credential_refreshed', restartRequested: true }),
    });

    await scheduler.enqueueApplyFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      result: {
        status: 'generation_apply_failed',
        errorCode: 'hot_apply_failed',
        diagnostics: {
          underlyingError: 'timeout of 5000ms exceeded',
        },
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      lastError: 'recovery_unproven_awaiting_provider_outcome',
      nextRetryAtMs: 6_000,
    });
  });

  it('does not dead-letter repeated local completions while provider outcome proof is pending', async () => {
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 2,
      providerOutcomePendingWaitMs: 250,
      recover: async () => ({ status: 'credential_refreshed', restartRequested: true }),
    });

    await scheduler.enqueueApplyFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      result: {
        status: 'generation_apply_failed',
        errorCode: 'hot_apply_failed',
        diagnostics: {
          underlyingError: 'timeout of 5000ms exceeded',
        },
      },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
        .resolves.toEqual({ status: 'waiting' });
      const intent = scheduler.read('session-1');
      expect(intent).toMatchObject({
        status: 'resumed_awaiting_proof',
        lastError: 'recovery_unproven_awaiting_provider_outcome',
        attemptCount: 1,
      });
      expect(intent?.status).not.toBe('exhausted');
      nowMs += 250;
    }
  });

  it('keeps a credential-refresh continuation targeted and bounded while provider proof is absent', async () => {
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 2,
      providerOutcomePendingWaitMs: 250,
      recover: async () => ({
        status: 'credential_refreshed',
        restartRequested: false,
        pendingProviderOutcome: true,
        activeProfileId: 'primary',
        generation: 2,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      }),
    });

    await scheduler.enqueueApplyFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      result: {
        status: 'generation_apply_failed',
        errorCode: 'hot_apply_failed',
        diagnostics: {
          underlyingError: 'timeout of 5000ms exceeded',
        },
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      attemptCount: 1,
      pendingTargetProfileId: 'primary',
      pendingTargetGeneration: 2,
    });

    nowMs += 250;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'exhausted' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'exhausted',
      attemptCount: 2,
      pendingTargetProfileId: 'primary',
      pendingTargetGeneration: 2,
    });
  });

  it('clears a durable resumed_awaiting_proof intent on matching provider activity proof', async () => {
    const diagnostics: string[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      providerOutcomePendingWaitMs: 5_000,
      recover: async () => ({ status: 'credential_refreshed', restartRequested: true }),
      recordDiagnostic: (event) => {
        diagnostics.push(event.event);
      },
    });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await scheduler.enqueueApplyFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      result: {
        status: 'generation_apply_failed',
        errorCode: 'hot_apply_failed',
        diagnostics: {
          underlyingError: 'timeout of 5000ms exceeded',
        },
      },
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'resumed_awaiting_proof',
      lastError: 'recovery_unproven_awaiting_provider_outcome',
    });

    await expect(scheduler.markProviderOutcomeProofByKey({
      recoveryKey,
      proofKind: 'provider_activity',
    })).resolves.toMatchObject({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    expect(scheduler.readByKey(recoveryKey)).toMatchObject({
      status: 'recovered',
      lastSettledTransition: 'recovered',
    });
    expect(diagnostics).toContain('runtime_auth_recovery_success');
  });

  it('marks durable recovery wake-ups as scheduler retries for downstream recovery guards', async () => {
    const recover = vi.fn(async () => ({ status: 'credential_refreshed' as const }));
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover,
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(recover).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: expect.objectContaining({ serviceId: 'openai-codex' }),
      source: 'scheduler_retry',
    }));
  });

  it('does NOT clear recovery on a generic ok:true switch result without proof (keeps it pending)', async () => {
    const diagnostics: string[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'switch_attempted',
        result: {
          ok: true,
          action: 'restart_requested',
        },
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event.event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      lastError: 'recovery_unproven_awaiting_provider_outcome',
    });
    expect(diagnostics).not.toContain('runtime_auth_recovery_success');
  });

  it('clears recovery when provider activity is proven', async () => {
    const diagnostics: string[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'switch_attempted',
        result: {
          status: 'provider_outcome_observed',
          proofKind: 'provider_activity',
        },
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event.event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'succeeded' });

    expect(scheduler.read('session-1')).toBeNull();
    expect(diagnostics).toContain('runtime_auth_recovery_success');
    expect(diagnostics).not.toContain('runtime_auth_recovery_terminal');
  });

  it('keeps recovery waiting when a genuinely fresh candidate is selected without later provider proof', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'switch_attempted',
        result: {
          status: 'switched',
          fromProfileId: 'primary',
          activeProfileId: 'backup',
          generation: 2,
        },
      }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      lastError: 'recovery_unproven_awaiting_provider_outcome',
    });
  });

  it('schedules a fresh same-key recovery after later provider proof clears a fresh-candidate wait', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'switch_attempted',
        result: {
          status: 'switched',
          fromProfileId: 'primary',
          activeProfileId: 'backup',
          generation: 2,
        },
      }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });
    await expect(scheduler.markProviderOutcomeProofByKey({
      recoveryKey,
      proofKind: 'provider_activity',
    })).resolves.toMatchObject({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });

    await expect(scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    })).resolves.toMatchObject({
      status: 'scheduled',
      retryable: true,
    });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 0,
    });
  });

  it('keeps stale-profile proof waits pending until provider outcome proof arrives', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'switch_attempted',
        result: {
          status: 'observed_generation',
          activeProfileId: 'backup',
          generation: 2,
        },
      }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      attemptCount: 1,
      pendingTargetProfileId: 'backup',
      pendingTargetGeneration: 2,
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      pendingTargetProfileId: 'backup',
      pendingTargetGeneration: 2,
    });
  });

  it('retains retry and dead-letter state for repeated stale-profile proof waits without provider proof', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let recoverRuns = 0;
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 3,
      maxCoalescedReplays: 2,
      recover: async () => {
        recoverRuns += 1;
        return {
          status: 'switch_attempted',
          result: {
            status: 'observed_generation',
            activeProfileId: 'backup',
            generation: 2,
          },
        };
      },
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
    });

    // The first wake records the committed target. Later wakes for the original
    // failing profile must not delete the durable intent merely because the
    // pending target differs; the scheduler owns bounded retry/dead-letter state
    // until provider outcome proof or terminal proof arrives.
    for (let i = 0; i < 20; i += 1) {
      nowMs += 10 * 60_000;
      await scheduler.wake({ sessionId: 'session-1', reason: 'manual' });
    }

    expect(recoverRuns).toBeGreaterThan(1);
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'exhausted',
      pendingTargetProfileId: 'backup',
    });
    expect(diagnostics.map((event) => event.event)).toContain('runtime_auth_recovery_dead_letter');
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_superseded');
  });

  it('removes a superseded recovery intent and lets the same key re-arm on a genuine future failure', async () => {
    // Incident 2026-06-12 (cmq8y3nlx): a stale persisted intent for a profile the session no
    // longer ran was replayed every retry. When the handler reports the recovery as superseded,
    // the intent must be REMOVED (not terminalized): a terminal record would block re-arming the
    // same recovery key on a genuine future failure (RD-REC-13), and a dead-letter would surface
    // a misleading "retry limit" to the user.
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_superseded',
        reason: 'failing_profile_inactive',
        serviceId: 'openai-codex',
        groupId: 'team',
        failingProfileId: 'primary',
        activeProfileId: 'backup',
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'superseded' });

    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });
    expect(scheduler.readByKey(recoveryKey)).toBeNull();
    expect(diagnostics.map((event) => event.event)).toContain('runtime_auth_recovery_superseded');
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_dead_letter');
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_terminal');

    // The key can re-arm immediately on a genuine future failure.
    await expect(scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
    })).resolves.toMatchObject({ status: 'scheduled', retryable: true });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting' });
  });

  it('supersedes (never terminalizes) an intent whose wake hands ownership to the temporary-throttle scheduler (A1-MED-1)', async () => {
    // A transient capacity failure (e.g. 529) durably enqueues a runtime-auth intent; on wake
    // the handler arms the TemporaryThrottleRecoveryScheduler and returns temporary_retry_armed.
    // Treating that unrecognized status as TERMINAL persisted an unclearable `cancelled` record
    // for 7 days, silently blocking durable retry for a subsequent REAL usage-limit on the key.
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'temporary_retry_armed',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team',
        retryAfterMs: 30_000,
        resetAtMs: null,
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'superseded' });

    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });
    expect(scheduler.readByKey(recoveryKey)).toBeNull();
    expect(diagnostics.map((event) => event.event)).toContain('runtime_auth_recovery_superseded');
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_terminal');

    // The key can re-arm immediately on a genuine future failure (e.g. a real usage limit).
    await expect(scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
    })).resolves.toMatchObject({ status: 'scheduled', retryable: true });
    expect(scheduler.readByKey(recoveryKey)).toMatchObject({ status: 'waiting' });
  });

  it('supersedes an intent when the temporary retry could not be armed instead of dead-lettering the key (A1-MED-1)', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'temporary_retry_unavailable',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'team',
        retryAfterMs: 30_000,
        resetAtMs: null,
        reason: 'scheduler_unavailable',
      }),
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: classification(),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'superseded' });
    const recoveryKey = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'team',
    });
    expect(scheduler.readByKey(recoveryKey)).toBeNull();
  });

  it('keeps stale-profile proof waits pending across churned group generations', async () => {
    // Sibling sessions may bump the shared group generation between replays. Once the pending
    // target profile differs from the original failing profile, the old intent is stale and must
    // clear instead of chasing newer generations for the same target profile.
    let generation = 2;
    const recover = vi.fn(async () => ({
      status: 'switch_attempted' as const,
      result: {
        status: 'observed_generation' as const,
        activeProfileId: 'backup',
        generation: generation++,
      },
    }));
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover,
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      attemptCount: 1,
      pendingTargetProfileId: 'backup',
      pendingTargetGeneration: 2,
    });

    // Replay reproduces the same target PROFILE at a churned generation.
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(recover).toHaveBeenCalledTimes(2);
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      pendingTargetProfileId: 'backup',
      pendingTargetGeneration: 3,
    });
  });

  it('does consume another retry attempt when the pending proof target itself re-fails', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async (input) => ({
        status: 'switch_attempted',
        result: {
          status: 'observed_generation',
          activeProfileId: 'backup',
          generation: 2,
          ...(input.classification.profileId === 'backup'
            ? { fromProfileId: 'backup' }
            : {}),
        },
      }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classificationFor({ profileId: 'backup' }),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      attemptCount: 2,
      pendingTargetProfileId: 'backup',
      pendingTargetGeneration: 2,
    });
  });

  it('does not supersede an original-profile proof wait before provider outcome proof', async () => {
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const recover = vi.fn(async () => ({
      status: 'switch_attempted' as const,
      result: {
        status: 'observed_generation' as const,
        activeProfileId: 'backup',
        generation: 2,
      },
    }));
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover,
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classificationFor({
        serviceId: 'openai-codex',
        groupId: 'codex-group',
        profileId: 'primary',
      }),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      classification: expect.objectContaining({ profileId: 'primary' }),
      pendingTargetProfileId: 'backup',
      pendingTargetGeneration: 2,
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(recover).toHaveBeenCalledTimes(2);
    expect(scheduler.readByKey(buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-group',
    }))).toMatchObject({
      status: 'resumed_awaiting_proof',
      pendingTargetProfileId: 'backup',
    });
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_superseded');
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_dead_letter');
  });

  it('sanitizes provider handler error messages before persisting recovery diagnostics', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'credential_refreshed' }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout Bearer raw-secret-token refreshToken=raw-refresh-token'),
    });

    const intent = scheduler.read('session-1');
    expect(intent?.lastError).not.toContain('raw-secret-token');
    expect(intent?.lastError).not.toContain('raw-refresh-token');
    expect(intent?.lastError).toContain('[REDACTED]');
  });

  it('keeps recovery WAITING (not terminal) when a recovery fetch hits ECONNREFUSED (session_endpoint_unavailable)', async () => {
    // Reproduces the live incident: an unreachable session control endpoint during recovery must
    // NOT be terminalized — it is a transient outage that should stay retryable/waiting.
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const econnrefused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:52753'), {
      code: 'ECONNREFUSED',
    });
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => {
        throw econnrefused;
      },
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({ status: 'waiting' });
    const events = diagnostics.map((event) => event.event);
    expect(events).not.toContain('runtime_auth_recovery_terminal');
    expect(events).not.toContain('runtime_auth_recovery_success');
  });

  it('does NOT dead-letter on the first endpoint-unavailable network failure', async () => {
    // A single local outage must not consume the whole attempt budget toward exhausted.
    const econnrefused = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 5,
      recover: async () => {
        throw econnrefused;
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    await scheduler.wake({ sessionId: 'session-1', reason: 'manual' });
    const intent = scheduler.read('session-1');
    expect(intent?.status).toBe('waiting');
    expect(intent?.attemptCount).toBeLessThan(intent?.maxAttempts ?? 0);
  });

  it('keeps recovery WAITING when the handler returns a daemon_lifecycle_unavailable deferral', async () => {
    // The recovery handler early-returned because the daemon was shutting down. This must not be a
    // success and must not be terminal: stay waiting so a healthy future daemon re-drives it.
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'daemon_lifecycle_unavailable',
        reason: 'recovery_deferred_shutdown',
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      lastError: 'recovery_deferred_shutdown',
    });
    const events = diagnostics.map((event) => event.event);
    expect(events).not.toContain('runtime_auth_recovery_success');
    expect(events).not.toContain('runtime_auth_recovery_terminal');
  });

  it('does NOT dead-letter after MANY consecutive endpoint-unavailable results (degraded retries do not advance attemptCount)', async () => {
    // S2: a long local-endpoint outage must not dead-letter a recoverable session faster than a
    // real provider failure. Degraded lifecycle/endpoint-unavailable retries are a separate track
    // that does not consume the normal attempt budget toward max/dead-letter.
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 3,
      recover: async () => ({
        status: 'session_endpoint_unavailable',
        reason: 'connect ECONNREFUSED 127.0.0.1:52753',
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    // Drive far more wakes than maxAttempts; with only endpoint-unavailable results it must never
    // dead-letter.
    for (let i = 0; i < 10; i += 1) {
      await scheduler.wake({ sessionId: 'session-1', reason: 'manual' });
      nowMs += 10_000;
    }

    const intent = scheduler.read('session-1');
    expect(intent?.status).toBe('waiting');
    const events = diagnostics.map((event) => event.event);
    expect(events).not.toContain('runtime_auth_recovery_dead_letter');
    expect(events).not.toContain('runtime_auth_recovery_terminal');
    // The normal attempt budget is untouched by degraded retries.
    expect(intent?.attemptCount ?? 0).toBeLessThan(intent?.maxAttempts ?? 0);
  });

  it('atomically persists the terminal visible event when the degraded recovery budget is exhausted', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxDegradedAttempts: 1,
      recover: async () => ({
        status: 'session_endpoint_unavailable',
        reason: 'connect ECONNREFUSED 127.0.0.1:52753',
      }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-degraded-terminal',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-degraded-terminal', reason: 'manual' }))
      .resolves.toEqual({ status: 'terminal' });

    const terminalIntent = scheduler.read('session-degraded-terminal');
    expect(terminalIntent).toMatchObject({
      status: 'cancelled',
      lastSettledTransition: 'terminal',
      terminalReason: 'degraded_recovery_attempts_exhausted',
    });
    expect(terminalIntent?.pendingVisibleEvents).toContainEqual(expect.objectContaining({
        attemptId: expect.stringMatching(/^runtime-auth-attempt:/),
        transition: 'terminal',
        transcriptEvent: expect.objectContaining({
          type: 'connected-service-runtime-auth-recovery',
          status: 'cancelled',
          terminal: true,
          reason: 'degraded_recovery_attempts_exhausted',
        }),
      }));
  });

  it('still dead-letters a genuine retryable provider failure within the normal attempt budget', async () => {
    // Guard against over-suppression: a real (non-degraded) retryable failure must still count
    // toward max_attempts and dead-letter as before.
    const diagnostics: RuntimeAuthRecoveryDiagnostic[] = [];
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 3,
      recover: async () => ({
        status: 'generation_apply_failed',
        errorCode: 'hot_apply_failed',
        diagnostics: { underlyingError: 'connect ECONNREFUSED 127.0.0.1:9999' },
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    for (let i = 0; i < 5; i += 1) {
      await scheduler.wake({ sessionId: 'session-1', reason: 'manual' });
      nowMs += 10_000;
    }

    const events = diagnostics.map((event) => event.event);
    expect(events).toContain('runtime_auth_recovery_dead_letter');
  });

  it('keeps recovery WAITING when the handler returns a session_endpoint_unavailable result', async () => {
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'session_endpoint_unavailable',
        reason: 'connect ECONNREFUSED 127.0.0.1:52753',
      }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: classification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      lastError: 'session_endpoint_unavailable',
    });
  });
});
