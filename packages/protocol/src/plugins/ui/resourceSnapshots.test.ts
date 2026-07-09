import { describe, expect, it } from 'vitest';

import { PluginUiResourceRequestV1Schema, PluginUiResourceSnapshotV1Schema } from './resourceSnapshots.js';

describe('plugin UI resource snapshots', () => {
  it('serves only the plugin session resource target vocabulary', () => {
    const request = PluginUiResourceRequestV1Schema.parse({
      resource: { kind: 'pluginState', keyPath: '/review/summary' },
    });

    expect(PluginUiResourceSnapshotV1Schema.parse({
      resource: request.resource,
      state: 'available',
      capturedAtMs: 10,
      payload: { status: 'ready' },
    })).toMatchObject({
      state: 'available',
      payload: { status: 'ready' },
    });

    expect(PluginUiResourceRequestV1Schema.safeParse({
      resource: { kind: 'fullTranscript' },
    }).success).toBe(false);
  });
});
