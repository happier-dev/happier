import { describe, expect, it } from 'vitest';

import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createAcpRuntime } from '../createAcpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

function createRuntimeWithUsageEvents(): Readonly<{
  backend: ReturnType<typeof createFakeAcpRuntimeBackend>;
  runtime: ReturnType<typeof createAcpRuntime>;
  usageEvents: AgentSessionRuntimeEventV1[];
}> {
  const backend = createFakeAcpRuntimeBackend();
  const runtime = createAcpRuntime({
    provider: 'opencode',
    directory: '/tmp',
    session: createBasicSessionClientWithOverrides(),
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    ensureBackend: async () => backend,
  });
  const usageEvents: AgentSessionRuntimeEventV1[] = [];
  runtime.subscribeRuntimeEvents((message) => {
    const event = AgentSessionRuntimeEventV1Schema.parse(message);
    if (event.kind === 'usage-observed') usageEvents.push(event);
  });
  return { backend, runtime, usageEvents };
}

function readUsageObservation(
  event: AgentSessionRuntimeEventV1 | undefined,
): Extract<AgentSessionRuntimeEventV1, { kind: 'usage-observed' }> {
  if (!event || event.kind !== 'usage-observed') {
    throw new Error(`expected a usage-observed event, received ${event?.kind ?? 'none'}`);
  }
  return event;
}

describe('createAcpRuntime (token-count forwarding)', () => {
  it('normalizes token-count agent messages into canonical usage observations', async () => {
    const { backend, runtime, usageEvents } = createRuntimeWithUsageEvents();

    await runtime.sendTurnPrompt('session setup');
    backend.emit({
      type: 'token-count',
      key: 'turn-1',
      model: 'model-a',
      tokens: { total: 5, input: 2, output: 3 },
      cost: { total: 1.25 },
      source: 'acp-prompt-usage',
      scope: 'turn_delta',
      context_used_tokens: 5,
      context_window_tokens: 100,
    } as never);

    expect(usageEvents).toEqual([
      expect.objectContaining({
        kind: 'usage-observed',
        source: 'acp-prompt-usage',
        scope: 'turn_delta',
        modelId: 'model-a',
        tokens: {
          input: 2,
          output: 3,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 5,
        },
      }),
    ]);
    // Cost and context are carried by both the canonical schema and the usage
    // consumer (nativeAgentSession -> usage ingest). A token-only observation
    // silently drops user-visible spend and context-window reporting.
    expect(readUsageObservation(usageEvents[0]).cost).toEqual({
      reportedUsd: 0,
      estimatedUsd: 1.25,
      currency: 'USD',
    });
    expect(readUsageObservation(usageEvents[0]).context).toEqual({
      v: 1,
      modelId: 'model-a',
      usedTokens: 5,
      windowTokens: 100,
      totalProcessedTokens: null,
      baselineTokens: null,
      isAutoCompactEnabled: null,
      categories: null,
      observedAtMs: expect.any(Number),
      source: 'provider_turn',
    });
  });

  it('preserves a provider-supplied context snapshot instead of re-deriving one', async () => {
    const { backend, runtime, usageEvents } = createRuntimeWithUsageEvents();
    const contextSnapshot = {
      v: 1,
      modelId: 'model-a',
      usedTokens: 7,
      windowTokens: 200,
      totalProcessedTokens: 41,
      baselineTokens: 12,
      isAutoCompactEnabled: true,
      categories: [{ key: 'system', label: 'System prompt', tokens: 3 }],
      observedAtMs: 1_700_000_000_000,
      source: 'provider_live',
    } as const;

    await runtime.sendTurnPrompt('session setup');
    backend.emit({
      type: 'token-count',
      model: 'model-a',
      tokens: { total: 5, input: 2, output: 3 },
      contextSnapshot,
    } as never);

    expect(readUsageObservation(usageEvents[0]).context).toEqual(contextSnapshot);
  });

  it('keeps the canonical token shape when legacy input contains invalid and extra values', async () => {
    const { backend, runtime, usageEvents } = createRuntimeWithUsageEvents();

    await runtime.sendTurnPrompt('session setup');
    backend.emit({
      type: 'token-count',
      key: '  turn-1  ',
      model: ' model-a ',
      tokens: { total: 'nope', input: 2, extra: 'x' },
      cost: { total: 'bad', component: 0.1, nested: { leak: 999 }, __proto__: 1 },
    } as never);

    expect(usageEvents).toEqual([
      expect.objectContaining({
        modelId: 'model-a',
        tokens: {
          input: 2,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 2,
        },
      }),
    ]);
    // Numeric cost components survive as the canonical breakdown; nested
    // non-numeric payloads and prototype-pollution keys do not.
    expect(readUsageObservation(usageEvents[0]).cost).toEqual({
      reportedUsd: 0,
      estimatedUsd: 0.1,
      currency: 'USD',
      breakdown: { component: 0.1 },
    });
    expect(JSON.stringify(usageEvents[0])).not.toContain('nested');
    expect(JSON.stringify(usageEvents[0])).not.toContain('leak');
    expect(JSON.stringify(usageEvents[0])).not.toContain('__proto__');
  });

  it('does not publish a usage observation when token-count data is missing', async () => {
    const { backend, runtime, usageEvents } = createRuntimeWithUsageEvents();

    await runtime.sendTurnPrompt('session setup');
    backend.emit({ type: 'token-count', foo: 'bar' } as never);

    expect(usageEvents).toEqual([]);
  });

  it('maps only canonical token categories from oversized legacy token maps', async () => {
    const { backend, runtime, usageEvents } = createRuntimeWithUsageEvents();
    const tokens: Record<string, number> = { input: 1, output: 2 };
    for (let index = 0; index < 100; index += 1) {
      tokens[`k${index}`] = index;
    }

    await runtime.sendTurnPrompt('session setup');
    backend.emit({ type: 'token-count', tokens } as never);

    expect(usageEvents).toEqual([
      expect.objectContaining({
        tokens: {
          input: 1,
          output: 2,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 3,
        },
      }),
    ]);
  });
});
