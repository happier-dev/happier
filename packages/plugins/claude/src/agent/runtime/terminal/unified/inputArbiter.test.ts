import type {
  TerminalInputInjectionResult,
  TerminalInputReadinessV1,
  TerminalPromptInput,
} from '@happier-dev/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedInputArbiter } from './inputArbiter.js';

function promptInput(nonce: string): TerminalPromptInput {
  return {
    text: `prompt ${nonce}`,
    multiline: false,
    origin: { kind: 'ui_pending', nonce },
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
