import { describe, expect, it, vi } from 'vitest';

type ContinuationModule = Readonly<{
  isContinuationRecoveryAwaitingProviderActivityStatus: (status: string) => boolean;
  createSessionContinuationRecoveryController: (deps: {
    nowMs: () => number;
    providerActivityTimeoutMs?: number;
    store: {
      read: (sessionId: string) => Promise<unknown | null> | unknown | null;
      write: (sessionId: string, state: unknown) => Promise<void> | void;
    };
    readCustomResumePrompt?: () => string | null | undefined;
  }) => {
    beginAttempt: (input: {
      sessionId: string;
      attemptId: string;
      failureAtMs: number;
      resumePromptMode: 'standard' | 'off' | 'custom';
      replayMode?: 'continuation_prompt' | 'retry_original_user_message' | 'suppress';
      recoveryIdentity?: {
        serviceId: string;
        selectionKind: 'profile' | 'group';
        groupId?: string;
        profileId?: string;
        failureFingerprint?: string;
        targetGeneration?: number;
      };
      continuationRequired?: boolean;
    }) => Promise<unknown>;
    resolveAttempt: (input: {
      sessionId: string;
      attemptId: string;
      failureAtMs: number;
      resumePromptMode: 'standard' | 'off' | 'custom';
      replayMode?: 'continuation_prompt' | 'retry_original_user_message' | 'suppress';
      recoveryIdentity?: {
        serviceId: string;
        selectionKind: 'profile' | 'group';
        groupId?: string;
        profileId?: string;
        failureFingerprint?: string;
        targetGeneration?: number;
      };
      continuationRequired?: boolean;
      exactProviderContextAvailable: boolean;
      hasUserMessageAfterFailure: () => Promise<boolean> | boolean;
      sendContinuationPrompt: (input: { prompt: string; localId: string }) => Promise<void> | void;
      canRetryOriginalUserMessage?: (input: { failureAtMs: number }) => Promise<'allowed' | 'blocked_provider_activity' | 'unknown'> | 'allowed' | 'blocked_provider_activity' | 'unknown';
      retryOriginalUserMessage?: (input: { localId: string }) => Promise<void> | void;
    }) => Promise<{ status: string }>;
    resolvePendingAttempts: (input: {
      sessionId: string;
      exactProviderContextAvailable: boolean;
      hasUserMessageAfterFailure: (input: { failureAtMs: number }) => Promise<boolean> | boolean;
      sendContinuationPrompt: (input: { prompt: string; localId: string }) => Promise<void> | void;
      canRetryOriginalUserMessage?: (input: { attemptId: string; failureAtMs: number }) => Promise<'allowed' | 'blocked_provider_activity' | 'unknown'> | 'allowed' | 'blocked_provider_activity' | 'unknown';
      retryOriginalUserMessage?: (input: { attemptId: string; localId: string; failureAtMs: number }) => Promise<void> | void;
    }) => Promise<{ resolved: Array<{ attemptId: string; status: string }> }>;
    recordProviderActivity: (input: {
      sessionId: string;
      recoveryIdentity?: {
        serviceId: string;
        selectionKind: 'profile' | 'group';
        groupId?: string;
        profileId?: string;
        failureFingerprint?: string;
        targetGeneration?: number;
      };
    }) => Promise<{ observed: number }>;
    expireProviderActivityWaits: (input: { sessionId: string }) => Promise<{ expired: number }>;
    suppressPendingAttempts: (input: { sessionId: string }) => Promise<{ suppressed: number }>;
  };
}>;

async function loadContinuationModule(): Promise<ContinuationModule> {
  const modulePath = './sessionContinuationRecovery';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  expect(typeof (mod as Partial<ContinuationModule> | null)?.createSessionContinuationRecoveryController).toBe('function');
  expect(typeof (mod as Partial<ContinuationModule> | null)?.isContinuationRecoveryAwaitingProviderActivityStatus).toBe('function');
  return mod as ContinuationModule;
}

function createStore() {
  const stored = new Map<string, unknown>();
  return {
    read: (sessionId: string) => stored.get(sessionId) ?? null,
    write: (sessionId: string, state: unknown) => {
      stored.set(sessionId, state);
    },
    stored,
  };
}

describe('session continuation recovery', () => {
  it('identifies statuses that need provider-activity timeout scheduling', async () => {
    const { isContinuationRecoveryAwaitingProviderActivityStatus } = await loadContinuationModule();

    expect(isContinuationRecoveryAwaitingProviderActivityStatus('awaiting_provider_activity')).toBe(true);
    expect(isContinuationRecoveryAwaitingProviderActivityStatus('already_awaiting_provider_activity')).toBe(true);
    expect(isContinuationRecoveryAwaitingProviderActivityStatus('provider_activity_timeout')).toBe(false);
    expect(isContinuationRecoveryAwaitingProviderActivityStatus('provider_activity_observed')).toBe(false);
  });

  it('sends one continuation per persisted session attempt across controller instances', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sentPrompts: string[] = [];
    const first = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await first.beginAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
    });
    await expect(first.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    const second = createSessionContinuationRecoveryController({ nowMs: () => 3_000, store });
    await expect(second.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'already_awaiting_provider_activity' });

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toBe('The interrupted turn was recovered. Continue from where you left off.');
  });

  it('sends the account-level custom resume prompt when the effective mode is custom', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const sentPrompts: string[] = [];
    const controller = createSessionContinuationRecoveryController({
      nowMs: () => 2_000,
      store: createStore(),
      readCustomResumePrompt: () => '  Pick the task back up exactly where it stopped.  ',
    });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'custom',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    expect(sentPrompts).toEqual(['Pick the task back up exactly where it stopped.']);
  });

  it('falls back to the standard resume prompt when custom mode has no usable text', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const sentPrompts: string[] = [];
    const controller = createSessionContinuationRecoveryController({
      nowMs: () => 2_000,
      store: createStore(),
      readCustomResumePrompt: () => '   ',
    });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'custom',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    expect(sentPrompts).toEqual(['The interrupted turn was recovered. Continue from where you left off.']);
  });

  it('falls back to the standard resume prompt when custom mode has no custom text source', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const sentPrompts: string[] = [];
    const controller = createSessionContinuationRecoveryController({
      nowMs: () => 2_000,
      store: createStore(),
    });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'custom',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    expect(sentPrompts).toEqual(['The interrupted turn was recovered. Continue from where you left off.']);
  });

  it('preserves idempotency through async metadata stores', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const stored = new Map<string, unknown>();
    const store = {
      read: async (sessionId: string) => stored.get(sessionId) ?? null,
      write: async (sessionId: string, state: unknown) => {
        stored.set(sessionId, state);
      },
    };
    const sentPrompts: string[] = [];
    const first = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(first.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    const second = createSessionContinuationRecoveryController({ nowMs: () => 3_000, store });
    await expect(second.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({ status: 'already_awaiting_provider_activity' });

    expect(sentPrompts).toHaveLength(1);
  });

  it('marks awaiting continuation recovered only after provider activity is observed', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    await expect(controller.recordProviderActivity({ sessionId: 'session-1' }))
      .resolves.toEqual({ observed: 1 });
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'provider_activity_observed',
        },
      },
    });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    })).resolves.toEqual({ status: 'already_observed_provider_activity' });
  });

  it('records provider activity only for the matching recovery identity', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });
    const codex3Identity = {
      serviceId: 'openai-codex',
      selectionKind: 'group' as const,
      groupId: 'codex',
      profileId: 'codex3',
      failureFingerprint: 'usage_limit:reset:1234',
    };
    const teamIdentity = {
      serviceId: 'openai-codex',
      selectionKind: 'group' as const,
      groupId: 'codex',
      profileId: 'team',
      failureFingerprint: 'usage_limit:reset:1234',
    };

    await controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'codex3-restart',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      recoveryIdentity: codex3Identity,
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    });
    await controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'team-restart',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      recoveryIdentity: teamIdentity,
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    });

    await expect(controller.recordProviderActivity({
      sessionId: 'session-1',
      recoveryIdentity: codex3Identity,
    })).resolves.toEqual({ observed: 1 });
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'codex3-restart': {
          status: 'provider_activity_observed',
          recoveryIdentity: codex3Identity,
        },
        'team-restart': {
          status: 'awaiting_provider_activity',
          recoveryIdentity: teamIdentity,
        },
      },
    });
  });

  it('matches provider activity by binding identity when the event has no failure fingerprint', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'fingerprinted-attempt',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      recoveryIdentity: {
        serviceId: 'claude-subscription',
        selectionKind: 'group',
        groupId: 'claude',
        profileId: 'leeroy_new',
        failureFingerprint: 'authentication_failed:401',
      },
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    });

    await expect(controller.recordProviderActivity({
      sessionId: 'session-1',
      recoveryIdentity: {
        serviceId: 'claude-subscription',
        selectionKind: 'group',
        groupId: 'claude',
        profileId: 'leeroy_new',
      },
    })).resolves.toEqual({ observed: 1 });
  });

  it('does not clear identity-scoped attempts from a session-only provider activity event', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'identity-attempt',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      recoveryIdentity: {
        serviceId: 'openai-codex',
        selectionKind: 'profile',
        profileId: 'codex3',
      },
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    });

    await expect(controller.recordProviderActivity({ sessionId: 'session-1' }))
      .resolves.toEqual({ observed: 0 });
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'identity-attempt': {
          status: 'awaiting_provider_activity',
        },
      },
    });
  });

  it('does not treat provider activity before the replay boundary as proof', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    store.stored.set('session-1', {
      v: 1,
      attemptsById: {
        'generation-1:restart-1': {
          v: 1,
          attemptId: 'generation-1:restart-1',
          status: 'awaiting_provider_activity',
          failureAtMs: 1_000,
          updatedAtMs: 2_000,
          sentAtMs: 3_000,
          resumePromptMode: 'standard',
          recoveryIdentity: {
            serviceId: 'claude-subscription',
            selectionKind: 'group',
            groupId: 'claude',
            profileId: 'leeroy_new',
            failureFingerprint: 'authentication_failed:401',
          },
        },
      },
    });
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_500, store });

    await expect(controller.recordProviderActivity({
      sessionId: 'session-1',
      recoveryIdentity: {
        serviceId: 'claude-subscription',
        selectionKind: 'group',
        groupId: 'claude',
        profileId: 'leeroy_new',
        failureFingerprint: 'authentication_failed:401',
      },
    })).resolves.toEqual({ observed: 0 });
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'awaiting_provider_activity',
        },
      },
    });
  });

  it('expires awaiting provider activity after the bounded proof window', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    let now = 2_000;
    const controller = createSessionContinuationRecoveryController({
      nowMs: () => now,
      providerActivityTimeoutMs: 5_000,
      store,
    });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    now = 6_999;
    await expect(controller.expireProviderActivityWaits({ sessionId: 'session-1' }))
      .resolves.toEqual({ expired: 0 });

    now = 7_000;
    await expect(controller.expireProviderActivityWaits({ sessionId: 'session-1' }))
      .resolves.toEqual({ expired: 1 });
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'provider_activity_timeout',
          errorCode: 'provider_activity_timeout',
        },
      },
    });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
    })).resolves.toEqual({ status: 'provider_activity_timeout' });
  });

  it('resolves persisted pending attempts once provider context is available', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sentPrompts: string[] = [];
    const first = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await first.beginAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
    });

    const second = createSessionContinuationRecoveryController({ nowMs: () => 3_000, store });
    await expect(second.resolvePendingAttempts({
      sessionId: 'session-1',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt }) => {
        sentPrompts.push(prompt);
      },
    })).resolves.toEqual({
      resolved: [{ attemptId: 'generation-1:restart-1', status: 'awaiting_provider_activity' }],
    });

    expect(sentPrompts).toHaveLength(1);
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'awaiting_provider_activity',
        },
      },
    });
  });

  it('retries a persisted sending attempt with the same deterministic handoff id after restart replay', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    store.stored.set('session-1', {
      v: 1,
      attemptsById: {
        'generation-1:restart-1': {
          v: 1,
          attemptId: 'generation-1:restart-1',
          status: 'sending',
          failureAtMs: 1_000,
          updatedAtMs: 2_000,
          resumePromptMode: 'standard',
        },
      },
    });
    const sentPrompts: Array<{ prompt: string; localId: string }> = [];
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 3_000, store });

    await expect(controller.resolvePendingAttempts({
      sessionId: 'session-1',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: ({ prompt, localId }) => {
        sentPrompts.push({ prompt, localId });
      },
    })).resolves.toEqual({
      resolved: [{ attemptId: 'generation-1:restart-1', status: 'awaiting_provider_activity' }],
    });

    expect(sentPrompts).toEqual([
      {
        prompt: expect.stringContaining('Continue'),
        localId: expect.stringMatching(/^connected-service-continuation:/),
      },
    ]);
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'awaiting_provider_activity',
          sentAtMs: 3_000,
        },
      },
    });
  });

  it('finalizes a persisted sending attempt only when handoff evidence was recorded', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    store.stored.set('session-1', {
      v: 1,
      attemptsById: {
        'generation-1:restart-1': {
          v: 1,
          attemptId: 'generation-1:restart-1',
          status: 'sending',
          failureAtMs: 1_000,
          updatedAtMs: 2_000,
          sentAtMs: 2_500,
          resumePromptMode: 'standard',
        },
      },
    });
    const sendContinuationPrompt = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 3_000, store });

    await expect(controller.resolvePendingAttempts({
      sessionId: 'session-1',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt,
    })).resolves.toEqual({
      resolved: [{ attemptId: 'generation-1:restart-1', status: 'already_awaiting_provider_activity' }],
    });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'awaiting_provider_activity',
          sentAtMs: 2_500,
        },
      },
    });
  });

  it('does not resend when an interleaved resolver sees the first resolver in sending state', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const first = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });
    const second = createSessionContinuationRecoveryController({ nowMs: () => 2_500, store });
    const attemptedLocalIds: string[] = [];
    const deliveredPrompts: string[] = [];
    const deliveredLocalIds = new Set<string>();
    const deliverOnce = ({ prompt, localId }: { prompt: string; localId: string }) => {
      attemptedLocalIds.push(localId);
      if (deliveredLocalIds.has(localId)) return;
      deliveredLocalIds.add(localId);
      deliveredPrompts.push(prompt);
    };

    await first.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: async (handoff) => {
        deliverOnce(handoff);
        await expect(second.resolvePendingAttempts({
          sessionId: 'session-1',
          exactProviderContextAvailable: true,
          hasUserMessageAfterFailure: () => false,
          sendContinuationPrompt: deliverOnce,
        })).resolves.toEqual({
          resolved: [{ attemptId: 'generation-1:restart-1', status: 'awaiting_provider_activity' }],
        });
      },
    });

    expect(attemptedLocalIds).toHaveLength(2);
    expect(new Set(attemptedLocalIds).size).toBe(1);
    expect(deliveredPrompts).toHaveLength(1);
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'awaiting_provider_activity',
          sentAtMs: expect.any(Number),
        },
      },
    });
  });

  it('suppresses continuation when newer user input exists after the failure', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sendContinuationPrompt = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => true,
      sendContinuationPrompt,
    })).resolves.toEqual({ status: 'suppressed_newer_user_input' });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
  });

  it('suppresses continuation when the switch did not interrupt active provider work', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sendContinuationPrompt = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      continuationRequired: false,
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt,
    })).resolves.toEqual({ status: 'suppressed_no_interrupted_turn' });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'suppressed_no_interrupted_turn',
        },
      },
    });
  });

  it('retries the original user message for first-prompt recovery instead of sending a continuation prompt', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sendContinuationPrompt = vi.fn();
    const retryOriginalUserMessage = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'claude-first-prompt',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      replayMode: 'retry_original_user_message',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt,
      retryOriginalUserMessage,
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
    expect(retryOriginalUserMessage).toHaveBeenCalledWith({
      localId: expect.stringMatching(/^connected-service-original-retry:/),
    });
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'claude-first-prompt': {
          replayMode: 'retry_original_user_message',
          status: 'awaiting_provider_activity',
          sentAtMs: 2_000,
        },
      },
    });
  });

  it('does not retry the original user message when retry safety is not proven', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sendContinuationPrompt = vi.fn();
    const retryOriginalUserMessage = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'claude-first-prompt',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      replayMode: 'retry_original_user_message',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      canRetryOriginalUserMessage: () => 'blocked_provider_activity',
      sendContinuationPrompt,
      retryOriginalUserMessage,
    })).resolves.toEqual({ status: 'retry_required' });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
    expect(retryOriginalUserMessage).not.toHaveBeenCalled();
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'claude-first-prompt': {
          replayMode: 'retry_original_user_message',
          status: 'retry_required',
          errorCode: 'original_user_message_retry_provider_activity_detected',
        },
      },
    });
  });

  it('checks retry safety per pending original-message recovery attempt', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const retryOriginalUserMessage = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await controller.beginAttempt({
      sessionId: 'session-1',
      attemptId: 'claude-first-prompt',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      replayMode: 'retry_original_user_message',
    });

    await expect(controller.resolvePendingAttempts({
      sessionId: 'session-1',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      canRetryOriginalUserMessage: ({ attemptId, failureAtMs }) =>
        attemptId === 'claude-first-prompt' && failureAtMs === 1_000 ? 'blocked_provider_activity' : 'allowed',
      sendContinuationPrompt: vi.fn(),
      retryOriginalUserMessage,
    })).resolves.toEqual({
      resolved: [{ attemptId: 'claude-first-prompt', status: 'retry_required' }],
    });

    expect(retryOriginalUserMessage).not.toHaveBeenCalled();
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'claude-first-prompt': {
          replayMode: 'retry_original_user_message',
          status: 'retry_required',
          errorCode: 'original_user_message_retry_provider_activity_detected',
        },
      },
    });
  });

  it('does not replay stored original-message retry attempts when durable activity evidence is unavailable after restart', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const retryOriginalUserMessage = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await controller.beginAttempt({
      sessionId: 'session-1',
      attemptId: 'old-daemon-attempt',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      replayMode: 'retry_original_user_message',
    });

    await expect(controller.resolvePendingAttempts({
      sessionId: 'session-1',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
      canRetryOriginalUserMessage: () => 'unknown',
      retryOriginalUserMessage,
    })).resolves.toEqual({
      resolved: [{ attemptId: 'old-daemon-attempt', status: 'retry_required' }],
    });

    expect(retryOriginalUserMessage).not.toHaveBeenCalled();
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'old-daemon-attempt': {
          replayMode: 'retry_original_user_message',
          status: 'retry_required',
          errorCode: 'original_user_message_retry_evidence_unavailable',
        },
      },
    });
  });

  it('suppresses a pending original-message retry when the interrupted turn is cancelled before replay', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const retryOriginalUserMessage = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await controller.beginAttempt({
      sessionId: 'session-1',
      attemptId: 'claude-first-prompt',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      replayMode: 'retry_original_user_message',
    });
    await expect(controller.suppressPendingAttempts({ sessionId: 'session-1' }))
      .resolves.toEqual({ suppressed: 1 });

    await expect(controller.resolvePendingAttempts({
      sessionId: 'session-1',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: vi.fn(),
      retryOriginalUserMessage,
    })).resolves.toEqual({
      resolved: [],
    });

    expect(retryOriginalUserMessage).not.toHaveBeenCalled();
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'claude-first-prompt': {
          replayMode: 'retry_original_user_message',
          status: 'suppressed_newer_user_input',
        },
      },
    });
  });

  it('retries the original user message without requiring exact provider resume context', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sendContinuationPrompt = vi.fn();
    const retryOriginalUserMessage = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'claude-first-prompt',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      replayMode: 'retry_original_user_message',
      exactProviderContextAvailable: false,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt,
      retryOriginalUserMessage,
    })).resolves.toEqual({ status: 'awaiting_provider_activity' });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
    expect(retryOriginalUserMessage).toHaveBeenCalledWith({
      localId: expect.stringMatching(/^connected-service-original-retry:/),
    });
    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'claude-first-prompt': {
          replayMode: 'retry_original_user_message',
          status: 'awaiting_provider_activity',
        },
      },
    });
  });

  it('marks retry required without sending when provider context is unavailable or prompts are off', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const sendContinuationPrompt = vi.fn();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: false,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt,
    })).resolves.toEqual({ status: 'retry_required' });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-2',
      failureAtMs: 1_500,
      resumePromptMode: 'off',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt,
    })).resolves.toEqual({ status: 'retry_required' });

    expect(sendContinuationPrompt).not.toHaveBeenCalled();
  });

  it('marks retry required when sending the continuation prompt fails', async () => {
    const { createSessionContinuationRecoveryController } = await loadContinuationModule();
    const store = createStore();
    const controller = createSessionContinuationRecoveryController({ nowMs: () => 2_000, store });

    await expect(controller.resolveAttempt({
      sessionId: 'session-1',
      attemptId: 'generation-1:restart-1',
      failureAtMs: 1_000,
      resumePromptMode: 'standard',
      exactProviderContextAvailable: true,
      hasUserMessageAfterFailure: () => false,
      sendContinuationPrompt: async () => {
        throw new Error('provider transport closed');
      },
    })).resolves.toEqual({ status: 'retry_required' });

    expect(store.stored.get('session-1')).toMatchObject({
      attemptsById: {
        'generation-1:restart-1': {
          status: 'retry_required',
          errorCode: 'continuation_prompt_failed',
        },
      },
    });
  });
});
