import { describe, expect, it } from 'vitest';

import { PluginUiArtifactRevocationV1Schema } from './artifactRevocation.js';

describe('plugin UI artifact revocations', () => {
  it('uses the same sha256 digest contract for digest-scoped revocations as artifact integrity', () => {
    expect(PluginUiArtifactRevocationV1Schema.safeParse({
      id: 'revoke-bundle',
      scope: { kind: 'digest', digest: 'sha256:bundle' },
      reason: 'compromised',
      revokedAt: '2026-06-09T19:00:00.000Z',
    }).success).toBe(true);

    expect(PluginUiArtifactRevocationV1Schema.safeParse({
      id: 'revoke-bundle',
      scope: { kind: 'digest', digest: 'bundle' },
      reason: 'compromised',
      revokedAt: '2026-06-09T19:00:00.000Z',
    }).success).toBe(false);
  });
});
