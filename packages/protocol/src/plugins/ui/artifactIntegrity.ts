import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

const SHA256_HEX_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export const PluginUiArtifactDigestV1Schema = z.string().trim().regex(SHA256_HEX_DIGEST_PATTERN);
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

export function computePluginUiArtifactSha256DigestV1(bytes: Uint8Array): PluginUiArtifactDigestV1 {
  return `sha256:${bytesToHex(sha256(bytes))}`;
}

export type PluginUiArtifactFileSetEntryV1 = Readonly<{
  relativePath: string;
  bytes: Uint8Array;
}>;

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function canonicalPluginUiArtifactFileSetBytesV1(
  files: readonly PluginUiArtifactFileSetEntryV1[],
): Uint8Array {
  const chunks: Uint8Array[] = [utf8ToBytes('happier.pluginUi.fileSet.v1\n')];
  const sorted = [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  for (const file of sorted) {
    const relativePath = file.relativePath.trim();
    const pathBytes = utf8ToBytes(relativePath);
    chunks.push(
      utf8ToBytes(`path:${pathBytes.byteLength}\n`),
      pathBytes,
      utf8ToBytes(`\nbytes:${file.bytes.byteLength}\n`),
      file.bytes,
      utf8ToBytes('\n'),
    );
  }
  return concatBytes(chunks);
}

export function computePluginUiArtifactFileSetSha256DigestV1(
  files: readonly PluginUiArtifactFileSetEntryV1[],
): PluginUiArtifactDigestV1 {
  return computePluginUiArtifactSha256DigestV1(canonicalPluginUiArtifactFileSetBytesV1(files));
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

export function verifyPluginUiArtifactFileSetIntegrityV1(input: Readonly<{
  files: readonly PluginUiArtifactFileSetEntryV1[];
  integrity: PluginUiArtifactIntegrityBindingV1;
}>): VerifyPluginUiArtifactBytesIntegrityV1Result {
  const expectedDigest = input.integrity.digest.trim().toLowerCase();
  if (!SHA256_HEX_DIGEST_PATTERN.test(expectedDigest)) {
    return { ok: false, reasonCode: 'unsupported_digest' };
  }

  const actualDigest = computePluginUiArtifactFileSetSha256DigestV1(input.files);
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
