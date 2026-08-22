import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

const SHA256_HEX_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type PluginUiArtifactDigestV1 = `sha256:${string}`;

function isPluginUiArtifactDigestV1(value: string): value is PluginUiArtifactDigestV1 {
  return SHA256_HEX_DIGEST_PATTERN.test(value);
}

export const PluginUiArtifactDigestV1Schema = z.string().trim().refine(
  isPluginUiArtifactDigestV1,
);

type TypeEqual<Left, Right> = (
  <Value>() => Value extends Left ? 1 : 2
) extends (
  <Value>() => Value extends Right ? 1 : 2
) ? true : false;
type AssertType<Condition extends true> = Condition;
type PluginUiArtifactDigestV1SchemaOutputContract = AssertType<
  TypeEqual<z.output<typeof PluginUiArtifactDigestV1Schema>, PluginUiArtifactDigestV1>
>;

export const PluginUiArtifactIntegrityBindingV1Schema = z.object({
  digest: PluginUiArtifactDigestV1Schema,
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

/**
 * Hermes bytecode files open with the 64-bit magic `0x1F1903C103BC1FC6`,
 * serialized little-endian. Such an artifact is Hermes VM machine code, not
 * loadable JavaScript, so every host boundary that turns artifact bytes into an
 * executable module refuses it here rather than handing it to a JS evaluator.
 *
 * The check is byte-based on purpose: a Re.Pack build with Hermes enabled emits
 * bytecode under whatever entry name the author configured, so an entry-path
 * suffix heuristic misses the realistic case.
 */
const HERMES_BYTECODE_MAGIC_LITTLE_ENDIAN_V1 = Object.freeze([
  0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f,
] as const);

export function isPluginUiHermesBytecodeArtifactV1(bytes: Uint8Array): boolean {
  if (bytes.byteLength < HERMES_BYTECODE_MAGIC_LITTLE_ENDIAN_V1.length) return false;
  return HERMES_BYTECODE_MAGIC_LITTLE_ENDIAN_V1
    .every((byte, index) => bytes[index] === byte);
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
