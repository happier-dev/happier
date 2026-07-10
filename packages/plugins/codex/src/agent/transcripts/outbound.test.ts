import { describe, expect, it, vi } from 'vitest';

import type { RuntimeOutboundTranscriptToolNormalizationV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { createCodexOutboundTranscriptDispatchFacet } from './outbound.js';

function createToolNormalization(): RuntimeOutboundTranscriptToolNormalizationV1 {
  return {
    normalizeToolCallV2: vi.fn(() => ({
      canonicalToolName: 'Bash',
      input: { command: 'pwd', _happier: { normalized: true } },
    })),
    normalizeToolResultV2: vi.fn(() => ({
      stdout: '/repo',
      _happier: { canonicalToolName: 'Bash' },
    })),
  };
}

function createMetadata(): Record<string, unknown> {
  return {
    runtimeDescriptorV1: {
      v: 1,
      agentId: 'codex',
      provider: {
        backendMode: 'appServer',
        providerExtra: {
          owner: 'happier',
          schemaId: 'happier.hostSessionRuntimeIdentity',
          v: 1,
          runtimeHandle: {
            backendId: 'codex',
            providerId: 'codex',
            backendMode: 'appServer',
          },
        },
      },
    },
  };
}

describe('Codex outbound transcript dispatch', () => {
  it('uses the injected tool normalization service for Codex tool calls and results', () => {
    const facet = createCodexOutboundTranscriptDispatchFacet();
    const toolNormalization = createToolNormalization();
    const toolCallCanonicalNameByProviderAndId = new Map<string, {
      rawToolName: string;
      canonicalToolName: string;
    }>();

    const toolCallPlan = facet.prepareDispatch({
      body: {
        type: 'tool-call',
        callId: 'call-1',
        name: 'shell',
        input: { cmd: 'pwd' },
      },
      randomId: () => 'local-tool-call',
      toolNormalization,
      toolCallCanonicalNameByProviderAndId,
    });

    expect(toolNormalization.normalizeToolCallV2).toHaveBeenCalledWith({
      protocol: 'codex',
      provider: 'codex',
      toolName: 'shell',
      rawInput: { cmd: 'pwd' },
      callId: 'call-1',
    });
    expect(toolCallCanonicalNameByProviderAndId.get('codex:call-1')).toEqual({
      rawToolName: 'shell',
      canonicalToolName: 'Bash',
    });
    expect(toolCallPlan).toMatchObject({
      localId: 'local-tool-call',
      sidechainId: null,
      messageRole: 'event',
      content: {
        role: 'agent',
        content: {
          type: 'codex',
          data: {
            type: 'tool-call',
            callId: 'call-1',
            name: 'Bash',
            input: { command: 'pwd', _happier: { normalized: true } },
          },
        },
      },
    });
    expect(toolCallPlan.toolTraceEvents).toEqual([
      expect.objectContaining({
        protocol: 'codex',
        provider: 'codex',
        kind: 'tool-call',
      }),
    ]);

    const toolResultPlan = facet.prepareDispatch({
      body: {
        type: 'tool-call-result',
        callId: 'call-1',
        output: { stdout: '/repo' },
      },
      randomId: () => 'local-tool-result',
      toolNormalization,
      toolCallCanonicalNameByProviderAndId,
    });

    expect(toolNormalization.normalizeToolResultV2).toHaveBeenCalledWith({
      protocol: 'codex',
      provider: 'codex',
      rawToolName: 'shell',
      canonicalToolName: 'Bash',
      rawOutput: { stdout: '/repo' },
    });
    expect(toolResultPlan.content).toMatchObject({
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'tool-call-result',
          callId: 'call-1',
          output: {
            stdout: '/repo',
            _happier: { canonicalToolName: 'Bash' },
          },
        },
      },
    });
  });

  it('emits token-count usage effects with runtime backend identity from metadata', () => {
    const facet = createCodexOutboundTranscriptDispatchFacet();

    const plan = facet.prepareDispatch({
      body: {
        type: 'token_count',
        id: 'usage-1',
        tokenUsage: {
          last: {
            input_tokens: 5,
            output_tokens: 7,
          },
        },
      },
      metadata: createMetadata(),
      randomId: () => 'local-token-count',
    });

    expect(plan.postSendEffects).toContainEqual({
      type: 'tokenCountUsageObservation',
      provider: 'codex',
      body: {
        type: 'token_count',
        id: 'usage-1',
        tokenUsage: {
          last: {
            input_tokens: 5,
            output_tokens: 7,
          },
        },
      },
      backendMode: 'appServer',
      externalKey: 'usage-1',
    });
  });

  it('classifies Codex agent_message transcript bodies as agent messages', () => {
    const facet = createCodexOutboundTranscriptDispatchFacet();

    const plan = facet.prepareDispatch({
      body: {
        type: 'agent_message',
        text: 'codex assistant text',
      },
      randomId: () => 'local-agent-message',
    });

    expect(plan).toMatchObject({
      localId: 'local-agent-message',
      messageRole: 'agent',
      content: {
        role: 'agent',
        content: {
          type: 'codex',
          data: {
            type: 'agent_message',
            text: 'codex assistant text',
          },
        },
      },
    });
  });
});
