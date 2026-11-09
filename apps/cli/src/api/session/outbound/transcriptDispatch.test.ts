import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol';
import {
  applyRuntimeOutboundTranscriptPostSendEffects,
  prepareAcpTranscriptDispatch,
  recordRuntimeOutboundTranscriptToolTraceEvents,
} from './transcriptDispatch';
import type { PostSendReactionPort } from '../client/reactions/providers/postSendReactionPort';
import type { Metadata } from '../../types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { withToolTraceFile } from '@/testkit/logger/toolTraceFile';

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

  it('records only provider-projected outbound tool trace events', async () => {
    await withToolTraceFile('runtime-outbound-trace-', async (filePath) => {
      recordRuntimeOutboundTranscriptToolTraceEvents('session-1', [{
        source: { protocol: 'acp', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        kind: 'tool-call',
        payload: { type: 'tool-call' },
        localId: 'tool-local-1',
      }]);

      expect(JSON.parse(readFileSync(filePath, 'utf8').trim())).toMatchObject({
        direction: 'outbound',
        sessionId: 'session-1',
        source: { protocol: 'acp', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        kind: 'tool-call',
        localId: 'tool-local-1',
      });
    });
  });

  it('keeps the admitted native source through the ACP transcript envelope', () => {
    const source = { protocol: 'native', agent: { pluginId: 'example.agent', localId: 'native' } } as const;
    const prepared = prepareAcpTranscriptDispatch({
      provider: 'example.agent/native', source,
      body: { type: 'tool-call', callId: 'native-call', id: 'native-row', name: 'Bash', input: { command: 'pwd' } },
      toolCallCanonicalNameByProviderAndId: new Map(),
      permissionToolCallRawInputByProviderAndId: new Map(),
      toolCallInputByProviderAndId: new Map(),
    });
    expect(prepared.source).toEqual(source);
    expect(prepared.normalizedBody).toMatchObject({ input: { _happier: { v: 3, ...source } } });
    expect(prepared.content).toMatchObject({ content: { type: 'acp', agentId: 'example.agent/native',
      data: { input: { _happier: { v: 3, ...source } } } } });
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
