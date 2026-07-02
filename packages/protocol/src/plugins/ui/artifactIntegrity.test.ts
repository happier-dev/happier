import { utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';

import {
  computePluginUiArtifactSha256DigestV1,
  verifyPluginUiArtifactBytesIntegrityV1,
} from './artifactIntegrity';

describe('plugin UI artifact byte integrity', () => {
  it('verifies artifact bytes against a real sha256 digest', () => {
    const bytes = utf8ToBytes('bundle bytes');
    const digest = computePluginUiArtifactSha256DigestV1(bytes);

    expect(verifyPluginUiArtifactBytesIntegrityV1({
      bytes,
      integrity: {
        digest,
        pluginId: 'acme.preview',
        contributionId: 'native-preview',
        artifactKind: 'reactNativeBundle',
      },
    })).toEqual({
      ok: true,
      digest,
    });
  });

  it('rejects mismatched or non-verifiable artifact digests', () => {
    const bytes = utf8ToBytes('bundle bytes');

    expect(verifyPluginUiArtifactBytesIntegrityV1({
      bytes,
      integrity: {
        digest: `sha256:${'0'.repeat(64)}`,
        pluginId: 'acme.preview',
        contributionId: 'native-preview',
        artifactKind: 'reactNativeBundle',
      },
    })).toEqual({
      ok: false,
      reasonCode: 'digest_mismatch',
      actualDigest: computePluginUiArtifactSha256DigestV1(bytes),
    });

    expect(verifyPluginUiArtifactBytesIntegrityV1({
      bytes,
      integrity: {
        digest: 'sha256:bundle',
        pluginId: 'acme.preview',
        contributionId: 'native-preview',
        artifactKind: 'reactNativeBundle',
      },
    })).toEqual({
      ok: false,
      reasonCode: 'unsupported_digest',
    });
  });
});
