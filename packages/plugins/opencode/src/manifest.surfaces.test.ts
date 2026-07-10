import { describe, expect, it } from 'vitest';

import { BackendSurfaceOperationCatalogV1 } from '@happier-dev/plugin-sdk/manifest';

import { PLUGIN_MANIFEST } from './manifest.js';

function operationsFor(kind: string): string[] {
  const backend = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'opencode');
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

  it('declares the OpenCode external-session source schema and source-key rules in the backend manifest surface', () => {
    const backend = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'opencode');

    expect(backend?.surfaces?.externalSession?.sources).toEqual([
      {
        sourceKind: 'opencodeServer',
        schema: {
          passthrough: true,
          fields: [
            { name: 'kind', kind: 'literal', value: 'opencodeServer' },
            { name: 'baseUrl', kind: 'unknown', optional: true },
            { name: 'directory', kind: 'unknown', optional: true },
          ],
        },
        key: {
          segments: [
            { kind: 'literal', value: 'opencodeServer' },
            { kind: 'field', field: 'baseUrl' },
            { kind: 'field', field: 'directory' },
          ],
        },
      },
    ]);
  });
});
