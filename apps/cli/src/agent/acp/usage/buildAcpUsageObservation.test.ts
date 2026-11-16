import { describe, expect, it } from 'vitest';
import { AgentUsageObservedPayloadV1Schema } from '@happier-dev/protocol/runtime/agentUsageObservedPayloadV1';
import { buildTokenCountAgentMessageFromUsageObservation, buildTokenCountSessionMessageFromUsageObservation, buildLegacyUsageReportFromUsageObservation } from '@/usage/legacy/legacyUsageTransport';
import { buildUsageObservedMeasurementFromTokenCountMessage } from '../runtime/tokenCountForwarding';
import { resolveUsageTokenCategories } from '@happier-dev/protocol/usage/usageTokenCategories';
import { FX_PROMPT_USAGE } from '../../../../../../packages/plugins/fx/src/agent/acp/usage';

import { buildAcpPromptUsageObservation, buildAcpUsageUpdateObservation } from './buildAcpUsageObservation';

it('keeps partial ACP counters through telemetry into the runtime without synthesizing totals or cache facts', () => {
  const observation = buildAcpUsageUpdateObservation({ provider: 'fixture', update: { inputTokens: 8, outputTokens: 2 } });
  const message = buildTokenCountAgentMessageFromUsageObservation(observation!);
  expect(message).toMatchObject({ tokens: { input: 8, output: 2 } });
  expect(message?.tokens).not.toHaveProperty('total');
  const measurement = buildUsageObservedMeasurementFromTokenCountMessage({ provider: 'fixture', body: message, observedAtMs: 1 });
  expect(AgentUsageObservedPayloadV1Schema.parse({ kind: 'usage-observed', observationId: 'partial-1', ...measurement }))
    .toMatchObject({ tokens: { input: 8, output: 2, cacheRead: null, cacheWrite: null, reasoning: null, total: null } });
});

describe('buildAcpPromptUsageObservation', () => {
  it('preserves witnessed FX counter overlap through the real producer and runtime carrier', () => {
    const observation = buildAcpPromptUsageObservation({ provider: 'fx',
      promptResponse: { modelId: 'fixture-model', usage: { inputTokens: 17, outputTokens: 7,
        cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 3 } },
      projectUsage: FX_PROMPT_USAGE.projectPromptUsage,
    });
    for (const buildMessage of [buildTokenCountAgentMessageFromUsageObservation, buildTokenCountSessionMessageFromUsageObservation]) {
      const message = buildMessage(observation!);
      const measurement = buildUsageObservedMeasurementFromTokenCountMessage({ provider: 'fx', body: message, observedAtMs: 1 });
      const payload = AgentUsageObservedPayloadV1Schema.parse({ kind: 'usage-observed', observationId: 'fx-inference', ...measurement });
      expect(payload.accounting).toMatchObject({ inputIncludesCache: true, outputIncludesReasoning: true });
      expect(resolveUsageTokenCategories(payload.tokens!, payload.accounting))
        .toEqual({ input: 10, output: 4, cacheRead: 5, cacheWrite: 2, reasoning: 3, total: 24 });
    }
  });

  it.each(['modelId', 'model'] as const)('retains a model witnessed inside prompt usage (%s)', modelKey => {
    const observation = buildAcpPromptUsageObservation({ provider: 'fixture', promptResponse: {
      usage: { [modelKey]: 'usage-model', inputTokens: 7, outputTokens: 3 },
    } });
    const message = buildTokenCountAgentMessageFromUsageObservation(observation!);
    expect(buildUsageObservedMeasurementFromTokenCountMessage({ provider: 'fixture', body: message, observedAtMs: 1 }))
      .toMatchObject({ modelId: 'usage-model', tokens: { input: 7, output: 3 } });
  });

  it('retains the provider-projected model when the response has no model and prefers an explicit response model', () => {
    for (const modelId of [undefined, 'response-model']) {
      expect(buildAcpPromptUsageObservation({ provider: 'fixture',
        promptResponse: { modelId, _meta: { usage: { inputTokens: 7 } } },
        projectUsage: ({ usage }) => ({ ...usage as Record<string, unknown>, modelId: 'projected-model' }),
      })).toMatchObject({ modelId: modelId ?? 'projected-model', tokens: { input: 7 } });
    }
  });

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
    expect(report).toBeNull();
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
