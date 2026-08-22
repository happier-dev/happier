import { utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
  isPluginUiHermesBytecodeArtifactV1,
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

describe('isPluginUiHermesBytecodeArtifactV1', () => {
  it('recognizes the Hermes bytecode magic regardless of the artifact file name', () => {
    const hermes = new Uint8Array([
      0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f,
      0x5b, 0x00, 0x00, 0x00,
    ]);

    expect(isPluginUiHermesBytecodeArtifactV1(hermes)).toBe(true);
  });

  it('accepts plain JavaScript bundles and refuses to guess from a truncated prefix', () => {
    const plainJs = new TextEncoder().encode('export function renderSurface() { return null; }');
    const truncatedMagic = new Uint8Array([0xc6, 0x1f, 0xbc, 0x03]);
    const nearMissMagic = new Uint8Array([
      0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1e,
    ]);

    expect(isPluginUiHermesBytecodeArtifactV1(plainJs)).toBe(false);
    expect(isPluginUiHermesBytecodeArtifactV1(truncatedMagic)).toBe(false);
    expect(isPluginUiHermesBytecodeArtifactV1(nearMissMagic)).toBe(false);
    expect(isPluginUiHermesBytecodeArtifactV1(new Uint8Array())).toBe(false);
  });
});
