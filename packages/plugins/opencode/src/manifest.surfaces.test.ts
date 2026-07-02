import { describe, expect, it } from 'vitest';

import { BackendSurfaceOperationCatalogV1 } from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from './manifest.js';

function operationsFor(kind: string): string[] {
  const backend = PLUGIN_MANIFEST.contributes.backends.find((entry) => entry.id === 'opencode');
  return (backend?.surfaceHandlers ?? [])
    .filter((handler) => handler.kind === kind && handler.support !== 'unsupported')
    .map((handler) => handler.operation)
    .sort();
}

describe('OpenCode plugin session surface declarations', () => {
  it('declares external-session, handoff, and fork operations through manifest surfaceHandlers', () => {
    const catalog = BackendSurfaceOperationCatalogV1;

    expect(operationsFor('externalSession')).toEqual([
      catalog.externalSession.getActivity,
      catalog.externalSession.listCandidates,
      catalog.externalSession.pageTranscript,
      catalog.externalSession.readAfterTranscript,
      catalog.externalSession.resolveLinkedIdentity,
      catalog.externalSession.resolveLinkIdentity,
      catalog.externalSession.resolveSource,
      catalog.externalSession.resolveTakeoverLaunch,
    ].sort());
    expect(operationsFor('handoff')).toEqual([
      catalog.handoff.exportBundle,
      catalog.handoff.importBundle,
    ].sort());
    expect(operationsFor('fork')).toEqual([
      catalog.fork.resolveReplayChildLaunch,
    ]);
  });
});
