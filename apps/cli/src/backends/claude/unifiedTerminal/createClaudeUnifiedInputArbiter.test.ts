import { describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';

describe('createClaudeUnifiedInputArbiter', () => {
  it('fails closed when prompt-only acceptance matches multiple terminal-custody rows', async () => {
    const acceptedLocalIds: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      evaluateInFlightSteer: vi.fn(async () => ({ steer: true as const })),
      injectPrompt: vi.fn(async (batch) => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: batch.message.length,
        inFlightSteer: true,
      })),
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push(...(batch.userMessageLocalIds ?? []));
      },
    });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: 10_000 });

    const first = {
      message: 'identical accepted steer',
      origin: { kind: 'ui_pending' as const },
      pendingProviderAction: 'steer' as const,
      userMessageLocalIds: ['first-local'],
    };
    const second = {
      ...first,
      userMessageLocalIds: ['second-local'],
    };
    await arbiter.enqueueUiMessage(first);
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(first);
    await arbiter.enqueueUiMessage(second);
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(second);

    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.message === 'identical accepted steer',
    )).resolves.toBe(false);
    expect(acceptedLocalIds).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({ terminalCustodyCount: 2 });

    await arbiter.dispose();
  });

  it('closes the pump snapshot-to-wait race with the arbiter state version', async () => {
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async (batch: Readonly<{ message: string }>) => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: batch.message.length,
      })),
    });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'exact pending prompt',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['pending-local'],
    });
    await arbiter.drainWhenSafe();
    const pausedSnapshot = arbiter.snapshot();

    await arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('pending-local') === true,
    );

    await expect(arbiter.waitForPendingQueuePumpStateChange({
      afterVersion: pausedSnapshot.pendingQueuePumpStateVersion,
      abortSignal: new AbortController().signal,
    })).resolves.toBe(true);
  });

  it('keeps newer running lifecycle truth when provider acceptance settles the submitted batch', async () => {
    let nowMs = 10_000;
    const injectPrompt = vi.fn(async (batch: Readonly<{ message: string }>, options?: Readonly<{ inFlightSteer?: boolean }>) => ({
      status: 'injected' as const,
      at: nowMs,
      bytesWritten: batch.message.length,
      ...(options?.inFlightSteer ? { inFlightSteer: true } : {}),
    }));
    const evaluateInFlightSteer = vi.fn(async () => ({ steer: true as const }));
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => nowMs,
      quietPeriodMs: 0,
      injectPrompt,
      evaluateInFlightSteer,
      onInjectionFailure,
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: nowMs });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: nowMs });
    await arbiter.enqueueUiMessage({
      message: 'start the provider turn',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['start-local'],
    });
    await arbiter.drainWhenSafe();

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: ++nowMs });
    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('start-local') === true,
    )).resolves.toBe(true);

    expect(arbiter.snapshot().turnState).toBe('running');

    await arbiter.enqueueUiMessage({
      message: 'steer the active provider turn',
      origin: { kind: 'ui_pending' },
      pendingProviderAction: 'steer',
      userMessageLocalIds: ['steer-local'],
    });
    await arbiter.drainWhenSafe();

    expect(evaluateInFlightSteer).toHaveBeenCalledTimes(1);
    expect(injectPrompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ pendingProviderAction: 'steer' }),
      { inFlightSteer: true },
    );
    expect(onInjectionFailure).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous after-enter attempt available for later exact provider acceptance', async () => {
    const acceptedLocalIds: string[] = [];
    const onInjectionFailure = vi.fn(async () => ({ action: 'claimed_pending_delivery' as const }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async () => ({
        status: 'failed' as const,
        reason: 'verification_failed' as const,
        phase: 'after_enter_unknown' as const,
        duplicateRisk: 'possible' as const,
        recoverable: true,
      })),
      onInjectionFailure,
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push(...(batch.userMessageLocalIds ?? []));
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'prompt accepted just after terminal verification became ambiguous',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['late-exact-local'],
    });
    await arbiter.drainWhenSafe();

    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 1,
      pendingInjectionCount: 0,
    });

    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('late-exact-local') === true,
    )).resolves.toBe(true);
    expect(acceptedLocalIds).toEqual(['late-exact-local']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 0,
    });

    await arbiter.dispose();
  });

  it('publishes acceptance correlation when a write may have reached Claude before Enter was verified', async () => {
    const onProviderAcceptancePending = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async () => ({
        status: 'failed' as const,
        reason: 'timeout' as const,
        phase: 'after_write_before_enter' as const,
        duplicateRisk: 'possible' as const,
        recoverable: true,
      })),
      onProviderAcceptancePending,
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'prompt accepted after terminal verification timed out',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['after-write-local'],
    });
    await arbiter.drainWhenSafe();

    expect(onProviderAcceptancePending).toHaveBeenCalledOnce();
    expect(onProviderAcceptancePending).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageLocalIds: ['after-write-local'] }),
      expect.objectContaining({ acceptedAs: 'new_turn' }),
    );
    expect(arbiter.snapshot()).toMatchObject({
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    await arbiter.dispose();
  });

  it('keeps a submitted prompt available for late acceptance after terminal observation is lost', async () => {
    const acceptedLocalIds: string[] = [];
    const onInjectionFailure = vi.fn(async () => ({ action: 'claimed_pending_delivery' as const }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async () => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: 25,
      })),
      onInjectionFailure,
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push(...(batch.userMessageLocalIds ?? []));
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'submitted before terminal observation was lost',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['late-after-terminal-loss'],
    });
    await arbiter.drainWhenSafe();

    await expect(arbiter.observePendingProviderAcceptanceTerminalFailure()).resolves.toBe(true);
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 1,
      pendingInjectionCount: 0,
    });

    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('late-after-terminal-loss') === true,
    )).resolves.toBe(true);
    expect(acceptedLocalIds).toEqual(['late-after-terminal-loss']);
    expect(arbiter.snapshot().terminalCustodyCount).toBe(0);

    await arbiter.dispose();
  });

  it('keeps an ordinary submitted prompt awaiting exact acceptance across compaction completion', async () => {
    const acceptedLocalIds: string[] = [];
    const injectPrompt = vi.fn(async (batch: Readonly<{ message: string }>) => ({
      status: 'injected' as const,
      at: 10_000,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt,
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push(...(batch.userMessageLocalIds ?? []));
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: 'ordinary prompt queued while Claude compacts',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['pending-through-compaction'],
    });
    await arbiter.drainWhenSafe();

    arbiter.observeLifecycle({ type: 'compaction', phase: 'completed', observedAtMs: 10_001 });
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_001 });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('pending-through-compaction') === true,
    )).resolves.toBe(true);
    expect(acceptedLocalIds).toEqual(['pending-through-compaction']);

    await arbiter.dispose();
  });

  it('claims interrupt-and-run only for the exact native queued custody head while its turn is live', async () => {
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async (batch: Readonly<{ message: string }>) => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: batch.message.length,
        inFlightSteer: true,
      })),
      evaluateInFlightSteer: vi.fn(async () => ({ steer: true as const })),
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    const head = {
      message: 'queued head',
      origin: { kind: 'ui_pending' as const },
      pendingProviderAction: 'steer' as const,
      userMessageLocalIds: ['head-local'],
    };
    await arbiter.enqueueUiMessage(head);
    await arbiter.drainWhenSafe();
    await expect(arbiter.observePromptCustodyByTerminal(head)).resolves.toBe(true);

    expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBe('head-local');
    expect(arbiter.claimPendingInputInterruptAndRun('wrong-local')).toBe(false);
    expect(arbiter.claimPendingInputInterruptAndRun('head-local')).toBe(true);
    expect(arbiter.claimPendingInputInterruptAndRun('head-local')).toBe(false);

    await expect(arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('head-local') === true,
    )).resolves.toBe(true);
    expect(arbiter.snapshot().terminalCustodyCount).toBe(0);
  });

  it('does not expose interrupt-and-run for non-head, non-singleton, accepted, or ended-turn custody', async () => {
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt: vi.fn(async (batch: Readonly<{ message: string }>) => ({
        status: 'injected' as const,
        at: 10_000,
        bytesWritten: batch.message.length,
        inFlightSteer: true,
      })),
      evaluateInFlightSteer: vi.fn(async () => ({ steer: true as const })),
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    const head = {
      message: 'ambiguous ids',
      origin: { kind: 'ui_pending' as const },
      pendingProviderAction: 'steer' as const,
      userMessageLocalIds: ['head-a', 'head-b'],
    };
    await arbiter.enqueueUiMessage(head);
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(head);

    expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBeNull();
    expect(arbiter.claimPendingInputInterruptAndRun('head-a')).toBe(false);

    await arbiter.confirmPromptAcceptedByProviderIf((batch) => batch === head);
    expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBeNull();

    const ended = {
      message: 'turn ends after custody',
      origin: { kind: 'ui_pending' as const },
      pendingProviderAction: 'steer' as const,
      userMessageLocalIds: ['ended-local'],
    };
    await arbiter.enqueueUiMessage(ended);
    await arbiter.drainWhenSafe();
    await arbiter.observePromptCustodyByTerminal(ended);
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_001 });

    expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBeNull();
    expect(arbiter.claimPendingInputInterruptAndRun('ended-local')).toBe(false);
  });

  it('accepts the submitted compact command exactly once when compaction completes', async () => {
    const acceptedLocalIds: string[] = [];
    const injectPrompt = vi.fn(async (batch: Readonly<{ message: string }>) => ({
      status: 'injected' as const,
      at: 10_000,
      bytesWritten: batch.message.length,
    }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt,
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push(...(batch.userMessageLocalIds ?? []));
      },
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle', observedAtMs: 10_000 });
    arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_000 });
    await arbiter.enqueueUiMessage({
      message: '/compact',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['compact-local'],
    });
    await arbiter.drainWhenSafe();

    arbiter.observeLifecycle({ type: 'compaction', phase: 'completed', observedAtMs: 10_001 });
    await arbiter.drainWhenSafe();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(acceptedLocalIds).toEqual(['compact-local']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'submitted',
    });

    await arbiter.dispose();
  });

  it('rejects an exact steer before effect after genuine turn-end lifecycle evidence', async () => {
    const injectPrompt = vi.fn(async (batch: Readonly<{ message: string }>) => ({
      status: 'injected' as const,
      at: 10_000,
      bytesWritten: batch.message.length,
    }));
    const evaluateInFlightSteer = vi.fn(async () => ({ steer: true as const }));
    const onInjectionFailure = vi.fn(async () => ({ action: 'claimed_pending_delivery' as const }));
    const arbiter = createClaudeUnifiedInputArbiter({
      nowMs: () => 10_000,
      quietPeriodMs: 0,
      injectPrompt,
      evaluateInFlightSteer,
      onInjectionFailure,
    });

    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });
    arbiter.observeLifecycle({ type: 'output' });
    await arbiter.enqueueUiMessage({
      message: 'start the provider turn',
      origin: { kind: 'ui_pending' },
      userMessageLocalIds: ['start-local'],
    });
    await arbiter.drainWhenSafe();
    arbiter.observeLifecycle({ type: 'turn_state', state: 'running' });
    await arbiter.confirmPromptAcceptedByProviderIf(
      (batch) => batch.userMessageLocalIds?.includes('start-local') === true,
    );
    arbiter.observeLifecycle({ type: 'turn_state', state: 'idle' });

    await arbiter.enqueueUiMessage({
      message: 'cannot steer a completed turn',
      origin: { kind: 'ui_pending' },
      pendingProviderAction: 'steer',
      userMessageLocalIds: ['steer-after-stop'],
    });
    await arbiter.drainWhenSafe();

    expect(evaluateInFlightSteer).not.toHaveBeenCalled();
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      batch: expect.objectContaining({ pendingProviderAction: 'steer' }),
      failureState: 'failed_terminal',
      result: expect.objectContaining({
        reason: 'no_target',
        phase: 'before_write',
        duplicateRisk: 'none',
      }),
    }));
  });
});
