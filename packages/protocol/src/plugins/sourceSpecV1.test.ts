import { describe, expect, it } from 'vitest';

import {
  isRegistryCustodiedPluginSourceKind,
  PluginSourceKindV1Schema,
  PluginSourceSpecV1Schema,
} from './sourceSpecV1.js';

describe('plugin source provenance', () => {
  it('treats only registry-published artifact kinds as registry-custodied', () => {
    const byKind = Object.fromEntries(
      PluginSourceKindV1Schema.options.map((kind) => [kind, isRegistryCustodiedPluginSourceKind(kind)]),
    );

    expect(byKind).toEqual({
      bundled: false,
      path: false,
      marketplace: true,
      package: true,
      archive: true,
    });
  });
});

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
