import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceRuntimeFailureClassification } from './types';
import { buildRuntimeAuthRecoveryKey } from './runtimeAuthRecoveryKey';

type RuntimeAuthRecoveryModule = Readonly<{
  RuntimeAuthRecoveryScheduler: new (deps: {
    nowMs: () => number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    jitterMs?: () => number;
    maxAttempts?: number;
    maxCoalescedReplays?: number;
    maxDegradedAttempts?: number;
    degradedBackoffMs?: number;
    providerOutcomePendingWaitMs?: number;
    recover: (input: {
      sessionId: string;
      switchesThisTurn: number;
      classification: ConnectedServiceRuntimeFailureClassification;
      recoveryInvocationSource?: 'scheduler_retry';
    }) => Promise<unknown>;
    gate?: (input: { sessionId: string; intent: unknown }) =>
      | { status: 'open' }
      | { status: 'delayed'; retryAtMs: number; reason: string };
    recordDiagnostic?: (event: unknown) => void;
  }) => {
    beginClassifiedFailure: (input: {
      sessionId: string;
      switchesThisTurn: number;
      classification: ConnectedServiceRuntimeFailureClassification;
    }) => Promise<{ status: string; retryable: boolean; nextRetryAtMs?: number | null }>;
    enqueueHandlerFailure: (input: {
      sessionId: string;
      switchesThisTurn: number;
      classification: ConnectedServiceRuntimeFailureClassification;
      error: unknown;
    }) => Promise<{ status: string; retryable: boolean; nextRetryAtMs?: number | null }>;
    enqueueApplyFailure: (input: {
      sessionId: string;
      switchesThisTurn: number;
      classification: ConnectedServiceRuntimeFailureClassification;
      result: unknown;
    }) => Promise<{ status: string; retryable: boolean; nextRetryAtMs?: number | null }>;
    read: (sessionId: string) => unknown | null;
    readForSession: (sessionId: string) => ReadonlyArray<unknown>;
    wake: (input: { sessionId: string; reason: 'timer' | 'manual' }) => Promise<{ status: string }>;
    cancel: (input: { sessionId: string }) => Promise<unknown | null>;
    cancelByKey: (input: {
      sessionId: string;
      serviceId: string;
      profileId: string | null;
      groupId: string | null;
    }) => Promise<unknown | null>;
    markSucceededByKey: (input: {
      sessionId: string;
      serviceId: string;
      profileId: string | null;
      groupId: string | null;
    }) => Promise<unknown | null>;
    markAwaitingProviderOutcomeProofByKey: (input: {
      sessionId: string;
      serviceId: string;
      profileId: string | null;
      groupId: string | null;
    }) => Promise<unknown | null>;
    markProviderOutcomeProofByIdentity: (input: {
      sessionId: string;
      proofKind: string;
      serviceId: string;
      profileId: string | null;
      groupId: string | null;
    }) => Promise<ReadonlyArray<unknown>>;
  };
}>;

async function loadModule(): Promise<RuntimeAuthRecoveryModule> {
  const loaded = await import('./RuntimeAuthRecoveryScheduler').catch(() => null);
  expect(loaded).not.toBeNull();
  return loaded as RuntimeAuthRecoveryModule;
}

function usageLimitClassification(
  overrides: Partial<ConnectedServiceRuntimeFailureClassification> = {},
): ConnectedServiceRuntimeFailureClassification {
  return {
    kind: 'usage_limit',
    limitCategory: 'usage_limit',
    serviceId: 'openai-codex',
    profileId: 'primary',
    groupId: 'codex-main',
    resetsAtMs: null,
    retryAfterMs: null,
    quotaScope: 'account',
    providerLimitId: 'weekly',
    action: null,
    planType: null,
    rateLimits: null,
    source: 'structured_provider_error',
    ...overrides,
  };
}

function applyFailedResult(errorCode: string, diagnostics?: unknown): unknown {
  return {
    status: 'switch_attempted',
    result: {
      status: 'generation_apply_failed',
      activeProfileId: 'backup',
      generation: 3,
      errorCode,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    },
  };
}

describe('RuntimeAuthRecoveryScheduler', () => {
  it('persists the concrete terminal recovery status when recovery ends action-required', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_action_required',
        action: {
          kind: 'reconnect_profile',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'codex-main',
          reason: 'usage_limit',
        },
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' })).resolves.toEqual({ status: 'terminal' });

    expect(scheduler.read('sess_1')).toMatchObject({
      status: 'cancelled',
      terminalReason: 'recovery_action_required',
    });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
        sessionId: 'sess_1',
        reason: 'recovery_action_required',
      }),
    ]));
  });

  it('waits until the group reset when no eligible member is temporarily exhausted', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'no_eligible_member',
        generation: 12,
        groupExhausted: true,
        retryAtMs: 5_000,
        excluded: [],
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('sess_1')).toMatchObject({
      status: 'waiting',
      nextRetryAtMs: 5_000,
      lastError: 'no_eligible_member',
      terminalReason: null,
    });
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_auth_recovery_terminal', sessionId: 'sess_1' }),
    ]));
  });

  it('arms a durable wait (not terminal) for a non-group recovery_action_required with a known future reset (incident Jun-11 F-NEW-1)', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_action_required',
        action: {
          kind: 'profile_action_required',
          serviceId: 'claude-subscription',
          profileId: 'pinned-profile',
          groupId: null,
          reason: 'usage_limit',
        },
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_pinned',
      switchesThisTurn: 0,
      classification: usageLimitClassification({
        serviceId: 'claude-subscription',
        profileId: 'pinned-profile',
        groupId: null,
        resetsAtMs: 3_600_000,
      }),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'sess_pinned', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('sess_pinned')).toMatchObject({
      status: 'waiting',
      nextRetryAtMs: 3_600_000,
      lastError: 'awaiting_limit_reset',
      terminalReason: null,
    });
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_auth_recovery_terminal', sessionId: 'sess_pinned' }),
    ]));
  });

  it('arms a durable wait for a native (not_group_selection) waitable limit failure with a known future reset', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({ status: 'not_group_selection' }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_native',
      switchesThisTurn: 0,
      classification: usageLimitClassification({
        serviceId: 'claude-subscription',
        profileId: null,
        groupId: null,
        resetsAtMs: 7_200_000,
      }),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'sess_native', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('sess_native')).toMatchObject({
      status: 'waiting',
      nextRetryAtMs: 7_200_000,
      lastError: 'awaiting_limit_reset',
      terminalReason: null,
    });
  });

  it('keeps a non-group recovery_action_required terminal when no wait-until is computable', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_action_required',
        action: {
          kind: 'profile_action_required',
          serviceId: 'claude-subscription',
          profileId: 'pinned-profile',
          groupId: null,
          reason: 'usage_limit',
        },
      }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_pinned_no_reset',
      switchesThisTurn: 0,
      classification: usageLimitClassification({
        serviceId: 'claude-subscription',
        profileId: 'pinned-profile',
        groupId: null,
        resetsAtMs: null,
      }),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'sess_pinned_no_reset', reason: 'manual' })).resolves.toEqual({ status: 'terminal' });
    expect(scheduler.read('sess_pinned_no_reset')).toMatchObject({
      status: 'cancelled',
      terminalReason: 'recovery_action_required',
    });
  });

  it('retries a provider_state_sharing_settings_unavailable apply failure instead of terminalizing (incident Jun-11 H-A)', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => applyFailedResult('provider_state_sharing_settings_unavailable'),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await expect(scheduler.enqueueApplyFailure({
      sessionId: 'sess_settings_gap',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      result: applyFailedResult('provider_state_sharing_settings_unavailable'),
    })).resolves.toMatchObject({
      status: 'scheduled',
      retryable: true,
    });
    expect(scheduler.read('sess_settings_gap')).toMatchObject({
      status: 'waiting',
      lastErrorClassification: expect.objectContaining({ kind: 'dependency_unavailable', retryable: true }),
    });

    await expect(scheduler.wake({ sessionId: 'sess_settings_gap', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('sess_settings_gap')).toMatchObject({
      status: 'waiting',
      terminalReason: null,
    });
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_auth_recovery_terminal', sessionId: 'sess_settings_gap' }),
    ]));
  });

  it('classifies missing resume-state continuity as retryable until durable reconstruction is exhausted', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => applyFailedResult('provider_session_state_unavailable_for_resume'),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await expect(scheduler.enqueueApplyFailure({
      sessionId: 'sess_resume_gap',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      result: applyFailedResult('provider_session_state_unavailable_for_resume', {
        failurePhase: 'continuity',
        durableContinuity: {
          trackedSession: null,
          trackedSpawnOptions: null,
          persistedSessionMetadata: null,
          vendorResumeId: null,
          candidatePersistedSessionFile: null,
          materializationIdentity: null,
        },
      }),
    })).resolves.toMatchObject({
      status: 'scheduled',
      retryable: true,
    });
    expect(scheduler.read('sess_resume_gap')).toMatchObject({
      status: 'waiting',
      failurePhase: 'apply',
      failureReason: 'durable_continuity_reconstruction_retrying',
      lastError: 'provider_session_state_unavailable_for_resume',
      lastErrorClassification: expect.objectContaining({ kind: 'dependency_unavailable', retryable: true }),
    });
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_auth_recovery_terminal', sessionId: 'sess_resume_gap' }),
    ]));
  });

  it('terminalizes missing resume-state continuity only after durable reconstruction is exhausted', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => applyFailedResult('provider_session_state_unavailable_for_resume'),
      recordDiagnostic: (event) => {
        diagnostics.push(event);
      },
    });

    await expect(scheduler.enqueueApplyFailure({
      sessionId: 'sess_resume_exhausted',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      result: applyFailedResult('provider_session_state_unavailable_for_resume', {
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
      }),
    })).resolves.toMatchObject({
      status: 'terminal_non_retry',
      retryable: false,
      reason: 'provider_session_state_unavailable_after_reconstruction',
    });
    expect(scheduler.read('sess_resume_exhausted')).toBeNull();
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
        sessionId: 'sess_resume_exhausted',
        reason: 'provider_session_state_unavailable_after_reconstruction',
        failurePhase: 'apply',
      }),
    ]));
  });

  it('keeps missing resume-state continuity retryable on wake until reconstruction reports exhausted', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => applyFailedResult('provider_session_state_unavailable_for_resume', {
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
      }),
    });

    await expect(scheduler.enqueueApplyFailure({
      sessionId: 'sess_resume_wake',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      result: applyFailedResult('provider_session_state_unavailable_for_resume', {
        failurePhase: 'continuity',
        durableContinuity: {
          trackedSession: null,
          trackedSpawnOptions: null,
          persistedSessionMetadata: null,
          vendorResumeId: null,
          candidatePersistedSessionFile: null,
          materializationIdentity: null,
        },
      }),
    })).resolves.toMatchObject({ status: 'scheduled', retryable: true });

    nowMs = 1_100;
    await expect(scheduler.wake({ sessionId: 'sess_resume_wake', reason: 'manual' }))
      .resolves.toEqual({ status: 'terminal' });
    expect(scheduler.read('sess_resume_wake')).toMatchObject({
      status: 'cancelled',
      terminalReason: 'provider_session_state_unavailable_after_reconstruction',
    });
  });

  it('sanitizes runtime classifications before retaining recovery state', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const unsafeClassification = {
      ...usageLimitClassification({
        providerLimitId: 'Bearer secret-provider-limit-token',
        planType: 'enterprise secret plan',
        action: {
          kind: 'open_url',
          url: 'https://example.com/recover?access_token=secret-access-token#secret-fragment',
        },
        recoveryAction: { kind: 'quota_recovery_required' },
      }),
      accessToken: 'secret-access-token',
      nested: { refreshToken: 'secret-refresh-token' },
      rateLimits: { refreshToken: 'secret-refresh-token' },
    } satisfies ConnectedServiceRuntimeFailureClassification & Record<string, unknown>;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: vi.fn(),
    });

    await expect(scheduler.enqueueHandlerFailure({
      sessionId: 'sess_sanitized',
      switchesThisTurn: 0,
      classification: unsafeClassification,
      error: new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'),
    })).resolves.toMatchObject({
      status: 'scheduled',
      retryable: true,
    });

    const persisted = scheduler.read('sess_sanitized');
    const persistedText = JSON.stringify(persisted);
    expect(persisted).toMatchObject({
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
        providerLimitId: null,
        action: null,
        planType: null,
        rateLimits: null,
        recoveryAction: { kind: 'quota_recovery_required' },
      },
    });
    expect(persistedText).not.toContain('secret-access-token');
    expect(persistedText).not.toContain('secret-refresh-token');
    expect(persistedText).not.toContain('secret-provider-limit-token');
    expect(persistedText).not.toContain('accessToken');
  });

  it('retains transient handler failures and retries through the canonical handler', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    let nowMs = 1_000;
    const classification = usageLimitClassification();
    const recover = vi.fn(async () => ({
      status: 'switch_attempted',
      // Proven fresh-candidate switch: moved off the failed `primary` onto `backup`.
      result: { status: 'switched', fromProfileId: 'primary', activeProfileId: 'backup', generation: 2 },
    }));
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover,
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    await expect(scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification,
      error: new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'),
    })).resolves.toMatchObject({
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: 2_000,
    });
    expect(scheduler.read('sess_1')).toMatchObject({
      status: 'waiting',
      attemptCount: 0,
      failurePhase: 'handler',
      lastErrorClassification: expect.objectContaining({ kind: 'timeout', retryable: true }),
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });

    expect(recover).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification,
      recoveryInvocationSource: 'scheduler_retry',
    });
    expect(scheduler.read('sess_1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      attemptCount: 1,
    });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'runtime_auth_recovery_enqueue',
        sessionId: 'sess_1',
        transcriptEvent: expect.objectContaining({
          type: 'connected-service-runtime-auth-recovery',
          status: 'retry_scheduled',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'codex-main',
          terminal: false,
          diagnostic: expect.objectContaining({
            source: 'runtime_auth_recovery',
            failurePhase: 'runtime_auth_recovery',
          }),
        }),
      }),
      expect.objectContaining({ event: 'runtime_auth_recovery_retry', sessionId: 'sess_1', attemptCount: 1 }),
    ]));
  });

  it('marks only the matching composite recovery intent succeeded for a multi-service session', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: vi.fn(),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: usageLimitClassification({
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
      }),
      error: new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'),
    });
    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: usageLimitClassification({
        serviceId: 'anthropic',
        profileId: 'claude-primary',
        groupId: 'claude-main',
      }),
      error: new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'),
    });

    await expect(scheduler.markSucceededByKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
    })).resolves.toMatchObject({
      status: 'waiting',
      serviceId: 'openai-codex',
    });

    expect(scheduler.readForSession('sess_1')).toEqual([
      expect.objectContaining({
        status: 'waiting',
        serviceId: 'anthropic',
      }),
    ]);
  });

  it('clears matching active intents on provider-activity proof and leaves non-matching intents untouched', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: vi.fn(),
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: usageLimitClassification({
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
      }),
      error: new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'),
    });
    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: usageLimitClassification({
        serviceId: 'anthropic',
        profileId: 'claude-primary',
        groupId: 'claude-main',
      }),
      error: new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'),
    });

    // Group-backed identity: provider activity reported for ANY profile of the
    // recovering group must clear the group-keyed intent.
    const cleared = await scheduler.markProviderOutcomeProofByIdentity({
      sessionId: 'sess_1',
      proofKind: 'provider_activity',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'codex-main',
    });

    expect(cleared).toEqual([
      expect.objectContaining({ serviceId: 'openai-codex', groupId: 'codex-main' }),
    ]);
    expect(scheduler.readForSession('sess_1')).toEqual([
      expect.objectContaining({ status: 'waiting', serviceId: 'anthropic' }),
    ]);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'runtime_auth_recovery_success',
        sessionId: 'sess_1',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
      }),
    ]));
  });

  it('keeps duplicate group recovery intents separate when the failing access-token fingerprint differs', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: vi.fn(),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: {
        ...usageLimitClassification({
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'codex-main',
        }),
        failingAccessTokenFingerprint: 'token-before-refresh',
      } as ConnectedServiceRuntimeFailureClassification,
      error: new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'),
    });
    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: {
        ...usageLimitClassification({
          serviceId: 'openai-codex',
          profileId: 'backup',
          groupId: 'codex-main',
        }),
        failingAccessTokenFingerprint: 'token-after-refresh',
      } as ConnectedServiceRuntimeFailureClassification,
      error: new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'),
    });

    expect(scheduler.readForSession('sess_1')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'waiting',
        profileId: 'primary',
        classification: expect.objectContaining({ failingAccessTokenFingerprint: 'token-before-refresh' }),
      }),
      expect.objectContaining({
        status: 'waiting',
        profileId: 'backup',
        classification: expect.objectContaining({ failingAccessTokenFingerprint: 'token-after-refresh' }),
      }),
    ]));
    expect(scheduler.readForSession('sess_1')).toHaveLength(2);
  });

  it('does not clear intents for non-recovered proof kinds or terminal intents', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: vi.fn(),
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: usageLimitClassification({
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'codex-main',
      }),
      error: new Error('Failed to get connected service auth group: timeout of 5000ms exceeded'),
    });

    // Intermediate evidence is NOT a recovered proof: it must not clear the intent.
    await expect(scheduler.markProviderOutcomeProofByIdentity({
      sessionId: 'sess_1',
      proofKind: 'fresh_candidate_selected',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
    })).resolves.toEqual([]);
    expect(scheduler.readForSession('sess_1')).toEqual([
      expect.objectContaining({ status: 'waiting', serviceId: 'openai-codex' }),
    ]);

    // A cancelled (terminal) intent stays a terminal record; provider activity must
    // not resurrect or clear it as succeeded.
    await scheduler.cancelByKey({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
    });
    await expect(scheduler.markProviderOutcomeProofByIdentity({
      sessionId: 'sess_1',
      proofKind: 'provider_activity',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
    })).resolves.toEqual([]);
    expect(scheduler.readForSession('sess_1')).toEqual([
      expect.objectContaining({ status: 'cancelled', serviceId: 'openai-codex' }),
    ]);
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_auth_recovery_success' }),
    ]));
  });

  it('clears an exhausted dead-letter on later recovered provider-outcome proof and emits a recovered resolution', async () => {
    // Incident 2026-06-12 (cmq8y3nlx): a defect-artifact dead-letter kept a permanent
    // "retry limit" banner alive for a healthy account. Positive provider-outcome proof
    // (real provider activity under the same recovery identity) must remove the durable
    // exhausted record (freeing the key to re-arm fresh) and publish a terminal
    // `recovered` resolution — the dead-letter row's closing counterpart.
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => {
        throw new Error('timeout of 5000ms exceeded');
      },
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await scheduler.wake({ sessionId: 'sess_1', reason: 'manual' });
    expect(scheduler.readForSession('sess_1')).toEqual([
      expect.objectContaining({ status: 'exhausted' }),
    ]);

    const cleared = await scheduler.markProviderOutcomeProofByIdentity({
      sessionId: 'sess_1',
      proofKind: 'provider_activity',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
    });

    expect(cleared).toEqual([
      expect.objectContaining({ serviceId: 'openai-codex', status: 'exhausted' }),
    ]);
    expect(scheduler.readForSession('sess_1')).toEqual([]);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'runtime_auth_recovery_success',
        sessionId: 'sess_1',
        reason: 'dead_letter_resolved_by_provider_outcome_proof',
        transcriptEvent: expect.objectContaining({
          status: 'recovered',
          terminal: true,
        }),
      }),
    ]));

    // The key re-arms fresh on a genuine future failure.
    await expect(scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    })).resolves.toMatchObject({ status: 'scheduled', retryable: true });
    expect(scheduler.readForSession('sess_1')).toEqual([
      expect.objectContaining({ status: 'waiting', attemptCount: 0 }),
    ]);
  });

  it('does not clear an exhausted dead-letter through non-recovered or terminal proof kinds', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 1,
      recover: async () => {
        throw new Error('timeout of 5000ms exceeded');
      },
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await scheduler.wake({ sessionId: 'sess_1', reason: 'manual' });
    expect(scheduler.readForSession('sess_1')).toEqual([
      expect.objectContaining({ status: 'exhausted' }),
    ]);

    // Intermediate evidence and terminal proof kinds must leave the dead-letter honest.
    await expect(scheduler.markProviderOutcomeProofByIdentity({
      sessionId: 'sess_1',
      proofKind: 'fresh_candidate_selected',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
    })).resolves.toEqual([]);
    await expect(scheduler.markProviderOutcomeProofByIdentity({
      sessionId: 'sess_1',
      proofKind: 'terminal_exhausted',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'codex-main',
    })).resolves.toEqual([]);
    expect(scheduler.readForSession('sess_1')).toEqual([
      expect.objectContaining({ status: 'exhausted' }),
    ]);
  });

  it('routes thrown generation apply failures through apply-failure retry classification', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: vi.fn(),
    });
    const error = new Error('connected_service_auth_generation_apply_failed:post_switch_verification_failed');
    Object.assign(error, {
      connectedServiceAuthGenerationApplyFailure: {
        errorCode: 'post_switch_verification_failed',
        diagnostics: {
          retryable: true,
          verification: {
            reason: 'active_account_probe_missing_account_id',
          },
        },
      },
    });

    await expect(scheduler.enqueueHandlerFailure({
      sessionId: 'sess_apply',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
      error,
    })).resolves.toMatchObject({
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: 2_000,
    });

    expect(scheduler.read('sess_apply')).toMatchObject({
      status: 'waiting',
      failurePhase: 'apply',
      failureReason: 'post_switch_verification_failed',
      lastError: 'active_account_probe_missing_account_id',
      lastErrorClassification: expect.objectContaining({ kind: 'protocol_error', retryable: true }),
    });
  });

  it('routes thrown missing resume-state apply failures through durable-continuity retry classification', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: vi.fn(),
    });
    const error = new Error('connected_service_auth_generation_apply_failed:provider_session_state_unavailable_for_resume');
    Object.assign(error, {
      connectedServiceAuthGenerationApplyFailure: {
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
    });

    await expect(scheduler.enqueueHandlerFailure({
      sessionId: 'sess_thrown_resume_gap',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
      error,
    })).resolves.toMatchObject({
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: 2_000,
    });

    expect(scheduler.read('sess_thrown_resume_gap')).toMatchObject({
      status: 'waiting',
      failurePhase: 'apply',
      failureReason: 'durable_continuity_reconstruction_retrying',
      lastError: 'provider_session_state_unavailable_for_resume',
      lastErrorClassification: expect.objectContaining({ kind: 'dependency_unavailable', retryable: true }),
    });
  });

  it('backs off stale-process restart failures during recovery instead of cancelling the intent', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 4_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      jitterMs: () => 0,
      recover: async () => applyFailedResult('restart_failed', {
        failurePhase: 'restart',
        retryable: true,
        underlyingError: 'Error (code=ESRCH): kill ESRCH',
      }),
    });

    await scheduler.enqueueApplyFailure({
      sessionId: 'sess_restart',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
      result: applyFailedResult('provider_account_adoption_mismatch', {
        retryable: true,
        verification: { reason: 'provider_account_adoption_mismatch' },
      }),
    });

    await expect(scheduler.wake({ sessionId: 'sess_restart', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('sess_restart')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      failurePhase: 'apply',
      failureReason: 'restart_failed',
      lastError: 'restart_failed',
      lastErrorClassification: expect.objectContaining({ kind: 'protocol_error', retryable: true }),
    });
  });

  it('keeps a bare credential_refreshed recovery waiting (no provider-outcome proof)', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: async () => ({ status: 'credential_refreshed', restartRequested: true }),
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    await scheduler.enqueueApplyFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      result: applyFailedResult('hot_apply_failed', {
        failurePhase: 'hot_apply',
        underlyingError: 'Codex app-server request timed out after 5000ms',
      }),
    });

    // A fresh token minted by refresh is not proof the provider accepts it; the
    // recovery must stay pending, not be fabricated as recovered or terminalized.
    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });

    expect(scheduler.read('sess_1')).toMatchObject({ status: 'resumed_awaiting_proof' });
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_auth_recovery_success', sessionId: 'sess_1' }),
    ]));
    expect(diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_auth_recovery_terminal', sessionId: 'sess_1' }),
    ]));
  });

  it('marks a locally completed recovery as awaiting provider-outcome proof by recovery identity', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      providerOutcomePendingWaitMs: 5_000,
      recover: async () => ({ status: 'credential_refreshed' }),
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'sess_claude_group',
      switchesThisTurn: 0,
      classification: usageLimitClassification({
        kind: 'auth_expired',
        serviceId: 'claude-subscription',
        profileId: 'primary',
        groupId: 'claude',
        limitCategory: undefined,
        retryAfterMs: undefined,
        quotaScope: undefined,
        providerLimitId: undefined,
      }),
    });

    await expect(scheduler.markAwaitingProviderOutcomeProofByKey({
      sessionId: 'sess_claude_group',
      serviceId: 'claude-subscription',
      profileId: 'primary',
      groupId: 'claude',
    })).resolves.toEqual(expect.objectContaining({
      status: 'resumed_awaiting_proof',
      pendingTargetProfileId: 'primary',
      pendingTargetGeneration: null,
      nextRetryAtMs: 6_000,
    }));
    expect(scheduler.read('sess_claude_group')).toMatchObject({
      status: 'resumed_awaiting_proof',
      pendingTargetProfileId: 'primary',
      pendingTargetGeneration: null,
      nextRetryAtMs: 6_000,
    });
  });

  it('does not dead-letter repeated untargeted local completions while provider outcome proof is pending', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
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

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
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
      expect(intent).not.toMatchObject({ status: 'exhausted' });
      nowMs += 250;
    }
  });

	  it('keeps a bare ok:true switch recovery waiting (no provider-outcome proof)', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: async () => ({
        status: 'switch_attempted',
        result: {
          ok: true,
          action: 'restart_requested',
        },
      }),
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    await scheduler.enqueueApplyFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      result: applyFailedResult('hot_apply_failed', {
        failurePhase: 'hot_apply',
        underlyingError: 'Codex app-server request timed out after 5000ms',
      }),
    });

    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' })).resolves.toEqual({ status: 'waiting' });

	    expect(scheduler.read('sess_1')).toMatchObject({ status: 'resumed_awaiting_proof' });
	    expect(diagnostics).not.toEqual(expect.arrayContaining([
	      expect.objectContaining({ event: 'runtime_auth_recovery_success', sessionId: 'sess_1' }),
	    ]));
	  });

	  it('clears a proven account-adoption-verified switch recovery as success', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: async () => ({
        status: 'switch_attempted',
        result: {
          ok: true,
          action: 'restart_requested',
          verificationByServiceId: { 'openai-codex': { status: 'verified' } },
        },
      }),
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    await scheduler.enqueueApplyFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      result: applyFailedResult('hot_apply_failed', {
        failurePhase: 'hot_apply',
        underlyingError: 'Codex app-server request timed out after 5000ms',
      }),
    });

    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' })).resolves.toEqual({ status: 'succeeded' });

	    expect(scheduler.read('sess_1')).toBeNull();
	    expect(diagnostics).toEqual(expect.arrayContaining([
	      expect.objectContaining({ event: 'runtime_auth_recovery_success', sessionId: 'sess_1' }),
	    ]));
	  });

	  it('schedules a fresh same-key recovery after a previous recovery succeeds', async () => {
	    const { RuntimeAuthRecoveryScheduler } = await loadModule();
	    const scheduler = new RuntimeAuthRecoveryScheduler({
	      nowMs: () => 1_000,
	      baseBackoffMs: 1_000,
	      maxBackoffMs: 10_000,
	      recover: async () => ({
	        status: 'switch_attempted',
	        result: {
	          ok: true,
	          action: 'restart_requested',
	          verificationByServiceId: { 'openai-codex': { status: 'verified' } },
	        },
	      }),
	    });

	    await scheduler.enqueueHandlerFailure({
	      sessionId: 'sess_1',
	      switchesThisTurn: 0,
	      classification: usageLimitClassification(),
	      error: new Error('timeout of 5000ms exceeded'),
	    });
	    await expect(scheduler.wake({ sessionId: 'sess_1', reason: 'manual' })).resolves.toEqual({ status: 'succeeded' });

	    await expect(scheduler.enqueueHandlerFailure({
	      sessionId: 'sess_1',
	      switchesThisTurn: 0,
	      classification: usageLimitClassification(),
	      error: new Error('timeout of 5000ms exceeded again'),
	    })).resolves.toMatchObject({
	      status: 'scheduled',
	      retryable: true,
	    });
	    expect(scheduler.read('sess_1')).toMatchObject({
	      status: 'waiting',
	      attemptCount: 0,
	    });
	  });

  it('sanitizes provider handler error messages before persisting recovery diagnostics', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: async () => ({ status: 'credential_refreshed' }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('provider timeout with authorization=Bearer raw-secret-token and refreshToken=raw-refresh-token'),
    });

    const serialized = JSON.stringify(scheduler.read('sess_1'));
    expect(serialized).not.toContain('raw-secret-token');
    expect(serialized).not.toContain('raw-refresh-token');
    expect(serialized).toContain('[REDACTED]');
  });

  it('does not retry terminal handler or terminal recovery results', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const terminalRecover = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'invalid_credentials',
      },
    }));
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      recover: terminalRecover,
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    await expect(scheduler.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: usageLimitClassification({ kind: 'validation', limitCategory: 'validation_failed' }),
      error: Object.assign(new Error('credential validation failed'), { status: 400 }),
    })).resolves.toMatchObject({
      status: 'terminal_non_retry',
      retryable: false,
    });
    expect(scheduler.read('sess_1')).toBeNull();

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_2',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'sess_2', reason: 'timer' })).resolves.toEqual({ status: 'terminal' });
    expect(scheduler.read('sess_2')).toMatchObject({ status: 'cancelled' });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_auth_recovery_terminal', sessionId: 'sess_1' }),
      expect.objectContaining({ event: 'runtime_auth_recovery_terminal', sessionId: 'sess_2' }),
    ]));
  });

  it('retries transient hot_apply_failed apply failures and rejects terminal hot_apply_failed failures', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      recover: vi.fn(),
      recordDiagnostic: (event) => diagnostics.push(event),
    });

    await expect(scheduler.enqueueApplyFailure({
      sessionId: 'sess_transient',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      result: applyFailedResult('hot_apply_failed', {
        failurePhase: 'hot_apply',
        underlyingError: 'Codex app-server request timed out after 5000ms',
      }),
    })).resolves.toMatchObject({
      status: 'scheduled',
      retryable: true,
      nextRetryAtMs: 2_000,
    });
    expect(scheduler.read('sess_transient')).toMatchObject({
      status: 'waiting',
      failurePhase: 'apply',
      lastErrorClassification: expect.objectContaining({ kind: 'timeout', retryable: true }),
    });

    await expect(scheduler.enqueueApplyFailure({
      sessionId: 'sess_terminal',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      result: applyFailedResult('hot_apply_failed', {
        failurePhase: 'hot_apply',
        underlyingError: 'Codex app-server rejected auth payload schema',
      }),
    })).resolves.toMatchObject({
      status: 'terminal_non_retry',
      retryable: false,
    });
    expect(scheduler.read('sess_terminal')).toBeNull();
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_auth_recovery_enqueue', sessionId: 'sess_transient' }),
      expect.objectContaining({
        event: 'runtime_auth_recovery_terminal',
        sessionId: 'sess_terminal',
        reason: 'non_retryable_apply_failure',
      }),
    ]));
  });

  it('delays retry during a local-server storm and dead-letters after max attempts', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: unknown[] = [];
    const recover = vi.fn(async () => {
      throw new Error('timeout of 5000ms exceeded');
    });
    let nowMs = 2_000;
    const delayed = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      maxAttempts: 1,
      recover,
      gate: () => ({ status: 'delayed', retryAtMs: 32_000, reason: 'local_server_storm' }),
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    await delayed.enqueueHandlerFailure({
      sessionId: 'sess_1',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    nowMs = 3_000;
    await expect(delayed.wake({ sessionId: 'sess_1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(recover).not.toHaveBeenCalled();
    expect(delayed.read('sess_1')).toMatchObject({
      status: 'waiting',
      nextRetryAtMs: 32_000,
      lastError: 'local_server_storm',
    });

    const deadLetter = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 3_000,
      maxAttempts: 1,
      recover,
      recordDiagnostic: (event) => diagnostics.push(event),
    });
    await deadLetter.enqueueHandlerFailure({
      sessionId: 'sess_2',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(deadLetter.wake({ sessionId: 'sess_2', reason: 'timer' })).resolves.toEqual({ status: 'exhausted' });
    expect(deadLetter.read('sess_2')).toMatchObject({ status: 'exhausted', attemptCount: 1 });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'runtime_auth_recovery_delayed', sessionId: 'sess_1' }),
      expect.objectContaining({
        event: 'runtime_auth_recovery_dead_letter',
        sessionId: 'sess_2',
        transcriptEvent: expect.objectContaining({
          type: 'connected-service-runtime-auth-recovery',
          status: 'dead_lettered',
          serviceId: 'openai-codex',
          profileId: 'primary',
          groupId: 'codex-main',
          terminal: true,
          diagnostic: expect.objectContaining({
            source: 'runtime_auth_recovery',
            failurePhase: 'runtime_auth_recovery',
          }),
        }),
      }),
    ]));
  });

  it('preserves same-key attempt state so repeated reports cannot bypass dead-lettering', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const recover = vi.fn(async () => {
      throw new Error('timeout of 5000ms exceeded');
    });
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      maxAttempts: 2,
      recover,
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_repeated',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'sess_repeated', reason: 'timer' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('sess_repeated')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
    });

    nowMs = 2_500;
    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_repeated',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded again'),
    });

    expect(scheduler.read('sess_repeated')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      maxAttempts: 2,
      nextRetryAtMs: 3_500,
      lastError: 'timeout of 5000ms exceeded again',
    });

    nowMs = 3_500;
    await expect(scheduler.wake({ sessionId: 'sess_repeated', reason: 'timer' }))
      .resolves.toEqual({ status: 'exhausted' });
    expect(scheduler.read('sess_repeated')).toMatchObject({
      status: 'exhausted',
      attemptCount: 2,
    });

    nowMs = 3_600;
    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_repeated',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded after dead letter'),
    });
    expect(scheduler.read('sess_repeated')).toMatchObject({
      status: 'exhausted',
      attemptCount: 2,
    });
  });

  it('does not revive a cancelled same-key recovery intent', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: vi.fn(),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_cancelled',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await scheduler.cancel({ sessionId: 'sess_cancelled' });
    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_cancelled',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded again'),
    });

    expect(scheduler.read('sess_cancelled')).toMatchObject({
      status: 'cancelled',
      attemptCount: 0,
    });
  });

  it('coalesces group-backed recoveries even when the reported profile changes within the same group', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover: async () => ({ status: 'credential_refreshed' }),
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_group',
      switchesThisTurn: 1,
      classification: usageLimitClassification({
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        profileId: 'member-a',
      }),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_group',
      switchesThisTurn: 2,
      classification: usageLimitClassification({
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        profileId: 'member-b',
      }),
      error: new Error('timeout of 5000ms exceeded again'),
    });

    expect(scheduler.read('sess_group')).toMatchObject({
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      profileId: 'member-b',
      switchesThisTurn: 2,
    });
  });

  it('coalesces duplicate reports while same-key recovery is in flight', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    let releaseRecovery!: () => void;
    const recover = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      return {
        status: 'switch_attempted',
        result: { status: 'switched', fromProfileId: 'primary', activeProfileId: 'backup', generation: 4 },
      };
    });
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 2_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      recover,
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_inflight',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    const wake = scheduler.wake({ sessionId: 'sess_inflight', reason: 'manual' });
    await expect.poll(() => recover.mock.calls.length).toBe(1);

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_inflight',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded duplicate'),
    });
    expect(scheduler.read('sess_inflight')).toMatchObject({
      status: 'checking',
      attemptCount: 1,
    });

    releaseRecovery();
    await expect(wake).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('sess_inflight')).toMatchObject({
      status: 'resumed_awaiting_proof',
      attemptCount: 1,
    });
  });

  it('does NOT dead-letter after MANY consecutive endpoint-unavailable results (degraded retries do not advance attemptCount)', async () => {
    // S2: a long local-endpoint outage must not dead-letter a recoverable session faster than a
    // real provider failure. Degraded lifecycle/endpoint-unavailable retries are a separate track
    // that does not consume the normal attempt budget toward max/dead-letter.
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: Array<{ event: string }> = [];
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
        diagnostics.push(event as { event: string });
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_degraded',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    // Drive far more wakes than maxAttempts; with only endpoint-unavailable results it must never
    // dead-letter.
    for (let i = 0; i < 10; i += 1) {
      await scheduler.wake({ sessionId: 'sess_degraded', reason: 'manual' });
      nowMs += 10_000;
    }

    const intent = scheduler.read('sess_degraded') as
      | { status: string; attemptCount: number; maxAttempts: number }
      | null;
    expect(intent?.status).toBe('waiting');
    const events = diagnostics.map((event) => event.event);
    expect(events).not.toContain('runtime_auth_recovery_dead_letter');
    expect(events).not.toContain('runtime_auth_recovery_terminal');
    // The normal attempt budget is untouched by degraded retries.
    expect(intent?.attemptCount ?? 0).toBeLessThan(intent?.maxAttempts ?? 0);
  });

  it('routes a handler-thrown ECONNREFUSED onto the degraded track (stays WAITING, no dead-letter)', async () => {
    // S2: a connection-level outage thrown during the recovery fetch is degraded, not a provider
    // failure; it must not burn the normal attempt budget.
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: Array<{ event: string }> = [];
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 3,
      recover: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:52753');
      },
      recordDiagnostic: (event) => {
        diagnostics.push(event as { event: string });
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_thrown',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    for (let i = 0; i < 10; i += 1) {
      await scheduler.wake({ sessionId: 'sess_thrown', reason: 'manual' });
      nowMs += 10_000;
    }

    const intent = scheduler.read('sess_thrown') as
      | { status: string; attemptCount: number; maxAttempts: number }
      | null;
    expect(intent?.status).toBe('waiting');
    const events = diagnostics.map((event) => event.event);
    expect(events).not.toContain('runtime_auth_recovery_dead_letter');
    expect(intent?.attemptCount ?? 0).toBeLessThan(intent?.maxAttempts ?? 0);
  });

  it('still dead-letters a genuine retryable provider failure within the normal attempt budget', async () => {
    // Guard against over-suppression: a real (non-degraded) retryable failure must still count
    // toward max_attempts and dead-letter as before.
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: Array<{ event: string }> = [];
    let nowMs = 1_000;
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      maxAttempts: 3,
      recover: async () => applyFailedResult('hot_apply_failed', {
        underlyingError: 'connect ECONNREFUSED 127.0.0.1:9999',
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event as { event: string });
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'sess_real',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });

    for (let i = 0; i < 5; i += 1) {
      await scheduler.wake({ sessionId: 'sess_real', reason: 'manual' });
      nowMs += 10_000;
    }

    const events = diagnostics.map((event) => event.event);
    expect(events).toContain('runtime_auth_recovery_dead_letter');
  });

  it('keeps stale-profile proof waits pending until provider outcome proof arrives', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const recover = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'observed_generation',
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
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
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
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(recover).toHaveBeenCalledTimes(2);
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      pendingTargetProfileId: 'backup',
      pendingTargetGeneration: 2,
    });
  });

  it('does consume another retry attempt when the pending proof target itself re-fails', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
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
      classification: usageLimitClassification(),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(scheduler.readForSession('session-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'resumed_awaiting_proof',
        attemptCount: 1,
        pendingTargetProfileId: 'backup',
        pendingTargetGeneration: 2,
      }),
    ]));

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: usageLimitClassification({ profileId: 'backup' }),
      error: new Error('timeout of 5000ms exceeded'),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });

    expect(scheduler.readForSession('session-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'resumed_awaiting_proof',
        attemptCount: 2,
        pendingTargetProfileId: 'backup',
        pendingTargetGeneration: 2,
      }),
    ]));
  });

  it('does not supersede an original-profile proof wait before provider outcome proof', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: Array<{ event: string; reason?: string | null }> = [];
    const recover = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'observed_generation',
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
        diagnostics.push(event as { event: string; reason?: string | null });
      },
    });

    await scheduler.enqueueHandlerFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
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
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      pendingTargetProfileId: 'backup',
    });
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_superseded');
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_dead_letter');
  });

  it('keeps stale-profile proof waits pending across churned group generations', async () => {
    // Sibling sessions may bump the shared group generation between replays. A churned
    // generation is still not provider-outcome proof, so the scheduler must keep owning the
    // proof wait until explicit proof, terminal failure, or handler-reported supersession.
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    let generation = 2;
    const recover = vi.fn(async () => ({
      status: 'switch_attempted',
      result: {
        status: 'observed_generation',
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
      classification: usageLimitClassification(),
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

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(recover).toHaveBeenCalledTimes(2);
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'resumed_awaiting_proof',
      pendingTargetProfileId: 'backup',
      pendingTargetGeneration: 3,
    });
  });

  it('retains retry and dead-letter state for repeated stale-profile proof waits without provider proof', async () => {
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: Array<{ event: string }> = [];
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
        diagnostics.push(event as { event: string });
      },
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 1,
      classification: usageLimitClassification(),
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

  it('supersedes (never terminalizes) a wake whose recovery armed a same-session temporary retry (ported HF-5 / A1-MED-1)', async () => {
    // A temporary_retry_armed/unavailable wake outcome means the SAME-SESSION backoff-resume path
    // now owns the failure: the durable record must be removed and the key left re-armable —
    // never settled terminal/cancelled by the unknown-status catch-all.
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    for (const temporaryRetryStatus of ['temporary_retry_armed', 'temporary_retry_unavailable'] as const) {
      const diagnostics: Array<{ event: string }> = [];
      const scheduler = new RuntimeAuthRecoveryScheduler({
        nowMs: () => 1_000,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterMs: () => 0,
        recover: async () => ({ status: temporaryRetryStatus }),
        recordDiagnostic: (event) => {
          diagnostics.push(event as { event: string });
        },
      });

      await scheduler.beginClassifiedFailure({
        sessionId: 'session-1',
        switchesThisTurn: 0,
        classification: usageLimitClassification(),
      });
      await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
        .resolves.toEqual({ status: 'superseded' });

      expect(scheduler.readForSession('session-1')).toEqual([]);
      expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_terminal');
      expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_dead_letter');

      // The key re-arms immediately on a genuine future failure.
      await expect(scheduler.beginClassifiedFailure({
        sessionId: 'session-1',
        switchesThisTurn: 0,
        classification: usageLimitClassification(),
      })).resolves.toMatchObject({ status: 'scheduled', retryable: true });
    }
  });

  it('removes a superseded recovery intent and lets the same key re-arm on a genuine future failure', async () => {
    // Incident 2026-06-12 (cmq8y3nlx): a stale persisted intent for a profile the session no
    // longer ran was replayed every retry. When the handler reports the recovery as superseded,
    // the intent must be REMOVED (not terminalized): a terminal record would block re-arming the
    // same recovery key on a genuine future failure, and a dead-letter would surface a
    // misleading "retry limit" to the user.
    const { RuntimeAuthRecoveryScheduler } = await loadModule();
    const diagnostics: Array<{ event: string }> = [];
    const scheduler = new RuntimeAuthRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterMs: () => 0,
      recover: async () => ({
        status: 'recovery_superseded',
        reason: 'failing_profile_inactive',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        failingProfileId: 'primary',
        activeProfileId: 'backup',
      }),
      recordDiagnostic: (event) => {
        diagnostics.push(event as { event: string });
      },
    });

    await scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'manual' }))
      .resolves.toEqual({ status: 'superseded' });

    expect(scheduler.readForSession('session-1')).toEqual([]);
    expect(diagnostics.map((event) => event.event)).toContain('runtime_auth_recovery_superseded');
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_dead_letter');
    expect(diagnostics.map((event) => event.event)).not.toContain('runtime_auth_recovery_terminal');

    // The key re-arms immediately on a genuine future failure.
    await expect(scheduler.beginClassifiedFailure({
      sessionId: 'session-1',
      switchesThisTurn: 0,
      classification: usageLimitClassification(),
    })).resolves.toMatchObject({ status: 'scheduled', retryable: true });
    expect(scheduler.readForSession('session-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'waiting', attemptCount: 0 }),
    ]));
  });
});
