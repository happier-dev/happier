import type {
  TerminalInputInjectionResult,
  TerminalInputReadinessV1,
  TerminalPromptInput,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import { resolveTerminalPromptProviderAcceptanceTimeoutMs } from '@happier-dev/plugin-sdk/experimental/runtime/session';
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

  it('terminalizes a deferred canonical head with a typed durable blocker in the snapshot', async () => {
    const input = promptInput('draft-blocked', {
      localIds: ['pending-draft-local'],
      userMessageSeq: null,
    });
    const terminallyRejected = vi.fn();
    const injectPrompt = vi.fn(async () => injected());
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onPromptTerminallyRejectedBeforeProvider: terminallyRejected,
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

    expect(arbiter.rejectHeadBeforeProvider({ deliveryBlockedReason: 'terminal_composer_draft' })).toBe(true);

    expect(terminallyRejected).toHaveBeenCalledWith(input, expect.objectContaining({
      status: 'failed',
    }), { deliveryBlockedReason: 'terminal_composer_draft' });
    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'failed_terminal',
      headDeliveryBlocker: null,
    });
  });

  it('terminalizes a provider-unavailable deferred canonical head with the provider-unavailable blocker', async () => {
    const input = promptInput('provider-unavailable', {
      localIds: ['pending-provider-unavailable'],
      userMessageSeq: null,
    });
    const terminallyRejected = vi.fn();
    const injectPrompt = vi.fn(async () => injected());
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onPromptTerminallyRejectedBeforeProvider: terminallyRejected,
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness({
      status: 'defer_provider_starting',
      reason: 'provider_unavailable',
    }));
    await arbiter.drain();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'waiting_for_readiness',
      headDeliveryBlocker: { reason: 'provider_unavailable_before_acceptance' },
    });

    expect(arbiter.rejectHeadBeforeProvider({
      deliveryBlockedReason: 'provider_unavailable_before_acceptance',
    })).toBe(true);

    expect(terminallyRejected).toHaveBeenCalledWith(input, expect.objectContaining({
      status: 'failed',
    }), { deliveryBlockedReason: 'provider_unavailable_before_acceptance' });
    expect(injectPrompt).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'failed_terminal',
      headDeliveryBlocker: null,
    });
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

  it('terminalizes deterministic invalid prompt text without handback or blocking later prompts', async () => {
    const invalidInput = promptInput('invalid');
    const validInput = promptInput('valid');
    const terminallyRejected = vi.fn();
    const undeliverable: TerminalPromptInput[][] = [];
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
      onUndeliverableInputs: (inputs) => undeliverable.push([...inputs]),
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

    expect(undeliverable).toEqual([[validInput]]);
  });

  it('retries one ambiguous provider-acceptance timeout and then terminalizes when still unaccepted', async () => {
    vi.useFakeTimers();
    const injectPrompt = vi.fn(async () => injected());
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onInjectionFailure,
      providerAcceptanceTimeoutMs: 50,
    });

    arbiter.enqueue(promptInput('ambiguous'));
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
      lastFailureReason: null,
    });
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_ambiguous',
    }));
    expect(injectPrompt).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'failed_terminal',
      lastFailureReason: 'ambiguous_provider_acceptance',
    });
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureState: 'failed_terminal',
    }));
    expect(injectPrompt).toHaveBeenCalledTimes(2);
  });

  it('blocks server-owned pending input after ambiguous provider-acceptance timeout and hands it back without reinjecting', async () => {
    vi.useFakeTimers();
    const input = promptInput('server-ambiguous', {
      userMessageSeq: 42,
      userMessageSeqs: [42],
    });
    const injectPrompt = vi.fn(async () => injected());
    const onInjectionFailure = vi.fn();
    const undeliverable: TerminalPromptInput[][] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onInjectionFailure,
      onUndeliverableInputs: (inputs) => undeliverable.push([...inputs]),
      providerAcceptanceTimeoutMs: 50,
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(injectPrompt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      input,
      failureState: 'failed_ambiguous',
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 0,
      providerAcceptancePendingCount: 1,
      headInputState: 'failed_ambiguous',
      lastFailureReason: 'ambiguous_provider_acceptance',
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(injectPrompt).toHaveBeenCalledTimes(1);

    arbiter.dispose();

    expect(undeliverable).toEqual([[input]]);
  });

  it('blocks local-id-only server-owned pending input after ambiguous provider-acceptance timeout without reinjecting', async () => {
    vi.useFakeTimers();
    const input = promptInput('server-ambiguous-local-id', {
      localIds: ['pending-local-id-only'],
      userMessageSeq: null,
    });
    const injectPrompt = vi.fn(async () => injected());
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onInjectionFailure,
      providerAcceptanceTimeoutMs: 50,
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(injectPrompt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      input,
      failureState: 'failed_ambiguous',
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      pendingInjectionCount: 0,
      providerAcceptancePendingCount: 1,
      headInputState: 'failed_ambiguous',
      lastFailureReason: 'ambiguous_provider_acceptance',
    });
  });

  it('scales provider acceptance timeout for large injected prompts before retrying', async () => {
    vi.useFakeTimers();
    const message = 'x'.repeat(128_000);
    const input: TerminalPromptInput = {
      ...promptInput('large'),
      text: message,
      multiline: true,
    };
    const injectPrompt = vi.fn(async () => injected({ bytesWritten: 128_000 }));
    const failures: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onInjectionFailure: (failure) => failures.push(failure.failureState),
      providerAcceptanceTimeoutMs: 50,
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(failures).toEqual([]);
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    const scaledTimeoutMs = resolveTerminalPromptProviderAcceptanceTimeoutMs(message, {
      baseTimeoutMs: 50,
      bytesWritten: 128_000,
    });
    await vi.advanceTimersByTimeAsync(scaledTimeoutMs + 1);

    expect(failures).toEqual(['failed_ambiguous']);
    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });
  });

  it('accepts an ambiguous timeout without retrying when core already recorded provider acceptance', async () => {
    vi.useFakeTimers();
    const input = promptInput('already-accepted');
    const injectPrompt = vi.fn(async () => injected());
    const onPromptAccepted = vi.fn();
    const isPromptDeliveryAccepted = vi.fn((candidate: TerminalPromptInput) => candidate === input);
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onPromptAccepted,
      isPromptDeliveryAccepted,
      providerAcceptanceTimeoutMs: 50,
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(injectPrompt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);

    expect(isPromptDeliveryAccepted).toHaveBeenCalledWith(input);
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(onPromptAccepted).toHaveBeenCalledWith(input, expect.any(Object));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'submitted',
      lastFailureReason: null,
    });
  });

  it('accepts a seq-less pending head before the next in-flight drain when core delivery state records provider acceptance', async () => {
    let deliveryAccepted = false;
    const input = promptInput('post-injection-accepted', {
      localIds: ['2354977c-f259-4e0d-bbdc-6268129b5e85'],
      userMessageSeq: null,
    });
    const injectPrompt = vi.fn(async () => injected());
    const accepted: Array<Readonly<{ text: string; acceptedAs: string }>> = [];
    const isPromptDeliveryAccepted = vi.fn((candidate: TerminalPromptInput) => (
      candidate === input && deliveryAccepted
    ));
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      isPromptDeliveryAccepted,
      onPromptAccepted: (acceptedInput, acceptance) => {
        accepted.push({
          text: acceptedInput.text,
          acceptedAs: acceptance.acceptedAs,
        });
      },
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    deliveryAccepted = true;
    arbiter.observeReadiness(readiness({ activeTurnId: 'turn-live' }));
    await arbiter.drain();

    expect(isPromptDeliveryAccepted).toHaveBeenCalledWith(input);
    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([{
      text: 'prompt post-injection-accepted',
      acceptedAs: 'new_turn',
    }]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'submitted',
      lastFailureReason: null,
    });
  });

  it('does not inject a queued head already accepted by the provider before this arbiter saw it in flight', async () => {
    const input = promptInput('pre-injection-accepted', {
      localIds: ['local-pre-injection-accepted'],
      userMessageSeq: null,
    });
    const injectPrompt = vi.fn(async () => injected());
    const accepted: Array<Readonly<{ text: string; acceptedAs: string }>> = [];
    const isPromptDeliveryAccepted = vi.fn((candidate: TerminalPromptInput) => candidate === input);
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      isPromptDeliveryAccepted,
      onPromptAccepted: (acceptedInput, acceptance) => {
        accepted.push({
          text: acceptedInput.text,
          acceptedAs: acceptance.acceptedAs,
        });
      },
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness({ activeTurnId: 'turn-live' }));
    await arbiter.drain();

    expect(isPromptDeliveryAccepted).toHaveBeenCalledWith(input);
    expect(injectPrompt).not.toHaveBeenCalled();
    expect(accepted).toEqual([{
      text: 'prompt pre-injection-accepted',
      acceptedAs: 'in_flight_steer',
    }]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'submitted',
      lastFailureReason: null,
    });
  });

  it('keeps a terminal-injected prompt retryable while compaction interrupts provider acceptance', async () => {
    vi.useFakeTimers();
    const injectPrompt = vi.fn(async () => injected());
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onInjectionFailure,
      providerAcceptanceTimeoutMs: 50,
    });

    arbiter.enqueue(promptInput('compacted'));
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    arbiter.observeCompaction({ phase: 'started' });
    await vi.advanceTimersByTimeAsync(50);

    expect(onInjectionFailure).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
      lastFailureReason: null,
    });

    arbiter.observeCompaction({ phase: 'completed' });
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
      lastFailureReason: null,
    });
  });

  it('terminalizes terminal queued-banner custody when provider acceptance never arrives', async () => {
    vi.useFakeTimers();
    const injectPrompt = vi.fn(async () => injected());
    const onPromptAccepted = vi.fn();
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onPromptAccepted,
      onInjectionFailure,
      providerAcceptanceTimeoutMs: 50,
    });

    const input = promptInput('terminal-custody');
    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    await expect(arbiter.observeTerminalPromptCustody(input)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(50);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(onInjectionFailure).not.toHaveBeenCalled();
    expect(onPromptAccepted).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      terminalCustodyCount: 1,
      providerAcceptancePendingCount: 1,
      headInputState: 'awaiting_provider_acceptance',
      lastFailureReason: null,
    });

    arbiter.armPendingProviderAcceptanceTimeout();
    await vi.advanceTimersByTimeAsync(50);

    expect(onInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      input,
      failureState: 'failed_terminal',
      result: expect.objectContaining({
        reason: 'ambiguous_provider_acceptance',
        duplicateRisk: 'likely',
      }),
    }));
    expect(onPromptAccepted).not.toHaveBeenCalled();
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'failed_terminal',
      lastFailureReason: 'ambiguous_provider_acceptance',
    });

    await expect(arbiter.confirmProviderAcceptance({
      promptText: 'prompt terminal-custody',
    })).resolves.toBe(false);
  });

  it('terminalizes terminal queued-banner custody immediately when the terminal reports a failed turn', async () => {
    vi.useFakeTimers();
    const injectPrompt = vi.fn(async () => injected());
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onInjectionFailure,
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
      failureState: 'failed_terminal',
      result: expect.objectContaining({
        reason: 'ambiguous_provider_acceptance',
        duplicateRisk: 'likely',
      }),
    }));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      terminalCustodyCount: 0,
      providerAcceptancePendingCount: 0,
      headInputState: 'failed_terminal',
      lastFailureReason: 'ambiguous_provider_acceptance',
    });
  });

  it('continues injecting later prompts while earlier prompts wait in Claude terminal custody', async () => {
    vi.useFakeTimers();
    const first = promptInput('terminal-custody-first');
    const second = promptInput('terminal-custody-second');
    const injectedTexts: string[] = [];
    const acceptedTexts: string[] = [];
    const undeliverable: TerminalPromptInput[][] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async (input) => {
        injectedTexts.push(input.text);
        return injected();
      }),
      onPromptAccepted: (input) => {
        acceptedTexts.push(input.text);
      },
      onUndeliverableInputs: (inputs) => undeliverable.push([...inputs]),
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
    expect(undeliverable).toEqual([]);
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
  });

  it('accepts a timed-out compact prompt when compact boundary evidence arrives later', async () => {
    vi.useFakeTimers();
    const onPromptAccepted = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt: vi.fn(async () => injected()),
      onPromptAccepted,
      providerAcceptanceTimeoutMs: 50,
    });
    const compactInput: TerminalPromptInput = {
      text: '/compact',
      multiline: false,
      origin: { kind: 'ui_pending', nonce: 'compact' },
      scheduling: {},
    };

    arbiter.enqueue(compactInput);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();
    await vi.advanceTimersByTimeAsync(50);

    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'failed_ambiguous',
    });

    await expect(arbiter.confirmProviderAcceptance({
      promptText: '/compact',
      includeTimedOutAmbiguous: true,
    })).resolves.toBe(true);

    expect(onPromptAccepted).toHaveBeenCalledWith(compactInput, expect.any(Object));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'submitted',
      lastFailureReason: null,
    });
  });

  it('accepts late provider confirmation for an ambiguous timeout without retrying again', async () => {
    vi.useFakeTimers();
    const onPromptAccepted = vi.fn();
    const injectPrompt = vi.fn(async () => injected());
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onPromptAccepted,
      providerAcceptanceTimeoutMs: 50,
    });

    const input = promptInput('late-confirmed');
    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    await vi.advanceTimersByTimeAsync(50);
    expect(injectPrompt).toHaveBeenCalledTimes(2);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    await expect(arbiter.confirmProviderAcceptance({
      promptText: 'prompt late-confirmed',
      includeTimedOutAmbiguous: true,
    })).resolves.toBe(true);

    expect(onPromptAccepted).toHaveBeenCalledWith(input, expect.any(Object));
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'submitted',
      lastFailureReason: null,
    });
    expect(injectPrompt).toHaveBeenCalledTimes(2);
  });

  it('accepts local-id-only pending prompt when finalizing readiness proves provider custody before timeout', async () => {
    vi.useFakeTimers();
    const input = promptInput('finalizing-accepted', {
      localIds: ['pending-local-finalizing'],
    });
    const accepted: string[] = [];
    const injectPrompt = vi.fn(async () => injected());
    const onInjectionFailure = vi.fn();
    const arbiter = createClaudeUnifiedInputArbiter({
      injectPrompt,
      onPromptAccepted: (acceptedInput) => {
        accepted.push(acceptedInput.text);
      },
      onInjectionFailure,
      providerAcceptanceTimeoutMs: 50,
    });

    arbiter.enqueue(input);
    arbiter.observeReadiness(readiness());
    await arbiter.drain();

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([]);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 1,
      headInputState: 'awaiting_provider_acceptance',
    });

    arbiter.observeReadiness(readiness({ status: 'defer_finalizing' }));
    await vi.advanceTimersByTimeAsync(50);

    expect(injectPrompt).toHaveBeenCalledTimes(1);
    expect(onInjectionFailure).not.toHaveBeenCalled();
    expect(accepted).toEqual(['prompt finalizing-accepted']);
    expect(arbiter.snapshot()).toMatchObject({
      queuedCount: 0,
      headInputState: 'submitted',
      lastFailureReason: null,
    });
  });

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

  describe('undeliverable-input handback (ported HF-2 / F-1)', () => {
    it('hands back ALL still-queued inputs in FIFO order on dispose, including the awaiting-acceptance head', async () => {
      const undeliverable: TerminalPromptInput[][] = [];
      const arbiter = createClaudeUnifiedInputArbiter({
        injectPrompt: vi.fn(async () => injected()),
        onUndeliverableInputs: (inputs) => undeliverable.push([...inputs]),
      });

      const head = promptInput('head');
      const tail = promptInput('tail');
      arbiter.enqueue(head);
      arbiter.enqueue(tail);
      arbiter.observeReadiness(readiness());
      await arbiter.drain();
      expect(arbiter.snapshot()).toMatchObject({ headInputState: 'awaiting_provider_acceptance' });

      arbiter.dispose();

      // FIFO, never silently dropped. The awaiting-acceptance head is duplicate-attempt
      // direction: redelivery is deduped downstream, silent loss is not recoverable.
      expect(undeliverable).toEqual([[head, tail]]);
    });

    it('hands back an input enqueued after dispose instead of silently refusing it', () => {
      const undeliverable: TerminalPromptInput[][] = [];
      const arbiter = createClaudeUnifiedInputArbiter({
        injectPrompt: vi.fn(async () => injected()),
        onUndeliverableInputs: (inputs) => undeliverable.push([...inputs]),
      });

      arbiter.dispose();
      const late = promptInput('late');
      arbiter.enqueue(late);

      expect(undeliverable).toEqual([[late]]);
    });

    it('does not hand back prompts the provider already accepted', async () => {
      const undeliverable: TerminalPromptInput[][] = [];
      const arbiter = createClaudeUnifiedInputArbiter({
        injectPrompt: vi.fn(async () => injected()),
        onUndeliverableInputs: (inputs) => undeliverable.push([...inputs]),
      });

      arbiter.enqueue(promptInput('accepted'));
      arbiter.observeReadiness(readiness());
      await arbiter.drain();
      await expect(arbiter.confirmProviderAcceptance()).resolves.toBe(true);

      arbiter.dispose();

      expect(undeliverable).toEqual([]);
    });

    it('does not hand back a prompt after provider acceptance uncertainty terminalizes', async () => {
      vi.useFakeTimers();
      const undeliverable: TerminalPromptInput[][] = [];
      const arbiter = createClaudeUnifiedInputArbiter({
        injectPrompt: vi.fn(async () => injected()),
        onUndeliverableInputs: (inputs) => undeliverable.push([...inputs]),
        providerAcceptanceTimeoutMs: 50,
      });

      arbiter.enqueue(promptInput('terminal-unknown'));
      arbiter.observeReadiness(readiness());
      await arbiter.drain();
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(50);

      expect(arbiter.snapshot()).toMatchObject({
        queuedCount: 1,
        headInputState: 'failed_terminal',
        lastFailureReason: 'ambiguous_provider_acceptance',
      });

      arbiter.dispose();

      expect(undeliverable).toEqual([]);
    });

    it('does not hand back a terminal-custody prompt that never received provider confirmation', async () => {
      const undeliverable: TerminalPromptInput[][] = [];
      const arbiter = createClaudeUnifiedInputArbiter({
        injectPrompt: vi.fn(async () => injected()),
        onUndeliverableInputs: (inputs) => undeliverable.push([...inputs]),
      });

      const input = promptInput('terminal-custody-handback');
      arbiter.enqueue(input);
      arbiter.observeReadiness(readiness());
      await arbiter.drain();
      await expect(arbiter.observeTerminalPromptCustody(input)).resolves.toBe(true);

      arbiter.dispose();

      expect(undeliverable).toEqual([]);
    });
  });
});
