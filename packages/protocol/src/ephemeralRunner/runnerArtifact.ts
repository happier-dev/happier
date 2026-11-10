import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/**
 * Immutable Happier Runner artifact identity (Lane 13.5 §2).
 *
 * One Runner is built per release and platform; activation pins the exact
 * product/version/target/digest so neither the Home nor a client can substitute
 * "latest" bytes for an existing activation. This module owns the identity and
 * the target vocabulary only — publication, signing and availability are facts
 * supplied by the release owner and projected by the Home.
 */

export const RUNNER_ARTIFACT_PRODUCT = 'happier-runner' as const;

export const RUNNER_ARTIFACT_TARGETS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
] as const;

export const RunnerArtifactTargetSchema = lazyZodSchema(() => z.enum(RUNNER_ARTIFACT_TARGETS));
export type RunnerArtifactTarget = z.infer<typeof RunnerArtifactTargetSchema>;

export const RunnerArtifactIdentityV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
    product: z.literal(RUNNER_ARTIFACT_PRODUCT),
    version: z.string().check(z.minLength(1)),
    target: RunnerArtifactTargetSchema,
    /** Lowercase hex SHA-256 of the published artifact, as listed in the signed release checksums. */
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  })));
export type RunnerArtifactIdentityV1 = z.infer<typeof RunnerArtifactIdentityV1Schema>;

export const RunnerArtifactArchiveEntryV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  path: z.string().check(z.minLength(1)),
  kind: z.enum(['file', 'directory', 'symlink']),
  sizeBytes: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  mode: z.number().check(z.int(), z.nonnegative(), z.maximum(0o7777)),
  linkTarget: z.optional(z.string().check(z.minLength(1))),
}).check(z.superRefine((entry, context) => {
  if ((entry.kind === 'symlink') !== (entry.linkTarget !== undefined)) {
    context.addIssue({ code: "custom", message: 'linkTarget must be present only for symlinks' });
  }
}))));
export type RunnerArtifactArchiveEntryV1 = z.infer<typeof RunnerArtifactArchiveEntryV1Schema>;

const RunnerArtifactArchiveSizeBytesV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)));
const RunnerArtifactArchiveEntriesV1Schema = lazyZodSchema(() => z.readonly(z.array(RunnerArtifactArchiveEntryV1Schema).check(z.minLength(1))));

const RunnerArtifactArchiveMetadataV1ObjectSchema = lazyZodSchema(() => z.strictObject({
  sizeBytes: RunnerArtifactArchiveSizeBytesV1Schema,
  entries: RunnerArtifactArchiveEntriesV1Schema,
}));

function validateRunnerArtifactArchiveMetadataV1(
  metadata: Readonly<{ entries: readonly Readonly<{ path: string }>[] }>,
  context: z.core.$RefinementCtx,
): void {
  const paths = new Set<string>();
  for (const entry of metadata.entries) {
    const key = entry.path.normalize('NFC').toLowerCase();
    if (paths.has(key)) context.addIssue({ code: "custom", message: 'duplicate archive entry path' });
    paths.add(key);
  }
}

export const RunnerArtifactArchiveMetadataV1Schema = lazyZodSchema(() => z.readonly(RunnerArtifactArchiveMetadataV1ObjectSchema.check(z.superRefine(validateRunnerArtifactArchiveMetadataV1))));
export type RunnerArtifactArchiveMetadataV1 = z.infer<typeof RunnerArtifactArchiveMetadataV1Schema>;

export const VerifiedRunnerArtifactV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  identity: RunnerArtifactIdentityV1Schema,
  channel: z.string().check(z.minLength(1)),
  url: z.string().check(z.url()),
  checksumsUrl: z.string().check(z.url()),
  checksumsSignatureUrl: z.string().check(z.url()),
  ...RunnerArtifactArchiveMetadataV1ObjectSchema.shape,
}).check(z.superRefine(validateRunnerArtifactArchiveMetadataV1))));
export type VerifiedRunnerArtifactV1 = z.infer<typeof VerifiedRunnerArtifactV1Schema>;

export const RunnerArtifactAvailabilityProjectionV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  status: z.literal('available'),
  artifacts: z.readonly(z.array(VerifiedRunnerArtifactV1Schema)),
})));
export type RunnerArtifactAvailabilityProjectionV1 = z.infer<typeof RunnerArtifactAvailabilityProjectionV1Schema>;

/**
 * Does this signed checksums document authenticate exactly this artifact record?
 *
 * The Home and the creating device each verify the same signed document before
 * they trust published bytes, and they used to restate the composite predicate
 * separately with different vocabularies. One owner keeps them from drifting on
 * entry ordering or an added metadata field, and returning a reason is what
 * lets the Home distinguish a declared-but-invalid publication from a target
 * that is positively absent.
 */
export type RunnerArtifactAuthenticationResultV1 =
  | Readonly<{ ok: true; sha256: string; metadata: RunnerArtifactArchiveMetadataV1 }>
  | Readonly<{ ok: false; reason: 'unverified_checksums' | 'digest_mismatch' | 'archive_metadata_mismatch' }>;

export function authenticateRunnerArtifactAgainstSignedChecksumsV1(input: Readonly<{
  verified: Readonly<{
    ok: boolean;
    sha256?: string | null;
    archiveMetadata?: Readonly<{ sizeBytes: number; entries: readonly RunnerArtifactArchiveEntryV1[] }> | null;
  }>;
  expected: Readonly<{
    sha256: string;
    sizeBytes: number;
    entries: readonly RunnerArtifactArchiveEntryV1[];
  }>;
}>): RunnerArtifactAuthenticationResultV1 {
  const verified = input.verified;
  if (!verified.ok || typeof verified.sha256 !== 'string' || verified.sha256.length === 0) {
    return { ok: false, reason: 'unverified_checksums' };
  }
  if (verified.sha256 !== input.expected.sha256) return { ok: false, reason: 'digest_mismatch' };
  const metadata = verified.archiveMetadata;
  if (
    !metadata
    || metadata.sizeBytes !== input.expected.sizeBytes
    || JSON.stringify(metadata.entries) !== JSON.stringify(input.expected.entries)
  ) return { ok: false, reason: 'archive_metadata_mismatch' };
  return { ok: true, sha256: verified.sha256, metadata: { sizeBytes: metadata.sizeBytes, entries: metadata.entries } };
}

/** Release manifest platform vocabulary (`os`/`arch` as published by the release pipeline). */
export type RunnerArtifactPlatform = Readonly<{ os: string; arch: string }>;

const TARGET_PLATFORMS: Readonly<Record<RunnerArtifactTarget, RunnerArtifactPlatform>> = {
  'linux-x64': { os: 'linux', arch: 'x64' },
  'linux-arm64': { os: 'linux', arch: 'arm64' },
  'darwin-x64': { os: 'darwin', arch: 'x64' },
  'darwin-arm64': { os: 'darwin', arch: 'arm64' },
  'windows-x64': { os: 'windows', arch: 'x64' },
};

export function runnerArtifactTargetPlatform(target: RunnerArtifactTarget): RunnerArtifactPlatform {
  return TARGET_PLATFORMS[target];
}

/**
 * Resolve the Runner target for one published release platform. Returns null for
 * any platform the Runner product does not target; callers must not advertise a
 * target the release owner does not publish.
 */
export function runnerArtifactTargetForPlatform(platform: RunnerArtifactPlatform): RunnerArtifactTarget | null {
  for (const target of RUNNER_ARTIFACT_TARGETS) {
    const candidate = TARGET_PLATFORMS[target];
    if (candidate.os === platform.os && candidate.arch === platform.arch) return target;
  }
  return null;
}
