import { expect, it } from 'vitest';

import { prepareAcpTranscriptDispatch } from '@/api/session/outbound/transcriptDispatch';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { createCommittedExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';

it.each(['parent', 'child'] as const)('publishes admitted %s tool provenance through committed Run custody', async owner => {
  const parentSource = { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
  const childSource = { protocol: 'acp', agent: { pluginId: 'example.child', localId: 'worker' } } as const;
  const expectedSource = owner === 'child' ? childSource : parentSource;
  const rows: ACPMessageData[] = [];
  const caches = {
    toolCallCanonicalNameByProviderAndId: new Map<string, { rawToolName: string; canonicalToolName: string }>(),
    permissionToolCallRawInputByProviderAndId: new Map<string, unknown>(),
    toolCallInputByProviderAndId: new Map<string, unknown>(),
  };
  const publish = createCommittedExecutionRunTranscriptPublisher({
    readParentToolNormalizationSource: () => parentSource,
    // Durable transcript storage is the boundary; the publisher and normalizer remain real.
    enqueueAgentMessageCommitted: async (provider, body, opts) => {
      rows.push(prepareAcpTranscriptDispatch({ ...caches, provider, body, source: opts.toolNormalizationSource,
        localId: opts.localId, meta: opts.meta }).normalizedBody);
      return { persisted: true, delivered: true };
    },
  });
  const options = { meta: {}, ...(owner === 'child' ? { toolNormalizationSource: childSource } : {}) };
  await publish('codex', { type: 'tool-call', callId: 'run-call', id: 'call', name: 'SubAgentRun',
    input: { runId: 'run' } }, options);
  await publish('codex', { type: 'tool-result', callId: 'run-call', id: 'result', output: { status: 'succeeded' } }, options);

  expect(rows).toMatchObject([
    { type: 'tool-call', input: { _happier: { v: 3, ...expectedSource } } },
    { type: 'tool-result', output: { _happier: { v: 3, ...expectedSource } } },
  ]);
});
