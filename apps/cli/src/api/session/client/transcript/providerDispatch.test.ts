import { describe, expect, it, vi } from 'vitest';

import type {
  RuntimeOutboundTranscriptDispatchFacetV1,
  RuntimeOutboundTranscriptDispatchPlanV1,
} from '@happier-dev/agents';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '../../../types';

import type { PostSendReactionPort } from '../reactions/providers/postSendReactionPort';
import { dispatchProviderTranscriptMessage, type ProviderTranscriptDispatchRequest } from './providerDispatch';
import type { SessionClientTranscriptSendPort } from './sendMessages';

const providerAgnosticRequest = { body: { type: 'sample' } } satisfies ProviderTranscriptDispatchRequest;
// @ts-expect-error A.16y.2 resolves outbound dispatch from runtime metadata, not request provider ids.
const legacyProviderRequest = { provider: 'legacy-provider', body: { type: 'sample' } } satisfies ProviderTranscriptDispatchRequest;
void providerAgnosticRequest;
void legacyProviderRequest;

function createMetadata(backendId = 'selected.backend'): Metadata {
  return createTestMetadata({
    runtimeDescriptorV1: {
      v: 1,
      providerId: 'selected-provider',
      provider: {
        backendMode: 'plugin',
        providerExtra: {
          owner: 'happier',
          schemaId: 'test.runtime',
          v: 1,
          runtimeHandle: {
            backendId,
          },
        },
      },
    },
  });
}

function createPort(metadata: Metadata | null = createMetadata()): SessionClientTranscriptSendPort {
  return {
    sessionId: 'session-1',
    socket: {
      connected: true,
      emit: vi.fn(),
    },
    outboundShapeLogger: {
      log: vi.fn(),
    },
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    getMetadataSnapshot: () => metadata,
    buildOutboundSessionMessagePayload: (content) => ({ t: 'plain', v: content }),
    commitSessionMessageBestEffort: vi.fn(),
    logSendWhileDisconnected: vi.fn(),
    markAgentQueueEchoSuppressedLocalId: vi.fn(),
    toolCallCanonicalNameByProviderAndId: new Map(),
    permissionToolCallRawInputByProviderAndId: new Map(),
    toolCallInputByProviderAndId: new Map(),
  };
}

function createPostSendReactionPort(): PostSendReactionPort {
  return {
    sessionId: 'session-1',
    updateAgentState: vi.fn(async (updater) => updater({} as never)),
    updateMetadata: vi.fn(async (updater) => updater({} as never)),
    getMetadataSnapshot: () => createMetadata(),
    usageObservationPublisher: {
      publish: vi.fn(async () => undefined),
    },
  };
}

function createFacet(): RuntimeOutboundTranscriptDispatchFacetV1 {
  return {
    prepareDispatch: vi.fn((): RuntimeOutboundTranscriptDispatchPlanV1 => ({
      content: {
        role: 'agent',
        content: {
          type: 'test-provider',
          data: { ok: true },
        },
        meta: {
          sentFrom: 'cli',
          source: 'cli',
        },
      },
      localId: 'facet-local-1',
      sidechainId: 'facet-sidechain',
      messageRole: 'agent',
      logErrorMessage: '[test] failed to commit provider message',
      outboundShapeLogs: [{
        label: 'test-provider:normalized',
        payload: { ok: true },
      }],
      disconnectedLog: {
        context: 'test provider message',
        details: { type: 'sample' },
      },
      postSendEffects: [{
        type: 'usageObservation',
        observation: {
          provider: 'test-provider',
          source: 'unit-test',
          scope: 'turn_delta',
          key: 'usage-1',
          modelId: null,
          tokens: { total: 1 },
          cost: null,
          contextUsedTokens: null,
          contextWindowTokens: null,
        },
        backendMode: 'plugin',
        externalKey: 'usage-1',
      }],
    })),
  };
}

describe('providerDispatch', () => {
  it('dispatches through the runtime facet selected from session metadata, not the request provider', async () => {
    const port = createPort(createMetadata('selected.backend'));
    const postSendReactionPort = createPostSendReactionPort();
    const facet = createFacet();
    const resolveTranscriptDispatchFacet = vi.fn(async () => ({
      backendId: 'selected.backend',
      facet,
    }));

    await dispatchProviderTranscriptMessage(
      port,
      { body: { type: 'sample' }, meta: { importedFrom: 'unit' } },
      {
        sessionId: 'session-1',
        postSendReactionPort,
        resolveTranscriptDispatchFacet,
      },
    );

    expect(resolveTranscriptDispatchFacet).toHaveBeenCalledWith({
      metadata: createMetadata('selected.backend'),
    });
    expect(facet.prepareDispatch).toHaveBeenCalledWith(expect.objectContaining({
      body: { type: 'sample' },
      meta: { importedFrom: 'unit' },
      metadata: createMetadata('selected.backend'),
    }));
    expect(port.outboundShapeLogger.log).toHaveBeenCalledWith('test-provider:normalized', { ok: true });
    expect(port.logSendWhileDisconnected).toHaveBeenCalledWith('test provider message', { type: 'sample' });
    expect(port.commitSessionMessageBestEffort).toHaveBeenCalledWith({
      message: {
        t: 'plain',
        v: {
          role: 'agent',
          content: {
            type: 'test-provider',
            data: { ok: true },
          },
          meta: {
            sentFrom: 'cli',
            source: 'cli',
          },
        },
      },
      localId: 'facet-local-1',
      sidechainId: 'facet-sidechain',
      messageRole: 'agent',
      logErrorMessage: '[test] failed to commit provider message',
    });
    expect(postSendReactionPort.usageObservationPublisher.publish).toHaveBeenCalledWith({
      sessionId: 'session-1',
      observation: expect.objectContaining({
        provider: 'test-provider',
        key: 'usage-1',
      }),
      backendMode: 'plugin',
      externalKey: 'usage-1',
    });
  });

  it('fails closed with a typed diagnostic and no commit when the selected engine has no outbound facet', async () => {
    const port = createPort(createMetadata('missing.facet'));
    const resolveTranscriptDispatchFacet = vi.fn(async () => null);

    await expect(dispatchProviderTranscriptMessage(
      port,
      { body: { type: 'sample' } },
      {
        sessionId: 'session-1',
        postSendReactionPort: createPostSendReactionPort(),
        resolveTranscriptDispatchFacet,
      },
    )).rejects.toMatchObject({
      code: 'runtime_outbound_transcript_dispatch_unavailable',
      backendId: 'missing.facet',
    });

    expect(port.commitSessionMessageBestEffort).not.toHaveBeenCalled();
  });
});
