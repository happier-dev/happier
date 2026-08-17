import { describe, expect, it } from 'vitest';

import { PluginSourceSpecV1Schema } from './sourceSpecV1.js';

describe('plugin source spec v1', () => {
  it('rejects retired raw resolution digests from source provenance', () => {
    const parsed = PluginSourceSpecV1Schema.safeParse({
      kind: 'bundled',
      locator: '@happier-dev/plugins-codex',
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedVersion: '0.0.0',
      resolvedDigest: 'bundled:@happier-dev/plugins-codex@0.0.0',
    });

    expect(parsed.success).toBe(false);
  });
});
