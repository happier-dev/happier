import { describe, expect, it } from 'vitest';

import { ComposerContentHandleV1Schema } from './composerContentV1.js';

describe('composer content V1', () => {
  it('loads and validates a target-bound staged-content handle at its leaf boundary', () => {
    const handle = {
      v: 1,
      id: 'stage-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      owner: { pluginId: 'acme.media', localId: 'image' },
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'hero.png',
      sizeBytes: 42,
      sha256: 'a'.repeat(64),
    } as const;

    expect(ComposerContentHandleV1Schema.safeParse(handle).success).toBe(true);
    expect(ComposerContentHandleV1Schema.safeParse({
      ...handle,
      executionTarget: { ...handle.executionTarget, hostName: 'untrusted' },
    }).success).toBe(false);
  });
});
