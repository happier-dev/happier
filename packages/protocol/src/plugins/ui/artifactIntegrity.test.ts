import { utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
  PluginUiArtifactDigestV1Schema,
  verifyPluginUiArtifactFileSetIntegrityV1,
  verifyPluginUiArtifactBytesIntegrityV1,
} from './artifactIntegrity';

describe('plugin UI artifact byte integrity', () => {
  it('accepts only canonical sha256 hex digest identifiers at schema boundaries', () => {
    expect(PluginUiArtifactDigestV1Schema.safeParse(`sha256:${'a'.repeat(64)}`).success).toBe(true);
    expect(PluginUiArtifactDigestV1Schema.safeParse('sha256:bundle').success).toBe(false);
    expect(PluginUiArtifactDigestV1Schema.safeParse(`sha256:${'A'.repeat(64)}`).success).toBe(false);
    expect(PluginUiArtifactDigestV1Schema.safeParse(`sha512:${'a'.repeat(128)}`).success).toBe(false);
  });

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

  it('verifies multi-file artifact roots with path-bound file-set digests', () => {
    const files = [
      { relativePath: 'hosted-web/preview/index.html', bytes: utf8ToBytes('<html></html>') },
      { relativePath: 'hosted-web/preview/assets/index.js', bytes: utf8ToBytes('console.log("preview");') },
    ];
    const digest = computePluginUiArtifactFileSetSha256DigestV1(files);

    expect(verifyPluginUiArtifactFileSetIntegrityV1({
      files: [...files].reverse(),
      integrity: {
        digest,
        pluginId: 'acme.preview',
        contributionId: 'preview-web',
        artifactKind: 'hostedWebAsset',
      },
    })).toEqual({
      ok: true,
      digest,
    });

    expect(verifyPluginUiArtifactFileSetIntegrityV1({
      files: [
        files[0],
        { relativePath: 'hosted-web/preview/assets/renamed.js', bytes: files[1].bytes },
      ],
      integrity: {
        digest,
        pluginId: 'acme.preview',
        contributionId: 'preview-web',
        artifactKind: 'hostedWebAsset',
      },
    })).toMatchObject({
      ok: false,
      reasonCode: 'digest_mismatch',
    });
  });
});
