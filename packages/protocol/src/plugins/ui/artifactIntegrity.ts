import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

export const PluginUiArtifactDigestV1Schema = z.string().trim().regex(/^sha256:.+$/u);
export type PluginUiArtifactDigestV1 = z.infer<typeof PluginUiArtifactDigestV1Schema>;

export const PluginUiArtifactIntegrityBindingV1Schema = z.object({
  digest: PluginUiArtifactDigestV1Schema,
  signature: z.string().trim().min(1).optional(),
  signingKeyId: z.string().trim().min(1).optional(),
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  artifactKind: z.string().trim().min(1),
}).strict();
export type PluginUiArtifactIntegrityBindingV1 =
  z.infer<typeof PluginUiArtifactIntegrityBindingV1Schema>;

export type VerifyPluginUiArtifactBytesIntegrityV1Result =
  | Readonly<{ ok: true; digest: PluginUiArtifactDigestV1 }>
  | Readonly<{
      ok: false;
      reasonCode: 'digest_mismatch';
      actualDigest: PluginUiArtifactDigestV1;
    }>
  | Readonly<{ ok: false; reasonCode: 'unsupported_digest' }>;

const SHA256_HEX_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function computePluginUiArtifactSha256DigestV1(bytes: Uint8Array): PluginUiArtifactDigestV1 {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

export function verifyPluginUiArtifactBytesIntegrityV1(input: Readonly<{
  bytes: Uint8Array;
  integrity: PluginUiArtifactIntegrityBindingV1;
}>): VerifyPluginUiArtifactBytesIntegrityV1Result {
  const expectedDigest = input.integrity.digest.trim().toLowerCase();
  if (!SHA256_HEX_DIGEST_PATTERN.test(expectedDigest)) {
    return { ok: false, reasonCode: 'unsupported_digest' };
  }

  const actualDigest = computePluginUiArtifactSha256DigestV1(input.bytes);
  if (actualDigest !== expectedDigest) {
    return {
      ok: false,
      reasonCode: 'digest_mismatch',
      actualDigest,
    };
  }

  return {
    ok: true,
    digest: actualDigest,
  };
}
