import { describe, expect, it } from 'vitest';

import { BackendSurfaceOperationCatalogV1 } from '@happier-dev/plugin-sdk/manifest';

import * as pluginModule from './index.js';
import { PLUGIN_MANIFEST } from './manifest.js';

function getCodexBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'codex');
  if (!backend) {
    throw new Error('Expected Codex plugin manifest to declare codex backend contribution');
  }
  return backend;
}

describe('Codex B.5 surface declarations', () => {
  it('declares daemon-exported surface handlers only when the bundled plugin entrypoint exports them', () => {
    const backend = getCodexBackend();
    const handlers = backend.surfaceHandlers ?? [];
    const engineOwnedOperations = new Set([
      `fork:${BackendSurfaceOperationCatalogV1.fork.fork}`,
    ]);

    for (const handler of handlers) {
      if (engineOwnedOperations.has(`${handler.kind}:${handler.operation}`)) continue;
      const exportName = handler.handler.exportName;
      if (!exportName) continue;

      expect(pluginModule).toHaveProperty(exportName);
      expect((pluginModule as Record<string, unknown>)[exportName]).toEqual(expect.any(Function));
    }
  });

  it('declares plugin-owned handoff and engine-owned external-session handlers', () => {
    const backend = getCodexBackend();
    const handlers = backend.surfaceHandlers ?? [];

    expect(handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'handoff',
        operation: 'exportBundle',
        handler: expect.objectContaining({
          target: 'daemon',
          exportName: 'exportCodexSessionBundle',
        }),
      }),
      expect.objectContaining({
        kind: 'handoff',
        operation: 'importBundle',
        handler: expect.objectContaining({
          target: 'daemon',
          exportName: 'importCodexSessionBundle',
        }),
      }),
    ]));
    expect(handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'externalSession',
        operation: BackendSurfaceOperationCatalogV1.externalSession.resolveSource,
      }),
      expect.objectContaining({
        kind: 'externalSession',
        operation: BackendSurfaceOperationCatalogV1.externalSession.listCandidates,
      }),
      expect.objectContaining({
        kind: 'externalSession',
        operation: BackendSurfaceOperationCatalogV1.externalSession.pageTranscript,
      }),
      expect.objectContaining({
        kind: 'externalSession',
        operation: BackendSurfaceOperationCatalogV1.externalSession.readAfterTranscript,
      }),
      expect.objectContaining({
        kind: 'externalSession',
        operation: BackendSurfaceOperationCatalogV1.externalSession.resolveFollowTranscriptPath,
      }),
      expect.objectContaining({
        kind: 'externalSession',
        operation: BackendSurfaceOperationCatalogV1.externalSession.acquireFollowLease,
      }),
      expect.objectContaining({
        kind: 'externalSession',
        operation: BackendSurfaceOperationCatalogV1.externalSession.resolveLinkIdentity,
      }),
      expect.objectContaining({
        kind: 'externalSession',
        operation: BackendSurfaceOperationCatalogV1.externalSession.resolveLinkedIdentity,
      }),
      expect.objectContaining({
        kind: 'externalSession',
        operation: BackendSurfaceOperationCatalogV1.externalSession.resolveTakeoverLaunch,
      }),
    ]));
  });

  it('declares Codex fork through the plugin engine surface only', () => {
    const backend = getCodexBackend();
    const handlers = backend.surfaceHandlers ?? [];

    expect(handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'fork',
        operation: BackendSurfaceOperationCatalogV1.fork.fork,
      }),
    ]));
  });

  it('declares Codex terminal launch through the plugin engine surface', () => {
    const backend = getCodexBackend();
    const handlers = backend.surfaceHandlers ?? [];

    expect(handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'terminalRuntime',
        operation: BackendSurfaceOperationCatalogV1.terminalRuntime.launch,
        handler: expect.objectContaining({
          target: 'daemon',
        }),
      }),
    ]));
  });

  it('declares the Codex external-session source schema and source-key rules in the backend manifest surface', () => {
    expect(getCodexBackend().surfaces?.externalSession?.sources).toEqual([
      {
        sourceKind: 'codexHome',
        schema: {
          passthrough: true,
          fields: [
            { name: 'kind', kind: 'literal', value: 'codexHome' },
            { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
            { name: 'homePath', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceId', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceProfileId', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceGroupId', kind: 'string', min: 1, optional: true },
          ],
          refinements: [
            {
              kind: 'requiresWhenEquals',
              field: 'connectedServiceId',
              when: { field: 'home', equals: 'connectedService' },
            },
            {
              kind: 'forbidsWhenEquals',
              fields: ['connectedServiceId', 'connectedServiceProfileId', 'connectedServiceGroupId'],
              when: { field: 'home', equals: 'user' },
            },
          ],
        },
        key: {
          segments: [
            { kind: 'literal', value: 'codexHome' },
            { kind: 'homeMode', field: 'home' },
            {
              kind: 'conditionalField',
              field: 'connectedServiceId',
              when: { field: 'home', equals: 'connectedService' },
            },
            {
              kind: 'connectedServiceScope',
              groupField: 'connectedServiceGroupId',
              profileField: 'connectedServiceProfileId',
              when: { field: 'home', equals: 'connectedService' },
            },
            { kind: 'field', field: 'homePath' },
          ],
        },
      },
    ]);
  });
});
