import { describe, expect, it } from 'vitest';
import { buildTokenCountAgentMessageFromUsageObservation, buildLegacyUsageReportFromUsageObservation } from '@/usage/legacy/legacyUsageTransport';
import { buildUsageObservedMeasurementFromTokenCountMessage } from '../runtime/tokenCountForwarding';

import { buildAcpPromptUsageObservation, buildAcpUsageUpdateObservation } from './buildAcpUsageObservation';

describe('buildAcpPromptUsageObservation', () => {
  it('reads usage from the ACP prompt metadata envelope', () => {
    expect(buildAcpPromptUsageObservation({
      provider: 'test',
      promptResponse: {
        _meta: {
          usage: { total_tokens: 10, input_tokens: 7, output_tokens: 3 },
        },
      },
    })).toMatchObject({
      source: 'acp-prompt-usage',
      scope: 'turn_delta',
      tokens: { total: 10, input: 7, output: 3 },
    });
  });

  it('uses provider projection for non-additive token classes and trusted cost', () => {
    expect(buildAcpPromptUsageObservation({
      provider: 'grok',
      promptResponse: {
        _meta: {
          usage: {
            inputTokens: 70,
            outputTokens: 30,
            cachedReadTokens: 20,
            reasoningTokens: 10,
          },
        },
      },
      projectUsage: () => ({
        tokens: {
          total: 100,
          input: 70,
          output: 30,
          cacheRead: 20,
          reasoning: 10,
        },
        cost: {
          total: 0.25,
          reportedUsd: 0.25,
          costSource: 'provider_reported',
        },
      }),
    })).toMatchObject({
      tokens: {
        total: 100,
        input: 70,
        output: 30,
        cacheRead: 20,
        reasoning: 10,
      },
      cost: { reportedUsd: 0.25, costSource: 'provider_reported' },
    });
  });
});

it('keeps context-only updates out of billed token measurements through the legacy message bridge', () => {
  for (const cost of [undefined, { amount: 0.25, currency: 'USD' }]) {
    const observation = buildAcpUsageUpdateObservation({ provider: 'fixture', update: { used: 123, size: 1000, cost } });
    expect(observation).not.toBeNull();
    const message = buildTokenCountAgentMessageFromUsageObservation(observation!);
    expect(message).toMatchObject({ tokens: { used: 123, size: 1000 } });
    const measurement = buildUsageObservedMeasurementFromTokenCountMessage({ provider: 'fixture', body: message, observedAtMs: 1 });
    expect(measurement).toMatchObject({ context: { usedTokens: 123, windowTokens: 1000 } });
    expect(measurement).not.toHaveProperty('tokens');
    if (cost) expect(measurement?.cost).toMatchObject({ reportedUsd: 0.25 });
    const report = buildLegacyUsageReportFromUsageObservation({ sessionId: 'session', observation: observation! });
    if (!cost) expect(report).toBeNull();
    else expect(report).toMatchObject({ tokens: { total: 0 }, cost: { total: 0.25 } });
  }
});

it('preserves explicit billed categories when context counters are also supplied', () => {
  const observation = buildAcpUsageUpdateObservation({ provider: 'fixture', update: {
    used: 123, size: 1000, inputTokens: 100, outputTokens: 10, totalTokens: 110,
  } });
  const message = buildTokenCountAgentMessageFromUsageObservation(observation!);
  const measurement = buildUsageObservedMeasurementFromTokenCountMessage({ provider: 'fixture', body: message, observedAtMs: 1 });
  expect(measurement).toMatchObject({ tokens: { input: 100, output: 10, total: 110 }, context: { usedTokens: 123, windowTokens: 1000 } });
});

it('preserves a total-only inference counter that differs from the context mirror', () => {
  const measurement = buildUsageObservedMeasurementFromTokenCountMessage({ provider: 'fixture', observedAtMs: 1,
    body: { tokens: { total: 999, used: 123, size: 1000 }, context_used_tokens: 123, context_window_tokens: 1000 },
  });
  expect(measurement).toMatchObject({ tokens: { total: 999 }, context: { usedTokens: 123, windowTokens: 1000 } });
});

it.each(['totalTokens', 'total_tokens'])('preserves an explicit inference total equal to context usage (%s)', (totalKey) => {
  const observation = buildAcpUsageUpdateObservation({ provider: 'fixture', update: {
    used: 123, size: 1000, [totalKey]: 123,
  } });
  const message = buildTokenCountAgentMessageFromUsageObservation(observation!);
  const measurement = buildUsageObservedMeasurementFromTokenCountMessage({ provider: 'fixture', body: message, observedAtMs: 1 });
  expect(measurement).toMatchObject({ tokens: { total: 123 }, context: { usedTokens: 123, windowTokens: 1000 } });
});
