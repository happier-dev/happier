import { expect, it } from 'vitest';

import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { prepareAcpTranscriptDispatch, type TranscriptDispatchToolMaps } from '@/api/session/outbound/transcriptDispatch';
import { importAcpReplayHistoryV1 } from './history/importAcpReplayHistory';
import { importAcpReplaySidechainV1 } from './history/importAcpReplaySidechain';
import { bindAcpReplaySessionToolSource, type AcpReplayHistorySessionClient } from './sessionClient';

it.each(['history', 'sidechain'] as const)('persists %s replay with its admitted Agent source and stable rows', async (kind) => {
  const source = { protocol: 'acp', agent: { pluginId: 'example.selected-agent', localId: 'selected' } } as const;
  const rows = new Map<string, ACPMessageData>();
  const maps: TranscriptDispatchToolMaps = {
    toolCallCanonicalNameByProviderAndId: new Map(),
    permissionToolCallRawInputByProviderAndId: new Map(),
    toolCallInputByProviderAndId: new Map(),
  };
  // Replace only durable transcript storage. Importers, source binding and the
  // canonical API dispatch/normalization path remain real.
  const storage: AcpReplayHistorySessionClient = {
    async enqueueAgentMessageCommitted(provider, body, opts) {
      const prepared = prepareAcpTranscriptDispatch({
        ...maps, provider, body, localId: opts.localId, meta: opts.meta,
        source: opts.toolNormalizationSource,
      });
      rows.set(prepared.localId, prepared.normalizedBody);
      return { persisted: true, delivered: false };
    },
    async enqueueUserTextMessageCommitted() { return { persisted: true, delivered: false }; },
    updateMetadata() {},
    async fetchRecentTranscriptTextItemsForAcpImport() { return []; },
  };
  const session = bindAcpReplaySessionToolSource({ session: storage, source });
  const input = {
    session, provider: 'uninstalled-envelope-label', remoteSessionId: 'remote-1',
    replay: [
      { type: 'tool_call', toolCallId: 'tool-1', kind: 'Bash', rawInput: { command: 'echo selected' } },
      { type: 'tool_result', toolCallId: 'tool-1', status: 'success', rawOutput: { stdout: 'selected' } },
    ],
  };
  const importReplay = () => kind === 'history'
    ? importAcpReplayHistoryV1({ ...input, permissionHandler: {
      async handleToolCall() { throw new Error('Tool-only replay has no divergence'); },
    } })
    : importAcpReplaySidechainV1({ ...input, sidechainId: 'parent-tool' });

  await importReplay();
  const ids = [...rows.keys()];
  await importReplay();

  expect([...rows.keys()]).toEqual(ids);
  expect([...rows.values()]).toEqual([
    expect.objectContaining({ type: 'tool-call', input: expect.objectContaining({
      _happier: expect.objectContaining({ v: 3, ...source, canonicalToolName: 'Bash' }),
    }) }),
    expect.objectContaining({ type: 'tool-result', output: expect.objectContaining({
      _happier: expect.objectContaining({ v: 3, ...source, canonicalToolName: 'Bash' }),
    }) }),
  ]);
});
