import { describe, expect, it } from 'vitest';

import {
  ComposerSurfaceInputV1Schema,
  PluginUiHostApiSurfaceContextV1Schema,
  PluginUiJsonValueV1Schema,
} from './client.js';

describe('plugin UI browser-safe client exports', () => {
  it('publishes the canonical bounded JSON-value schema for host-wire payloads', () => {
    expect(PluginUiJsonValueV1Schema.safeParse({ nested: ['value', null] }).success).toBe(true);
    expect(PluginUiJsonValueV1Schema.safeParse(undefined).success).toBe(false);
  });

  it('publishes the one rich surface-context schema required by browser clients', () => {
    expect(PluginUiHostApiSurfaceContextV1Schema).toBeDefined();
  });

  it('publishes the closed Composer mount carrier without a root Protocol import', () => {
    expect(ComposerSurfaceInputV1Schema.parse({
      v: 1,
      role: 'region',
      composer: { kind: 'session', sessionId: 'session-1' },
      regionLocalId: 'assistant-context',
    })).toMatchObject({ role: 'region', composer: { kind: 'session', sessionId: 'session-1' } });
  });
});
