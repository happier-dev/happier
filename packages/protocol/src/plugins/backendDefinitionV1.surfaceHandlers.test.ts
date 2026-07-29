import { describe, expect, it } from 'vitest';

import { PluginBackendDefinitionV1Schema } from './backendDefinitionV1';

describe('PluginBackendDefinitionV1Schema surfaceHandlers', () => {
  it('rejects manifest-declared backend surface handlers', () => {
    const result = PluginBackendDefinitionV1Schema.safeParse({
      id: 'acme-agent',
      providerId: 'acme-agent',
      surfaceHandlers: [{
        surfaceApiVersion: 1,
        id: 'backend.terminalRuntime.launch',
        kind: 'terminalRuntime',
        operation: 'launch',
        support: 'supported',
        handler: {
          target: 'daemon',
          exportName: 'launch',
        },
      }],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ['surfaceHandlers'],
      }),
    ]));
  });
});
