import { describe, expect, it, vi } from 'vitest';

import { handleTokenUsageNotification } from './handleTokenUsageNotification.js';

const capturedNotification = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  tokenUsage: {
    total: {
      totalTokens: 20_019,
      inputTokens: 20_001,
      cachedInputTokens: 4_480,
      outputTokens: 18,
      reasoningOutputTokens: 10,
    },
    last: {
      totalTokens: 319,
      inputTokens: 301,
      cachedInputTokens: 80,
      outputTokens: 18,
      reasoningOutputTokens: 10,
    },
    modelContextWindow: 258_400,
  },
} as const;

describe('handleTokenUsageNotification', () => {
  it('maps the observed app-server payload to one cumulative token-count transcript message', () => {
    const emit = vi.fn();

    expect(handleTokenUsageNotification({
      notificationParams: capturedNotification,
      sessionId: 'session-1',
      modelId: 'gpt-5.4',
      now: () => 1_752_089_600_000,
      emit,
    })).toBe(true);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      type: 'token_count',
      id: 'codex:thread-1:turn-1',
      source: 'codex-app-server-token-usage',
      scope: 'session_cumulative',
      modelId: 'gpt-5.4',
      totalTokens: 20_019,
      inputTokens: 20_001,
      cachedInputTokens: 4_480,
      outputTokens: 18,
      reasoningOutputTokens: 10,
      context_used_tokens: 319,
      context_window_tokens: 258_400,
      contextSnapshot: {
        v: 1,
        modelId: 'gpt-5.4',
        usedTokens: 319,
        windowTokens: 258_400,
        totalProcessedTokens: 20_019,
        baselineTokens: 12_000,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: 1_752_089_600_000,
        source: 'provider_turn',
      },
      cost: expect.objectContaining({
        estimatedUsd: expect.any(Number),
      }),
    }));
    expect(emit.mock.calls[0]?.[1]).toEqual({
      kind: 'usage-observed',
      observationId: expect.stringMatching(/^codex-usage:[a-f0-9]{64}$/u),
      turnId: 'turn-1',
      source: 'codex-app-server-token-usage',
      scope: 'session_cumulative',
      modelId: 'gpt-5.4',
      tokens: {
        input: 20_001,
        output: 18,
        reasoning: 10,
        cacheRead: 4_480,
        cacheWrite: 0,
        total: 20_019,
      },
      cost: expect.objectContaining({
        reportedUsd: 0,
        estimatedUsd: expect.any(Number),
        billingContext: 'unknown',
        costSource: 'pricing_estimate',
        currency: 'USD',
      }),
      context: {
        v: 1,
        modelId: 'gpt-5.4',
        usedTokens: 319,
        windowTokens: 258_400,
        totalProcessedTokens: 20_019,
        baselineTokens: 12_000,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: 1_752_089_600_000,
        source: 'provider_turn',
      },
    });
  });

  it('drops notifications without token usage', () => {
    const emit = vi.fn();
    expect(handleTokenUsageNotification({
      notificationParams: { threadId: 'thread-1', turnId: 'turn-1' },
      sessionId: 'session-1',
      modelId: 'gpt-5.4',
      now: () => 1_752_089_600_000,
      emit,
    })).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps tokens but leaves context absent when the model window is missing', () => {
    const emit = vi.fn();
    expect(handleTokenUsageNotification({
      notificationParams: {
        ...capturedNotification,
        tokenUsage: {
          total: capturedNotification.tokenUsage.total,
          last: capturedNotification.tokenUsage.last,
        },
      },
      sessionId: 'session-1',
      modelId: 'gpt-5.4',
      emit,
    })).toBe(true);

    expect(emit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ totalTokens: 20_019 }));
    expect(emit.mock.calls[0]?.[0]).not.toHaveProperty('context_used_tokens');
    expect(emit.mock.calls[0]?.[0]).not.toHaveProperty('context_window_tokens');
    expect(emit.mock.calls[0]?.[0]).toHaveProperty('contextSnapshot', expect.objectContaining({
      usedTokens: 319,
      windowTokens: null,
    }));
  });

  it('deduplicates exact retries without colliding distinct updates or sessions', () => {
    const emit = vi.fn();
    const notify = (
      sessionId: string,
      notificationParams: typeof capturedNotification = capturedNotification,
    ) => handleTokenUsageNotification({
      notificationParams,
      sessionId,
      modelId: 'gpt-5.4',
      now: () => 1_752_089_600_000 + emit.mock.calls.length,
      emit,
    });

    expect(notify('session-1')).toBe(true);
    expect(notify('session-1')).toBe(true);
    expect(notify('session-1', {
      ...capturedNotification,
      tokenUsage: {
        ...capturedNotification.tokenUsage,
        total: {
          ...capturedNotification.tokenUsage.total,
          totalTokens: 20_020,
          outputTokens: 19,
        },
      },
    })).toBe(true);
    expect(notify('session-2')).toBe(true);

    const observationIds = emit.mock.calls.map((call) => call[1]?.observationId);
    expect(observationIds[0]).toMatch(/^codex-usage:[a-f0-9]{64}$/u);
    expect(observationIds[1]).toBe(observationIds[0]);
    expect(observationIds[2]).not.toBe(observationIds[0]);
    expect(observationIds[3]).not.toBe(observationIds[0]);
  });
});
