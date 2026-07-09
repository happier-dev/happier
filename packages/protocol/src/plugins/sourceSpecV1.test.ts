import { describe, expect, it } from 'vitest';

import { PluginSourceSpecV1Schema } from './sourceSpecV1.js';

describe('plugin source spec v1', () => {
  it('accepts host-derived bundled first-party plugin sources as protocol-visible provenance', () => {
    const parsed = PluginSourceSpecV1Schema.parse({
      kind: 'bundled',
      locator: '@happier-dev/plugins-codex',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: '0.0.0',
      resolvedDigest: 'bundled:@happier-dev/plugins-codex@0.0.0',
    });

    expect(parsed.kind).toBe('bundled');
  });
});
