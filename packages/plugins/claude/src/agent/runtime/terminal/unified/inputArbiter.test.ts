import type {
  TerminalInputInjectionResult,
  TerminalInputReadinessV1,
  TerminalPromptInput,
} from '@happier-dev/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedInputArbiter } from './inputArbiter.js';

function promptInput(
  nonce: string,
  origin: Partial<TerminalPromptInput['origin']> = {},
): TerminalPromptInput {
  return {
    text: `prompt ${nonce}`,
    multiline: false,
    origin: { kind: 'ui_pending', nonce, ...origin },
    scheduling: {},
  };
}

function readiness(
  overrides: Partial<TerminalInputReadinessV1> = {},
): TerminalInputReadinessV1 {
  return {
    status: 'writable',
    observedAt: 1_000,
    hostKind: 'tmux',
    hostSessionName: 'claude-test',
    paneId: 'pane-1',
    ...overrides,
  };
}

function injected(overrides: Partial<Extract<TerminalInputInjectionResult, { status: 'injected' }>> = {}): TerminalInputInjectionResult {
  return {
    status: 'injected',
    injectedAt: 1_100,
    bytesWritten: 12,
    hostKind: 'tmux',
    hostSessionName: 'claude-test',
    paneId: 'pane-1',
    ...overrides,
  };
}

describe('createClaudeUnifiedInputArbiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for provider confirmation after terminal-host injection before submitting the prompt', async () => {
    const onPromptInjected = vi.fn();
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => injected()),
      onPromptInjected,
      onPromptAccepted,
    });

    arbiter.enqueue(promptInput('one'));
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    expect(onPromptInjected).toHaveBeenCalledTimes(1);
    expect(onPromptAccepted).not.toHaveBeenCalled();

    await expect(arbiter.confirmProviderAcceptance()).resolves.toBe(true);

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'submitted',
    });
    expect(onPromptAccepted).toHaveBeenCalledTimes(1);
  });

  it('keeps an ordinary submitted prompt awaiting exact acceptance across compaction completion', async () => {
    const input = promptInput('pending-through-compaction', {
      localIds: ['pending-through-compaction'],
    });
    const injectPrompt = vi.fn(async () => injected());
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onPromptAccepted,
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    arbiter.observeCompaction({ phase: 'completed' });
    await arbiter.drain();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    await expect(arbiter.confirmProviderAcceptance({
      promptText: input.text,
      exactPromptText: true,
    })).resolves.toBe(true);
    expect(onPromptAccepted).toHaveBeenCalledWith(input, expect.any(Object));

    arbiter.dispose();
  });

  it('claims interrupt-and-run once for the exact native queued custody head while the turn is live', async () => {
    const input = promptInput('interrupt-custody', {
      localIds: ['queued-local'],
    });
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => injected()),
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness({ activeTurnId: 'turn-live' }));
    await arbiter.drain();
    await expect(arbiter.observeTerminalPromptCustody(input)).resolves.toBe(true);

    expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBe('queued-local');
    expect(arbiter.claimPendingInputInterruptAndRun('wrong-local')).toBe(false);
    expect(arbiter.claimPendingInputInterruptAndRun('queued-local')).toBe(true);
    expect(arbiter.claimPendingInputInterruptAndRun('queued-local')).toBe(false);
    expect(arbiter.snapshot().terminalCustodyCount).toBe(1);

    await expect(arbiter.confirmProviderAcceptance({
      promptText: input.text,
      exactPromptText: true,
    })).resolves.toBe(true);
    expect(arbiter.snapshot().terminalCustodyCount).toBe(0);
  });

  it('retains an ambiguous after-enter attempt until later exact provider confirmation', async () => {
    const input = promptInput('late-exact-after-enter', {
      localIds: ['late-exact-local'],
    });
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => ({
        status: 'failed',
        reason: 'ambiguous_provider_acceptance',
        phase: 'after_enter_unknown',
        recoverable: true,
        duplicateRisk: 'possible',
        observedAt: 1_100,
      })),
      onPromptAccepted,
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 0,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    await expect(arbiter.confirmProviderAcceptance({
      promptText: input.text,
      exactPromptText: true,
    })).resolves.toBe(true);
    expect(onPromptAccepted).toHaveBeenCalledWith(input, expect.any(Object));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'submitted',
    });

    arbiter.dispose();
  });

  it('wakes a prompt deferred by a user draft after the terminal composer is cleared', async () => {
    vi.useFakeTimers();
    const injectPrompt = vi.fn(async () => injected());
    const arbiter = createClaudeUnifiedInputArbiter({ injectPrompt });

    arbiter.enqueue(promptInput('draft-blocked'));
    arbiter.observeReadiness(readiness({
      status: 'defer_user_typing',
      reason: 'user_draft',
    }));
    await arbiter.drain();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'waiting_for_readiness',
      lastDeferredReason: 'defer_user_typing',
    });
    expect(injectPrompt).not.toHaveBeenCalled();

    arbiter.notifyTerminalComposerCleared(readiness());
    await vi.advanceTimersByTimeAsync(0);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
      lastDeferredReason: null,
    });
  });

  it.each([
    'terminal_composer_draft',
    'runtime_config_blocked',
    'provider_unavailable_before_acceptance',
  ] as const)('retains a canonical head through reversible %s blocking and clears it once', async (reason) => {
    vi.useFakeTimers();
    const input = promptInput(reason, {
      localIds: [`pending-${reason}`],
      userMessageSeq: null,
    });
    const terminallyRejected = vi.fn();
    const injectPrompt = vi.fn(async () => injected());
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onPromptTerminallyRejectedBeforeProvider: terminallyRejected,
      onPromptAccepted,
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness({
      status: 'defer_user_typing',
      reason: 'user_draft',
    }));
    await arbiter.drain();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'waiting_for_readiness',
      headDeliveryBlocker: { reason: 'terminal_composer_draft' },
    });

    expect(arbiter.blockHeadBeforeProvider({ deliveryBlockedReason: reason })).toBe(true);

    expect(terminallyRejected).toHaveBeenCalledWith(input, expect.objectContaining({
      status: 'failed',
    }), { deliveryBlockedReason: reason });
    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'waiting_for_readiness',
      headDeliveryBlocker: { reason },
    });

    arbiter.observeReadiness(readiness());
    expect(arbiter.clearHeadBeforeProviderBlock(reason)).toBe(true);
    expect(arbiter.clearHeadBeforeProviderBlock(reason)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    await expect(arbiter.confirmProviderAcceptance()).resolves.toBe(true);
    expect(onPromptAccepted).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({ queuedCount: 0, headInputState: 'submitted' });
  });

  it('does not replay a durably blocked retained head when the runtime is disposed', async () => {
    const input = promptInput('blocked-runtime-replacement', {
      localIds: ['pending-blocked-runtime-replacement'],
      userMessageSeq: null,
    });
    const onUndeliverableInputs = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => injected()),
      onUndeliverableInputs,
    });

    arbiter.enqueue(input);
    expect(arbiter.blockHeadBeforeProvider({
      deliveryBlockedReason: 'runtime_config_blocked',
    })).toBe(true);

    arbiter.dispose();

    expect(onUndeliverableInputs).not.toHaveBeenCalled();
  });

  it('accepts provider confirmation when observed prompt text matches the queued prompt', async () => {
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => injected()),
      onPromptAccepted,
    });

    arbiter.enqueue(promptInput('same'));
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    await expect(arbiter.confirmProviderAcceptance({
      promptText: 'prompt same',
    })).resolves.toBe(true);

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'submitted',
    });
    expect(onPromptAccepted).toHaveBeenCalledTimes(1);
  });

  it('requires byte-exact prompt text for native queued-command acceptance evidence', async () => {
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => injected()),
      onPromptAccepted,
    });

    arbiter.enqueue(promptInput('exact'));
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    await expect(arbiter.confirmProviderAcceptance({
      promptText: ' prompt exact ',
      exactPromptText: true,
    })).resolves.toBe(false);
    expect(onPromptAccepted).not.toHaveBeenCalled();

    await expect(arbiter.confirmProviderAcceptance({
      promptText: 'prompt exact',
      exactPromptText: true,
    })).resolves.toBe(true);
    expect(onPromptAccepted).toHaveBeenCalledTimes(1);
  });

  it('does not accept a queued prompt when provider confirmation text belongs to terminal-origin input', async () => {
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => injected()),
      onPromptAccepted,
      providerAcceptanceTimeoutMs: 50,
    });

    arbiter.enqueue(promptInput('queued'));
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    await expect(arbiter.confirmProviderAcceptance({
      promptText: 'typed directly in terminal',
    })).resolves.toBe(false);

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    expect(onPromptAccepted).not.toHaveBeenCalled();
  });

  it('keeps legacy provider confirmation without prompt text accepted', async () => {
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => injected()),
      onPromptAccepted,
    });

    arbiter.enqueue(promptInput('legacy'));
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    await expect(arbiter.confirmProviderAcceptance()).resolves.toBe(true);

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'submitted',
    });
    expect(onPromptAccepted).toHaveBeenCalledTimes(1);
  });

  it('terminalizes deterministic invalid prompt text without blocking later prompts', async () => {
    const invalidInput = promptInput('invalid');
    const validInput = promptInput('valid');
    const terminallyRejected = vi.fn();
    const injectPrompt = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'failed',
        reason: 'invalid_prompt_text',
        phase: 'before_write',
        recoverable: false,
        duplicateRisk: 'none',
        observedAt: 1_200,
      } satisfies Extract<TerminalInputInjectionResult, { status: 'failed' }>)
      .mockResolvedValueOnce(injected());
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onPromptTerminallyRejectedBeforeProvider: terminallyRejected,
    });

    arbiter.enqueue(invalidInput);
    arbiter.enqueue(validInput);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(terminallyRejected).toHaveBeenCalledWith(invalidInput, expect.objectContaining({
      reason: 'invalid_prompt_text',
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
      lastFailureReason: null,
    });
    expect(injectPrompt).toHaveBeenCalledTimes(2);

    arbiter.dispose();
  });;;;;;;;;;

  it('keeps terminal queued-banner custody available for late exact acceptance after an ambiguous failed turn', async () => {
    vi.useFakeTimers();
    const injectPrompt = vi.fn(async () => injected());
    const onInjectionFailure = vi.fn();
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onInjectionFailure,
      onPromptAccepted,
      providerAcceptanceTimeoutMs: 10_000,
    });

    const input = promptInput('terminal-custody-failed');
    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();
    await expect(arbiter.observeTerminalPromptCustody(input)).resolves.toBe(true);

    expect(arbiter.observePendingProviderAcceptanceTerminalFailure()).toBe(true);

    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      input,
      failureState: 'failed_ambiguous',
      result: expect.objectContaining({
        reason: 'ambiguous_provider_acceptance',
        duplicateRisk: 'likely',
      }),
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
      lastFailureReason: 'ambiguous_provider_acceptance',
    });

    await expect(arbiter.confirmProviderAcceptance({
      promptText: input.text,
      exactPromptText: true,
    })).resolves.toBe(true);
    expect(onPromptAccepted).toHaveBeenCalledWith(input, expect.any(Object));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'submitted',
    });
  });

  it('terminalizes terminal custody when the failed turn carries exact pre-acceptance rejection evidence', async () => {
    const input = promptInput('terminal-custody-provider-rejected');
    const onInjectionFailure = vi.fn();
    const onPromptTerminallyRejectedBeforeProvider = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => injected()),
      onInjectionFailure,
      onPromptTerminallyRejectedBeforeProvider,
      resolvePromptTerminalRejection: () => ({
        deliveryBlockedReason: 'provider_rejected_before_acceptance',
      }),
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();
    await expect(arbiter.observeTerminalPromptCustody(input)).resolves.toBe(true);

    expect(arbiter.observePendingProviderAcceptanceTerminalFailure()).toBe(true);
    expect(onPromptTerminallyRejectedBeforeProvider).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ reason: 'ambiguous_provider_acceptance' }),
      { deliveryBlockedReason: 'provider_rejected_before_acceptance' },
    );
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      input,
      failureState: 'failed_terminal',
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'failed_terminal',
    });
  });

  it('continues injecting later prompts while earlier prompts wait in Claude terminal custody', async () => {
    vi.useFakeTimers();
    const first = promptInput('terminal-custody-first');
    const second = promptInput('terminal-custody-second');
    const injectedTexts: string[] = [];
    const acceptedTexts: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async (input) => {
        injectedTexts.push(input.text);
        return injected();
      }),
      onPromptAccepted: (input) => {
        acceptedTexts.push(input.text);
      },
      providerAcceptanceTimeoutMs: 50,
    });

    arbiter.enqueue(first);
    arbiter.observeReadiness(readiness({ activeTurnId: 'turn-1' }));
    await arbiter.drain();

    expect(injectedTexts).toEqual(['prompt terminal-custody-first']);
    await expect(arbiter.observeTerminalPromptCustody(first)).resolves.toBe(true);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 0,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    arbiter.enqueue(second);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      pendingInjectionCount: 1,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    await arbiter.drain();

    expect(injectedTexts).toEqual([
      'prompt terminal-custody-first',
      'prompt terminal-custody-second',
    ]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      pendingInjectionCount: 0,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 2,
      headInputState: 'awaiting_provider_acceptance',
    });
    await expect(arbiter.observeTerminalPromptCustody(second)).resolves.toBe(true);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      pendingInjectionCount: 0,
      terminalCustodyCount: 2,
      providerAcceptancePendingCount: 2,
      headInputState: 'awaiting_provider_acceptance',
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(acceptedTexts).toEqual([]);

    await expect(arbiter.confirmProviderAcceptance({
      promptText: 'prompt terminal-custody-first',
    })).resolves.toBe(true);
    await expect(arbiter.confirmProviderAcceptance({
      promptText: 'prompt terminal-custody-second',
    })).resolves.toBe(true);

    expect(acceptedTexts).toEqual([
      'prompt terminal-custody-first',
      'prompt terminal-custody-second',
    ]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      pendingInjectionCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'submitted',
    });

    arbiter.dispose();
  });

  it('fails closed when prompt-only acceptance matches multiple terminal-custody inputs', async () => {
    const first = promptInput('identical-terminal-custody', {
      localIds: ['first-local'],
    });
    const second: TerminalPromptInput = {
      ...first,
      origin: {
        ...first.origin,
        nonce: 'identical-terminal-custody-second',
        localIds: ['second-local'],
      },
    };
    const acceptedLocalIds: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => injected()),
      onPromptAccepted: (input) => {
        acceptedLocalIds.push(...(input.origin.localIds ?? []));
      },
    });

    arbiter.observeReadiness(readiness({ activeTurnId: 'turn-1' }));
    arbiter.enqueue(first);
    await arbiter.drain();
    await expect(arbiter.observeTerminalPromptCustody(first)).resolves.toBe(true);
    arbiter.enqueue(second);
    await arbiter.drain();
    await expect(arbiter.observeTerminalPromptCustody(second)).resolves.toBe(true);

    await expect(arbiter.confirmProviderAcceptance({
      promptText: first.text,
      exactPromptText: true,
    })).resolves.toBe(false);
    expect(acceptedLocalIds).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({ terminalCustodyCount: 2 });

    arbiter.dispose();
  });

  it('keeps a later injected prompt awaiting acceptance when an earlier terminal-custody prompt is confirmed first', async () => {
    const first = promptInput('terminal-custody-first');
    const second = promptInput('pending-provider-acceptance-second');
    const injectedTexts: string[] = [];
    const acceptedTexts: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async (input) => {
        injectedTexts.push(input.text);
        return injected();
      }),
      onPromptAccepted: (input) => {
        acceptedTexts.push(input.text);
      },
    });

    arbiter.enqueue(first);
    arbiter.observeReadiness(readiness({ activeTurnId: 'turn-1' }));
    await arbiter.drain();
    await expect(arbiter.observeTerminalPromptCustody(first)).resolves.toBe(true);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 0,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    arbiter.enqueue(second);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      pendingInjectionCount: 1,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
    await arbiter.drain();

    expect(injectedTexts).toEqual([
      'prompt terminal-custody-first',
      'prompt pending-provider-acceptance-second',
    ]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 2,
      pendingInjectionCount: 0,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 2,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmProviderAcceptance({
      promptText: 'prompt terminal-custody-first',
    })).resolves.toBe(true);

    expect(acceptedTexts).toEqual(['prompt terminal-custody-first']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmProviderAcceptance({
      promptText: 'prompt pending-provider-acceptance-second',
    })).resolves.toBe(true);
    expect(acceptedTexts).toEqual([
      'prompt terminal-custody-first',
      'prompt pending-provider-acceptance-second',
    ]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      pendingInjectionCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'submitted',
    });
  });;;;

  it('accepts provider confirmation that arrives while injection is still resolving', async () => {
    vi.useFakeTimers();
    const accepted: string[] = [];
    const providerConfirmations: boolean[] = [];
    const onInjectionFailure = vi.fn();
    let arbiter!: ReturnType<typeof createClaudeUnifiedInputArbiter>;
    const injectPrompt = vi.fn(async () => {
      providerConfirmations.push(await arbiter.confirmProviderAcceptance());
      return injected();
    });
    arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onPromptAccepted: (input) => {
        accepted.push(input.text);
      },
      onInjectionFailure,
      providerAcceptanceTimeoutMs: 50,
    });

    arbiter.enqueue(promptInput('accepted-during-injection', {
      localIds: ['pending-local-during-injection'],
    }));
    arbiter.observeReadiness(readiness());
    await arbiter.drain();
    await vi.advanceTimersByTimeAsync(50);

    expect(providerConfirmations).toEqual([true]);
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(onInjectionFailure).not.toHaveBeenCalled();
    expect(accepted).toEqual(['prompt accepted-during-injection']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'submitted',
      lastFailureReason: null,
    });
  });

  it('keeps the prompt queued while terminal readiness is deferred and pumps when writable', async () => {
    const injectPrompt = vi.fn(async () => injected());
    const arbiter = createClaudeUnifiedInputArbiter({ injectPrompt });

    arbiter.enqueue(promptInput('finalizing'));
    arbiter.observeReadiness(readiness({ status: 'defer_finalizing' }));
    await arbiter.drain();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'waiting_for_readiness',
      lastDeferredReason: 'defer_finalizing',
    });
    expect(injectPrompt).not.toHaveBeenCalled();

    arbiter.observeReadiness(readiness());

    await vi.waitFor(() => {
      expect(injectPrompt).toHaveBeenCalledTimes(1);
    });
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
      lastDeferredReason: null,
    });
  });

});
