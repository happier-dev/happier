import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol';
import type { RuntimeOutboundTranscriptDispatchFacetV1 } from '@happier-dev/agents';

const {
  resolveBackendEngineAdapterResolutionMock,
  resolveOutboundTranscriptDispatchFacetMock,
} = vi.hoisted(() => ({
  resolveBackendEngineAdapterResolutionMock: vi.fn(),
  resolveOutboundTranscriptDispatchFacetMock: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveOutboundTranscriptDispatchFacet: (...args: unknown[]) => resolveOutboundTranscriptDispatchFacetMock(...args),
  }),
}));

import {
  applyRuntimeOutboundTranscriptPostSendEffects,
  prepareAcpTranscriptDispatch,
  readRuntimeOutboundTranscriptDispatchBackendId,
  resolveRuntimeOutboundTranscriptDispatchFacet,
} from './transcriptDispatch';
import type { PostSendReactionPort } from '../client/reactions/providers/postSendReactionPort';
import type { Metadata } from '../../types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

function createPostSendReactionPort(metadataOverrides?: Partial<Metadata>): Readonly<{
  port: PostSendReactionPort;
  getMetadata: () => Metadata;
  updateMetadata: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
}> {
  let metadata = createTestMetadata(metadataOverrides);
  const updateMetadata = vi.fn((updater: (metadata: Metadata) => Metadata) => {
    metadata = updater(metadata);
  });
  const publish = vi.fn(async () => undefined);
  return {
    port: {
      sessionId: 'session-1',
      updateMetadata,
      updateAgentState: vi.fn(),
      getMetadataSnapshot: () => metadata,
      usageObservationPublisher: { publish },
    },
    getMetadata: () => metadata,
    updateMetadata,
    publish,
  };
}

describe('transcriptDispatch', () => {
  const codexProvider = 'codex';

  beforeEach(() => {
    resolveBackendEngineAdapterResolutionMock.mockReset();
    resolveOutboundTranscriptDispatchFacetMock.mockReset();
  });

  it('reads the active backend id from runtime descriptor providerExtra runtimeHandle', () => {
    expect(readRuntimeOutboundTranscriptDispatchBackendId({
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
            },
          },
        },
      },
    })).toBe('codex');
  });

  it('does not infer a backend id when the runtime descriptor has no selected runtime handle', () => {
    expect(readRuntimeOutboundTranscriptDispatchBackendId({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
          },
        },
      },
    })).toBeNull();
  });

  it('resolves the runtime outbound dispatch facet through SessionHostBridge', async () => {
    const facet: RuntimeOutboundTranscriptDispatchFacetV1 = {
      prepareDispatch: vi.fn(),
    };
    resolveBackendEngineAdapterResolutionMock.mockRejectedValue(new Error('bypassed SessionHostBridge'));
    resolveOutboundTranscriptDispatchFacetMock.mockResolvedValue({ backendId: 'codex', facet });

    await expect(resolveRuntimeOutboundTranscriptDispatchFacet({
      metadata: createTestMetadata({
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
              },
            },
          },
        },
      }),
    })).resolves.toEqual({ backendId: 'codex', facet });

    expect(resolveOutboundTranscriptDispatchFacetMock).toHaveBeenCalledWith('codex');
    expect(resolveBackendEngineAdapterResolutionMock).not.toHaveBeenCalled();
  });

  it('does not resolve a dispatch facet when runtime metadata has no backend handle', async () => {
    await expect(resolveRuntimeOutboundTranscriptDispatchFacet({
      metadata: createTestMetadata(),
    })).resolves.toBeNull();

    expect(resolveOutboundTranscriptDispatchFacetMock).not.toHaveBeenCalled();
    expect(resolveBackendEngineAdapterResolutionMock).not.toHaveBeenCalled();
  });

  it('prepares ACP transcript dispatch payloads through the host-generic seam', () => {
    const prepared = prepareAcpTranscriptDispatch({
      provider: codexProvider,
      body: { type: 'message', message: 'hello', sidechainId: 'side-1' } as never,
      localId: 'local-1',
      toolCallCanonicalNameByProviderAndId: new Map(),
      permissionToolCallRawInputByProviderAndId: new Map(),
      toolCallInputByProviderAndId: new Map(),
    });

    expect(prepared.normalizedBody).toEqual({
      type: 'message',
      message: 'hello',
      sidechainId: 'side-1',
    });
    expect(prepared.localId).toBe('local-1');
    expect(prepared.sidechainId).toBe('side-1');
    expect(prepared.content).toEqual({
      role: 'agent',
      content: {
        type: 'acp',
        agentId: codexProvider,
        data: {
          type: 'message',
          message: 'hello',
          sidechainId: 'side-1',
        },
      },
      meta: {
        sentFrom: 'cli',
        source: 'cli',
      },
    });
  });

  it('applies provider-projected title metadata through the generic post-send effect seam', async () => {
    const { port, getMetadata } = createPostSendReactionPort();

    applyRuntimeOutboundTranscriptPostSendEffects(port, [{
      type: 'metadataField',
      fieldId: 'display.title',
      value: {
        title: 'fresh summary',
        updatedAt: 123,
      },
      reason: 'reconciliation',
      metadataReason: 'mirror_claude_summary',
    }]);

    await vi.waitFor(() => {
      expect(getMetadata().summary).toEqual({
        text: 'fresh summary',
        updatedAt: 123,
      });
    });
  });

  it('does not smuggle durable-required runtime work-state through the metadata-only post-send effect seam', async () => {
    const { port, getMetadata, updateMetadata } = createPostSendReactionPort();

    applyRuntimeOutboundTranscriptPostSendEffects(port, [{
      type: 'metadataField',
      fieldId: 'runtime.workState',
      value: {
        v: 1,
        backendId: 'claude',
        agentId: 'claude',
        updatedAt: 123,
        primaryItemId: 'todo:claude:task-1',
        items: [{
          id: 'todo:claude:task-1',
          kind: 'todo',
          origin: 'vendor',
          status: 'active',
          title: 'Patch task projection',
          backendId: 'claude',
          agentId: 'claude',
          vendorRef: 'task-1',
          updatedAt: 123,
        }],
      },
      reason: 'reconciliation',
      metadataReason: 'mirror_claude_task_state',
    }]);

    expect(readSessionWorkStateV1FromMetadata(getMetadata())).toBeNull();
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('applies provider-projected token usage through the generic post-send effect seam', async () => {
    const { port, publish } = createPostSendReactionPort();

    applyRuntimeOutboundTranscriptPostSendEffects(port, [{
      type: 'tokenCountUsageObservation',
      provider: codexProvider,
      body: {
        type: 'token_count',
        id: 'codex-token-1',
        tokens: { total: 9, input: 4, output: 5 },
        source: 'codex-app-server-token-usage',
        scope: 'session_cumulative',
      },
      backendMode: 'appServer',
      externalKey: 'codex-token-1',
    }]);

    await vi.waitFor(() => {
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          backendMode: 'appServer',
          externalKey: 'codex-token-1',
          observation: expect.objectContaining({
            provider: codexProvider,
          }),
        }),
      );
    });
  });
});
