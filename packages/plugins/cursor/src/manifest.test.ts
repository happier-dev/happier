import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('PLUGIN_MANIFEST', () => {
  it('contributes a session-capable Cursor backend with execution-run opt-out', () => {
    const backend = PLUGIN_MANIFEST.contributes.backends.find((entry) => entry.id === 'cursor');

    expect(PLUGIN_MANIFEST.id).toBe('happier.agent.cursor');
    expect(PLUGIN_MANIFEST.runtime.capabilities).toContain('backends');
    expect(PLUGIN_MANIFEST.capabilities.permissions).toEqual([
      expect.objectContaining({
        capability: 'env',
        scope: 'CURSOR_API_KEY',
      }),
    ]);
    expect(backend).toEqual(expect.objectContaining({
      kindVersion: 1,
      id: 'cursor',
      agentId: 'cursor',
      engine: { kind: 'custom' },
      capabilities: expect.objectContaining({
        executionRun: { supported: false },
        session: expect.objectContaining({
          media: {
            acceptsImageInput: { supported: false },
            emitsSessionMedia: { supported: false },
            nativeImageGeneration: { supported: false },
          },
        }),
      }),
    }));
  });
});
