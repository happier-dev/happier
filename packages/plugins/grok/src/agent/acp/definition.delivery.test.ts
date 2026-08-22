import { describe, expect, it } from 'vitest';

import { buildGrokAcpRuntimeDefinition } from './definition.js';

describe('Grok ACP delivery definition', () => {
  it('projects in-flight steer through x.ai/interject with the admitted input identity', () => {
    const definition = buildGrokAcpRuntimeDefinition({});
    const delivery = Reflect.get(definition, 'delivery') as Readonly<{
      steer?: Readonly<{
        method: string;
        buildParams(input: Readonly<{
          providerSessionId: string;
          inputIds: readonly string[];
          input: Readonly<{ text: string }>;
        }>): unknown;
        isAccepted(response: unknown): boolean;
      }>;
    }> | undefined;
    const steer = delivery?.steer;

    expect(steer?.method).toBe('x.ai/interject');
    expect(steer?.buildParams({
      providerSessionId: 'grok-session-1',
      inputIds: ['pending-input-1'],
      input: { text: 'change direction' },
    })).toEqual({
      sessionId: 'grok-session-1',
      text: 'change direction',
      interjectionId: 'pending-input-1',
    });
    expect(steer?.isAccepted({ status: 'queued' })).toBe(true);
    expect(steer?.isAccepted({ status: 'unknown' })).toBe(false);
  });

  it('projects prompt usage with Grok accounting semantics', () => {
    const definition = buildGrokAcpRuntimeDefinition({});
    const usage = Reflect.get(definition, 'usage') as Readonly<{
      projectPromptUsage?: (input: Readonly<{ usage: unknown; promptResponse: unknown }>) => unknown;
    }> | undefined;

    expect(usage?.projectPromptUsage?.({
      usage: {
        inputTokens: 70,
        outputTokens: 30,
        cachedReadTokens: 20,
        cacheCreationTokens: 5,
        reasoningTokens: 10,
        costUsdTicks: 2_500_000_000,
        costIsPartial: false,
        usageIsIncomplete: false,
      },
      promptResponse: {},
    })).toEqual({
      tokens: {
        total: 100,
        input: 70,
        output: 30,
        cacheRead: 20,
        cacheWrite: 5,
        reasoning: 10,
      },
      cost: {
        total: 0.25,
        reportedUsd: 0.25,
        costSource: 'provider_reported',
      },
    });
  });
});
