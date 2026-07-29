import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { PluginIdSchema } from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { PluginStateFileV1Schema, PluginStateRecordSchema } from '../state';
import {
  flushDirectoryDurably as flushDirectoryDurablyDefault,
  flushFileDurably,
} from './durability';

import { PluginAccessSelectionSchema } from '../install/accessScopeRegistry';
import {
  PluginDistributionIdentitySchema,
  PluginTrustRecordSchema,
  PluginUpdatePolicySchema,
  isPluginTrustRecordAuthorized,
  pluginDistributionIdentitiesEqual,
  pluginDistributionRollbackLineagesEqual,
} from '../install/trustIdentity';
import type { PluginStorePaths } from '../paths';
import {
  AlgorithmQualifiedDigestSchema,
  PortableRelativePathSchema,
  PortableStorageIdSchema,
  PluginRegistryCommitRecordSchema,
  PluginRegistryGenerationReferenceSchema,
  readPluginRegistryCommitRecord,
  type PluginRegistryCommitRecord,
  type PluginRegistryGenerationReference,
} from './commitRecord';
import { PluginGenerationHealthRecordSchema } from './healthPolicy';

const GenerationFileSchema = z.object({
  relativePath: PortableRelativePathSchema,
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  digest: AlgorithmQualifiedDigestSchema,
}).strict();

// The official packed plugin SDK currently brings a measured 6,356-file
// runtime closure. Keep conservative power-of-two headroom while preserving a
// hard inventory bound and the independent 512 MiB byte ceiling.
export const MAXIMUM_IMMUTABLE_GENERATION_FILES = 16_384;

const RetiredPluginGenerationTombstoneSchema = z.object({
  t: z.literal('happier_retired_plugin_generation_v1'),
  schemaVersion: z.literal(1),
  pluginId: PluginIdSchema,
  immutableGenerationId: PortableStorageIdSchema,
}).strict();

export const ImmutablePluginGenerationRecordSchema = z.object({
  t: z.literal('happier_plugin_generation_v1'),
  schemaVersion: z.literal(1),
  pluginId: PluginIdSchema,
  immutableGenerationId: PortableStorageIdSchema,
  fingerprint: AlgorithmQualifiedDigestSchema,
  packageDigest: AlgorithmQualifiedDigestSchema,
  manifestDigest: AlgorithmQualifiedDigestSchema,
  runtimeDigest: AlgorithmQualifiedDigestSchema,
  installedUiArtifactDigest: AlgorithmQualifiedDigestSchema,
  createdAtMs: z.number().int().nonnegative(),
  files: z.array(GenerationFileSchema).max(MAXIMUM_IMMUTABLE_GENERATION_FILES),
  installedArtifactRecord: z.object({ relativePath: PortableRelativePathSchema, digest: AlgorithmQualifiedDigestSchema }).strict(),
}).strict().superRefine((record, context) => {
  const paths = record.files.map((file) => file.relativePath);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Generation file inventory must be unique and sorted' });
  }
  const artifact = record.files.find((file) => file.relativePath === record.installedArtifactRecord.relativePath);
  if (!artifact || artifact.digest !== record.installedArtifactRecord.digest) {
    context.addIssue({ code: 'custom', path: ['installedArtifactRecord'], message: 'Installed artifact must identify verified generation bytes' });
  }
});
export type ImmutablePluginGenerationRecord = z.infer<typeof ImmutablePluginGenerationRecordSchema>;

export const PluginRollbackRetentionRecordSchema = z.object({
  pluginId: PluginIdSchema,
  immutableGenerationId: PortableStorageIdSchema,
  healthGenerationId: PortableStorageIdSchema,
  role: z.enum(['lastKnownGood', 'userRollback', 'quarantined']),
  automaticRecoveryEligible: z.boolean(),
  retainedAtMs: z.number().int().nonnegative(),
  byteAvailability: z.enum(['available', 'missing', 'corrupt', 'evicted', 'sourceIneligible']),
  packageDigest: AlgorithmQualifiedDigestSchema,
  artifactDigest: AlgorithmQualifiedDigestSchema,
  pluginVersion: z.string().min(1).max(256),
  distribution: PluginDistributionIdentitySchema,
}).strict().superRefine((record, context) => {
  if (record.automaticRecoveryEligible && (record.role !== 'lastKnownGood' || record.byteAvailability !== 'available')) {
    context.addIssue({ code: 'custom', path: ['automaticRecoveryEligible'], message: 'Only available LKG bytes are automatic-recovery eligible' });
  }
});
export type PluginRollbackRetentionRecord = z.infer<typeof PluginRollbackRetentionRecordSchema>;

const PluginInstallationStateRecordSchema = z.object({
  enabled: z.boolean(),
  trust: PluginTrustRecordSchema.optional(),
  source: z.object({
    distribution: PluginDistributionIdentitySchema,
    admittedIntegrity: AlgorithmQualifiedDigestSchema,
  }).strict(),
  updatePolicy: PluginUpdatePolicySchema,
  optionalAccess: z.array(PluginAccessSelectionSchema).max(512),
}).strict();
export type PluginInstallationStateRecord = z.infer<typeof PluginInstallationStateRecordSchema>;

const HealthTombstoneSchema = z.object({
  pluginId: PluginIdSchema,
  fingerprint: AlgorithmQualifiedDigestSchema,
  state: z.enum(['quarantined', 'consumed']),
  recordedAtMs: z.number().int().nonnegative(),
}).strict();

export const PluginInstallationStateRevisionSchema = z.object({
  t: z.literal('happier_plugin_installations_v1'),
  schemaVersion: z.literal(1),
  revisionId: PortableStorageIdSchema,
  createdAtMs: z.number().int().nonnegative(),
  plugins: z.record(PluginIdSchema, PluginInstallationStateRecordSchema),
  health: z.record(PortableStorageIdSchema, PluginGenerationHealthRecordSchema),
  rollbackRetention: z.array(PluginRollbackRetentionRecordSchema),
  healthTombstones: z.array(HealthTombstoneSchema),
  runtimeCatalog: PluginStateFileV1Schema.optional(),
  retainedRuntimeCatalog: z.record(PortableStorageIdSchema, PluginStateRecordSchema).optional(),
}).strict().superRefine((state, context) => {
  const priorRetentionCount = new Map<string, number>();
  const quarantinedRetentionCount = new Map<string, number>();
  const retainedGenerationIds = new Set<string>();
  for (const [pluginId, plugin] of Object.entries(state.plugins)) {
    if (
      plugin.trust
      && (
        plugin.trust.pluginId !== pluginId
        || JSON.stringify(plugin.trust.distribution) !== JSON.stringify(plugin.source.distribution)
      )
    ) {
      context.addIssue({ code: 'custom', path: ['plugins', pluginId], message: 'Installation trust/source identity mismatch' });
    }
    for (const [index, selection] of plugin.optionalAccess.entries()) {
      if (selection.pluginId !== pluginId) context.addIssue({ code: 'custom', path: ['plugins', pluginId, 'optionalAccess', index], message: 'Optional selection plugin mismatch' });
    }
  }
  if (state.runtimeCatalog) {
    const installationIds = Object.keys(state.plugins).sort();
    const catalogIds = Object.keys(state.runtimeCatalog.plugins).sort();
    if (
      installationIds.length !== catalogIds.length
      || installationIds.some((pluginId, index) => pluginId !== catalogIds[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['runtimeCatalog', 'plugins'],
        message: 'Runtime catalog identities must exactly match canonical installation identities',
      });
    }
    for (const pluginId of installationIds) {
      const installation = state.plugins[pluginId];
      const catalog = state.runtimeCatalog.plugins[pluginId];
      if (installation && catalog && installation.enabled !== catalog.state.enabled) {
        context.addIssue({
          code: 'custom',
          path: ['runtimeCatalog', 'plugins', pluginId, 'state', 'enabled'],
          message: 'Runtime catalog enabled state must match canonical installation state',
        });
      }
    }
  }
  if (state.retainedRuntimeCatalog) {
    const retainedIds = new Set(state.rollbackRetention.map((retention) => retention.immutableGenerationId));
    for (const generationId of Object.keys(state.retainedRuntimeCatalog)) {
      if (!retainedIds.has(generationId)) {
        context.addIssue({
          code: 'custom',
          path: ['retainedRuntimeCatalog', generationId],
          message: 'Retained runtime catalog entry must name a rollback-retained generation',
        });
      }
    }
  }
  for (const [generationId, health] of Object.entries(state.health)) {
    if (health.immutableGenerationId !== generationId) context.addIssue({ code: 'custom', path: ['health', generationId], message: 'Health generation identity mismatch' });
  }
  for (const [index, retention] of state.rollbackRetention.entries()) {
    if (retainedGenerationIds.has(retention.immutableGenerationId)) {
      context.addIssue({ code: 'custom', path: ['rollbackRetention', index], message: 'A generation may have only one rollback retention role' });
    }
    retainedGenerationIds.add(retention.immutableGenerationId);
    const counts = retention.role === 'quarantined' ? quarantinedRetentionCount : priorRetentionCount;
    const count = (counts.get(retention.pluginId) ?? 0) + 1;
    counts.set(retention.pluginId, count);
    if (count > 1) {
      context.addIssue({
        code: 'custom',
        path: ['rollbackRetention', index],
        message: retention.role === 'quarantined'
          ? 'Bounded rollback retention permits at most one quarantined generation per plugin'
          : 'Bounded rollback retention permits at most one prior generation per plugin',
      });
    }
    const health = state.health[retention.healthGenerationId];
    if (!health || health.pluginId !== retention.pluginId || health.immutableGenerationId !== retention.immutableGenerationId) {
      context.addIssue({ code: 'custom', path: ['rollbackRetention', index], message: 'Retention must reference matching generation health' });
    }
    const plugin = state.plugins[retention.pluginId];
    if (!plugin || !pluginDistributionRollbackLineagesEqual(plugin.source.distribution, retention.distribution)) {
      context.addIssue({ code: 'custom', path: ['rollbackRetention', index], message: 'Retention source identity must match the current installation' });
    }
  }
});
export type PluginInstallationStateRevision = z.infer<typeof PluginInstallationStateRevisionSchema>;

type PluginExecutionAuthority = Readonly<{
  pluginGenerations: PluginRegistryCommitRecord['pluginGenerations'];
  plugins: PluginInstallationStateRevision['plugins'];
  runtimeCatalog?: PluginInstallationStateRevision['runtimeCatalog'];
}>;

function pluginExecutionAuthority(
  commit: PluginRegistryCommitRecord,
  state: PluginInstallationStateRevision,
): PluginExecutionAuthority {
  return {
    pluginGenerations: commit.pluginGenerations,
    plugins: state.plugins,
    runtimeCatalog: state.runtimeCatalog,
  };
}

export type InstallationStateRevisionReference = Readonly<{ revisionId: string; digest: string }>;

export function computePluginGenerationFileDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const digestBytes = computePluginGenerationFileDigest;

function digestJson(value: unknown): `sha256:${string}` {
  return digestBytes(Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

function retiredGenerationTombstonePath(paths: PluginStorePaths, immutableGenerationId: string): string {
  return join(paths.generationsDir, `.retired-${immutableGenerationId}.v1.json`);
}

const processLocalPreparedGenerationReferences = new Map<string, number>();

function processLocalPreparedGenerationKey(
  paths: PluginStorePaths,
  immutableGenerationId: string,
): string {
  return join(paths.generationsDir, immutableGenerationId);
}

export function retainProcessLocalPreparedPluginGeneration(
  paths: PluginStorePaths,
  immutableGenerationId: string,
): Readonly<{ release(): void }> {
  const key = processLocalPreparedGenerationKey(paths, immutableGenerationId);
  processLocalPreparedGenerationReferences.set(
    key,
    (processLocalPreparedGenerationReferences.get(key) ?? 0) + 1,
  );
  let retained = true;
  return Object.freeze({
    release() {
      if (!retained) return;
      retained = false;
      const remaining = (processLocalPreparedGenerationReferences.get(key) ?? 1) - 1;
      if (remaining > 0) processLocalPreparedGenerationReferences.set(key, remaining);
      else processLocalPreparedGenerationReferences.delete(key);
    },
  });
}

function isProcessLocalPreparedPluginGeneration(
  paths: PluginStorePaths,
  immutableGenerationId: string,
): boolean {
  return processLocalPreparedGenerationReferences.has(
    processLocalPreparedGenerationKey(paths, immutableGenerationId),
  );
}

async function assertGenerationNotRetired(paths: PluginStorePaths, immutableGenerationId: string): Promise<void> {
  for (const path of [
    join(paths.generationsDir, `.retiring-${immutableGenerationId}`),
    retiredGenerationTombstonePath(paths, immutableGenerationId),
  ]) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`Immutable generation '${immutableGenerationId}' is already retired or staged for retirement`);
  }
}

async function persistRetiredGenerationTombstone(input: Readonly<{
  paths: PluginStorePaths;
  record: ImmutablePluginGenerationRecord;
  flushDirectoryDurably: (path: string) => Promise<void>;
}>): Promise<void> {
  const path = retiredGenerationTombstonePath(input.paths, input.record.immutableGenerationId);
  const expected = RetiredPluginGenerationTombstoneSchema.parse({
    t: 'happier_retired_plugin_generation_v1',
    schemaVersion: 1,
    pluginId: input.record.pluginId,
    immutableGenerationId: input.record.immutableGenerationId,
  });
  try {
    const existing = RetiredPluginGenerationTombstoneSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (JSON.stringify(existing) !== JSON.stringify(expected)) {
      throw new Error(`Retired generation tombstone identity mismatch for '${input.record.immutableGenerationId}'`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    await writeJsonAtomic(path, expected);
  }
  await flushFileDurably(path);
  await input.flushDirectoryDurably(input.paths.generationsDir);
}

export function computePluginGenerationFingerprint(input: Readonly<{
  pluginId: string;
  distribution: z.input<typeof PluginDistributionIdentitySchema>;
  updatePolicy: z.input<typeof PluginUpdatePolicySchema>;
  normalizedManifestDigest: string;
  packageDigest: string;
  runtimeDigest: string;
  installedUiArtifactDigest: string;
}>): `sha256:${string}` {
  const facts = {
    pluginId: PluginIdSchema.parse(input.pluginId),
    distribution: PluginDistributionIdentitySchema.parse(input.distribution),
    updatePolicy: PluginUpdatePolicySchema.parse(input.updatePolicy),
    normalizedManifestDigest: AlgorithmQualifiedDigestSchema.parse(input.normalizedManifestDigest),
    packageDigest: AlgorithmQualifiedDigestSchema.parse(input.packageDigest),
    runtimeDigest: AlgorithmQualifiedDigestSchema.parse(input.runtimeDigest),
    installedUiArtifactDigest: AlgorithmQualifiedDigestSchema.parse(input.installedUiArtifactDigest),
  };
  return digestBytes(Buffer.from(`happier.plugin-generation-fingerprint.v1\n${JSON.stringify(facts)}`, 'utf8'));
}

export async function createImmutablePluginGenerationRecordFromSource(input: Readonly<{
  pluginId: string;
  sourceRootPath: string;
  manifestRelativePath: string;
  distribution: z.input<typeof PluginDistributionIdentitySchema>;
  updatePolicy: z.input<typeof PluginUpdatePolicySchema>;
  createdAtMs: number;
  immutableGenerationId?: string;
}>): Promise<ImmutablePluginGenerationRecord> {
  const rootPath = await realpath(input.sourceRootPath);
  const manifestRelativePath = PortableRelativePathSchema.parse(input.manifestRelativePath.split(sep).join('/'));
  const files: Array<{ relativePath: string; byteLength: number; digest: `sha256:${string}` }> = [];
  const pending = [''];
  let totalBytes = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!;
    const directoryPath = relativeDirectory
      ? join(rootPath, ...relativeDirectory.split('/'))
      : rootPath;
    const entries = await readdir(directoryPath, { withFileTypes: true, encoding: 'utf8' });
    for (const entry of entries) {
      const relativePath = PortableRelativePathSchema.parse(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      const absolutePath = join(directoryPath, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Immutable plugin generation source contains a symbolic link: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Immutable plugin generation source contains a non-file entry: ${relativePath}`);
      }
      const bytes = await readFile(absolutePath);
      totalBytes += bytes.byteLength;
      if (files.length >= MAXIMUM_IMMUTABLE_GENERATION_FILES || totalBytes > 512 * 1024 * 1024) {
        throw new Error('Immutable plugin generation source exceeds its bounded inventory');
      }
      files.push({ relativePath, byteLength: bytes.byteLength, digest: digestBytes(bytes) });
    }
  }
  files.sort((left, right) => (
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  ));
  const installedArtifact = files.find((file) => file.relativePath === manifestRelativePath);
  if (!installedArtifact) throw new Error('Immutable plugin generation manifest is absent from the source inventory');
  const packageDigest = digestJson(files);
  const manifestDigest = installedArtifact.digest;
  // Until runtime/UI subgraphs gain independent packed records, the verified
  // whole-package digest is the conservative identity for both byte sets.
  const runtimeDigest = packageDigest;
  const installedUiArtifactDigest = packageDigest;
  const fingerprint = computePluginGenerationFingerprint({
    pluginId: input.pluginId,
    distribution: input.distribution,
    updatePolicy: input.updatePolicy,
    normalizedManifestDigest: manifestDigest,
    packageDigest,
    runtimeDigest,
    installedUiArtifactDigest,
  });
  return ImmutablePluginGenerationRecordSchema.parse({
    t: 'happier_plugin_generation_v1',
    schemaVersion: 1,
    pluginId: input.pluginId,
    immutableGenerationId: input.immutableGenerationId ?? `gen-${input.createdAtMs}-${randomUUID()}`,
    fingerprint,
    packageDigest,
    manifestDigest,
    runtimeDigest,
    installedUiArtifactDigest,
    createdAtMs: input.createdAtMs,
    files,
    installedArtifactRecord: {
      relativePath: installedArtifact.relativePath,
      digest: installedArtifact.digest,
    },
  });
}

async function verifyFile(path: string, expected: Readonly<{ byteLength: number; digest: string }>): Promise<void> {
  const bytes = await readFile(path);
  if (bytes.byteLength !== expected.byteLength) throw new Error(`Generation byte length mismatch for ${path}`);
  if (digestBytes(bytes) !== expected.digest) throw new Error(`Generation digest mismatch for ${path}`);
}

async function readGenerationRecord(path: string): Promise<ImmutablePluginGenerationRecord> {
  const parsed = ImmutablePluginGenerationRecordSchema.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  if (!parsed.success) throw new Error('Invalid immutable plugin generation record', { cause: parsed.error });
  return parsed.data;
}

async function verifyGenerationRootFiles(
  root: string,
  record: ImmutablePluginGenerationRecord,
  options?: Readonly<{ allowGenerationRecord?: boolean }>,
): Promise<void> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Immutable plugin generation root must be a real directory, not a symbolic link');
  }

  const expectedFiles = new Map(record.files.map((file) => [file.relativePath, file]));
  const expectedDirectories = new Set<string>();
  for (const relativePath of expectedFiles.keys()) {
    const segments = relativePath.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      expectedDirectories.add(segments.slice(0, length).join('/'));
    }
  }
  const seenFiles = new Set<string>();
  const pendingDirectories = [''];
  while (pendingDirectories.length > 0) {
    const relativeDirectory = pendingDirectories.pop()!;
    const directoryPath = relativeDirectory
      ? join(root, ...relativeDirectory.split('/'))
      : root;
    const entries = await readdir(directoryPath, { withFileTypes: true, encoding: 'utf8' });
    for (const entry of entries) {
      const relativePath = PortableRelativePathSchema.parse(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      const path = join(directoryPath, entry.name);
      const metadata = await lstat(path);
      const expectedFile = expectedFiles.get(relativePath);
      if (expectedFile) {
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error(`Immutable plugin generation file must be a real file, not a symbolic link: ${relativePath}`);
        }
        await verifyFile(path, expectedFile);
        seenFiles.add(relativePath);
        continue;
      }
      if (expectedDirectories.has(relativePath)) {
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(`Immutable plugin generation path ancestor must be a real directory, not a symbolic link: ${relativePath}`);
        }
        pendingDirectories.push(relativePath);
        continue;
      }
      if (
        options?.allowGenerationRecord === true
        && relativeDirectory === ''
        && relativePath === 'plugin-generation.v1.json'
        && !metadata.isSymbolicLink()
        && metadata.isFile()
      ) {
        continue;
      }
      throw new Error(`Immutable plugin generation contains an unexpected inventory entry: ${relativePath}`);
    }
  }
  if (seenFiles.size !== expectedFiles.size) {
    const missing = [...expectedFiles.keys()].find((relativePath) => !seenFiles.has(relativePath));
    throw new Error(`Immutable plugin generation inventory is missing: ${missing ?? 'unknown file'}`);
  }
}

async function verifyPersistedGeneration(root: string, expected: ImmutablePluginGenerationRecord): Promise<void> {
  await verifyGenerationRootFiles(root, expected, { allowGenerationRecord: true });
  const recordPath = join(root, 'plugin-generation.v1.json');
  const recordStat = await lstat(recordPath);
  if (recordStat.isSymbolicLink() || !recordStat.isFile()) {
    throw new Error('Immutable plugin generation record must be a real file, not a symbolic link');
  }
  const record = await readGenerationRecord(recordPath);
  if (JSON.stringify(record) !== JSON.stringify(expected)) throw new Error('Immutable plugin generation substitution detected');
}

export type CurrentCommittedPluginGeneration = Readonly<{
  pluginId: string;
  immutableGenerationId: string;
  rootPath: string;
  record: ImmutablePluginGenerationRecord;
  installation?: PluginInstallationStateRecord;
}>;

export type RejectedCommittedPluginGeneration = Readonly<{
  pluginId: string;
  immutableGenerationId: string;
  message: string;
}>;

export type BundledImmutablePluginArtifact = Readonly<{
  packageName: string;
  packageEntryRelativePath: string;
  record: ImmutablePluginGenerationRecord;
}>;

async function resolveBundledPackageEntry(packageName: string): Promise<string> {
  return createRequire(import.meta.url).resolve(packageName);
}

async function admitBundledImmutablePluginGeneration(input: Readonly<{
  artifact: BundledImmutablePluginArtifact;
  resolvePackageEntry: (packageName: string) => Promise<string>;
}>): Promise<CurrentCommittedPluginGeneration> {
  const artifact = Object.freeze({
    ...input.artifact,
    record: ImmutablePluginGenerationRecordSchema.parse(input.artifact.record),
  });
  const lexicalEntryPath = resolve(await input.resolvePackageEntry(artifact.packageName));
  const entrySegments = artifact.packageEntryRelativePath.split('/');
  let lexicalRootPath = lexicalEntryPath;
  for (let index = 0; index < entrySegments.length; index += 1) lexicalRootPath = dirname(lexicalRootPath);
  await verifyGenerationRootFiles(lexicalRootPath, artifact.record);
  const entryPath = await realpath(lexicalEntryPath);
  const rootPath = await realpath(lexicalRootPath);
  const actualRelativeEntry = relative(rootPath, entryPath);
  if (
    actualRelativeEntry === ''
    || actualRelativeEntry === '..'
    || actualRelativeEntry.startsWith(`..${sep}`)
    || isAbsolute(actualRelativeEntry)
    || actualRelativeEntry.split(sep).join('/') !== artifact.packageEntryRelativePath
  ) {
    throw new Error(`Bundled plugin package entry identity mismatch for '${artifact.record.pluginId}'`);
  }
  if (!artifact.record.files.some((file) => file.relativePath === artifact.packageEntryRelativePath)) {
    throw new Error(`Bundled plugin package entry is absent from immutable inventory for '${artifact.record.pluginId}'`);
  }
  return Object.freeze({
    pluginId: artifact.record.pluginId,
    immutableGenerationId: artifact.record.immutableGenerationId,
    rootPath,
    record: artifact.record,
  });
}

/**
 * Joins the sole durable installed-current record and generated bundled
 * artifact identities to their exact immutable bytes. The installed record is
 * re-read after verification so callers never receive a generation set
 * assembled across a concurrent execution-authority replacement. Health and
 * rollback bookkeeping may advance without making the unchanged serving
 * generation stale. Bundled currentness is the generated identity plus
 * re-verification of that same inventory.
 */
export async function readCurrentCommittedPluginGenerations(
  paths: PluginStorePaths,
  options?: Readonly<{
    bundledArtifacts?: readonly BundledImmutablePluginArtifact[];
    resolveBundledPackageEntry?: (packageName: string) => Promise<string>;
    isolateInvalidInstalledGenerations?: boolean;
  }>,
): Promise<Readonly<{
  commit: PluginRegistryCommitRecord | null;
  generations: ReadonlyMap<string, CurrentCommittedPluginGeneration>;
  rejectedGenerations: ReadonlyMap<string, RejectedCommittedPluginGeneration>;
  unavailableBundledPackageNames: ReadonlySet<string>;
  isCurrent: () => Promise<boolean>;
}> | null> {
  const commit = await readPluginRegistryCommitRecord(paths);
  const bundledArtifacts = options?.bundledArtifacts ?? [];
  if (!commit && bundledArtifacts.length === 0) return null;

  const generations = new Map<string, CurrentCommittedPluginGeneration>();
  const rejectedGenerations = new Map<string, RejectedCommittedPluginGeneration>();
  const installationState = commit
    ? await readInstallationStateRevision({ paths, reference: commit.installationState })
    : null;
  const executionAuthority = commit && installationState
    ? pluginExecutionAuthority(commit, installationState)
    : null;
  const admittedInstalled: CurrentCommittedPluginGeneration[] = [];
  for (const [pluginId, reference] of Object.entries(commit?.pluginGenerations ?? {})) {
    try {
      const generationRootPath = join(paths.generationsDir, reference.immutableGenerationId);
      const record = await readGenerationRecord(join(generationRootPath, 'plugin-generation.v1.json'));
      if (record.pluginId !== pluginId || record.immutableGenerationId !== reference.immutableGenerationId) {
        throw new Error(`Committed plugin generation identity mismatch for '${pluginId}'`);
      }
      if (digestJson(record) !== reference.generationRecordDigest) {
        throw new Error(`Committed plugin generation record digest mismatch for '${pluginId}'`);
      }
      if (JSON.stringify(record.installedArtifactRecord) !== JSON.stringify(reference.installedArtifactRecord)) {
        throw new Error(`Committed plugin generation artifact identity mismatch for '${pluginId}'`);
      }
      const installation = installationState?.plugins[pluginId];
      if (!installation) throw new Error(`Committed plugin generation is missing installation authority for '${pluginId}'`);
      if (installation.source.admittedIntegrity !== record.packageDigest) {
        throw new Error(`Committed plugin generation admitted integrity mismatch for '${pluginId}'`);
      }
      await verifyPersistedGeneration(generationRootPath, record);
      const rootPath = await realpath(generationRootPath);
      const catalogRecord = installationState?.runtimeCatalog?.plugins[pluginId];
      const catalogTrust = catalogRecord?.install.trust;
      if (!installation.trust || (catalogRecord && !catalogTrust)) {
        continue;
      }
      if (catalogTrust && JSON.stringify(installation.trust) !== JSON.stringify(catalogTrust)) {
        throw new Error(`Committed plugin generation catalog trust identity mismatch for '${pluginId}'`);
      }
      if (!isPluginTrustRecordAuthorized(installation.trust, {
        pluginId,
        distribution: installation.source.distribution,
        realm: 'daemon',
      })) {
        throw new Error(`Committed plugin generation trust identity mismatch for '${pluginId}'`);
      }
      const admitted = Object.freeze({
        pluginId,
        immutableGenerationId: record.immutableGenerationId,
        rootPath,
        record,
        installation,
      });
      generations.set(pluginId, admitted);
      admittedInstalled.push(admitted);
    } catch (error) {
      if (!options?.isolateInvalidInstalledGenerations) throw error;
      rejectedGenerations.set(pluginId, Object.freeze({
        pluginId,
        immutableGenerationId: reference.immutableGenerationId,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const admittedBundled: CurrentCommittedPluginGeneration[] = [];
  const unavailableBundledPackageNames = new Set<string>();
  for (const artifact of bundledArtifacts) {
    let admitted: CurrentCommittedPluginGeneration;
    try {
      admitted = await admitBundledImmutablePluginGeneration({
        artifact,
        resolvePackageEntry: options?.resolveBundledPackageEntry ?? resolveBundledPackageEntry,
      });
    } catch {
      unavailableBundledPackageNames.add(artifact.packageName);
      continue;
    }
    if (generations.has(admitted.pluginId)) {
      throw new Error(`Plugin generation authority collision for '${admitted.pluginId}'`);
    }
    generations.set(admitted.pluginId, admitted);
    admittedBundled.push(admitted);
  }

  let after = await readPluginRegistryCommitRecord(paths);
  while (JSON.stringify(after) !== JSON.stringify(commit)) {
    if (!after || !executionAuthority) {
      throw new Error('Plugin registry execution authority changed while resolving immutable generations');
    }
    const afterInstallationState = await readInstallationStateRevision({
      paths,
      reference: after.installationState,
    });
    const confirmedAfter = await readPluginRegistryCommitRecord(paths);
    if (JSON.stringify(confirmedAfter) !== JSON.stringify(after)) {
      after = confirmedAfter;
      continue;
    }
    if (!isDeepStrictEqual(
      pluginExecutionAuthority(after, afterInstallationState),
      executionAuthority,
    )) {
      throw new Error('Plugin registry execution authority changed while resolving immutable generations');
    }
    break;
  }
  return Object.freeze({
    commit,
    generations,
    rejectedGenerations,
    unavailableBundledPackageNames,
    async isCurrent(): Promise<boolean> {
      const current = await readPluginRegistryCommitRecord(paths);
      try {
        if (commit && installationState) {
          if (!current) return false;
          const currentInstallationState = await readInstallationStateRevision({
            paths,
            reference: current.installationState,
          });
          if (!isDeepStrictEqual(
            pluginExecutionAuthority(current, currentInstallationState),
            executionAuthority,
          )) return false;
        } else if (current) {
          return false;
        }
        await Promise.all([
          ...admittedInstalled.map((generation) => (
            verifyPersistedGeneration(generation.rootPath, generation.record)
          )),
          ...admittedBundled.map((generation) => (
            verifyGenerationRootFiles(generation.rootPath, generation.record)
          )),
        ]);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/** Verifies desired-current immutable generations referenced by a candidate commit.
 * Rollback retention is optional fallback custody and is re-verified when selected;
 * corrupt retained bytes must not make the desired-current registry unreadable. */
export async function readPluginRegistryCommitInstallationAuthority(
  paths: PluginStorePaths,
  commit: PluginRegistryCommitRecord,
): Promise<PluginInstallationStateRevision | null> {
  const parsed = PluginRegistryCommitRecordSchema.parse(commit);
  const isEmptyBootstrap = parsed.revision === 0
    && parsed.baseRevision === null
    && Object.keys(parsed.pluginGenerations).length === 0
    && parsed.installationState.revisionId === 'state-0'
    && parsed.installationState.digest === `sha256:${'0'.repeat(64)}`;
  const state = isEmptyBootstrap
    ? null
    : await readInstallationStateRevision({ paths, reference: parsed.installationState });
  for (const pluginId of Object.keys(parsed.pluginGenerations)) {
    if (!state?.plugins[pluginId]) {
      throw new Error(`Plugin registry generation map references '${pluginId}' without a canonical installation`);
    }
  }
  const currentGenerationIds = new Set(
    Object.values(parsed.pluginGenerations).map((reference) => reference.immutableGenerationId),
  );
  for (const retention of state?.rollbackRetention ?? []) {
    if (currentGenerationIds.has(retention.immutableGenerationId)) {
      throw new Error(`Current generation '${retention.immutableGenerationId}' cannot also be rollback-retained`);
    }
  }
  return state;
}

export async function verifyPluginRegistryCommitGenerationReferences(
  paths: PluginStorePaths,
  commit: PluginRegistryCommitRecord,
  options?: Readonly<{
    allowInvalidUnchangedReferencesFrom?: PluginRegistryCommitRecord | null;
  }>,
): Promise<void> {
  const parsed = PluginRegistryCommitRecordSchema.parse(commit);
  const state = await readPluginRegistryCommitInstallationAuthority(paths, parsed);
  for (const [pluginId, reference] of Object.entries(parsed.pluginGenerations)) {
    try {
      await assertGenerationNotRetired(paths, reference.immutableGenerationId);
      const rootPath = join(paths.generationsDir, reference.immutableGenerationId);
      const record = await readGenerationRecord(join(rootPath, 'plugin-generation.v1.json'));
      if (record.pluginId !== pluginId || record.immutableGenerationId !== reference.immutableGenerationId) {
        throw new Error(`Plugin registry commit generation identity mismatch for '${pluginId}'`);
      }
      if (digestJson(record) !== reference.generationRecordDigest) {
        throw new Error(`Plugin registry commit generation record digest mismatch for '${pluginId}'`);
      }
      if (JSON.stringify(record.installedArtifactRecord) !== JSON.stringify(reference.installedArtifactRecord)) {
        throw new Error(`Plugin registry commit generation artifact identity mismatch for '${pluginId}'`);
      }
      await verifyPersistedGeneration(rootPath, record);
    } catch (error) {
      const prior = options?.allowInvalidUnchangedReferencesFrom?.pluginGenerations[pluginId];
      if (prior && JSON.stringify(prior) === JSON.stringify(reference)) continue;
      throw error;
    }
  }
  for (const retention of state?.rollbackRetention ?? []) {
    if (retention.byteAvailability !== 'available') continue;
    await assertGenerationNotRetired(paths, retention.immutableGenerationId);
  }
}

export async function prepareImmutablePluginGeneration(input: Readonly<{
  paths: PluginStorePaths;
  sourceRootPath: string;
  record: ImmutablePluginGenerationRecord;
  flushDirectory?: (path: string) => Promise<void>;
}>): Promise<Readonly<{ reference: PluginRegistryGenerationReference; rootPath: string }>> {
  const record = ImmutablePluginGenerationRecordSchema.parse(input.record);
  const flushDirectoryDurably = input.flushDirectory ?? flushDirectoryDurablyDefault;
  await assertGenerationNotRetired(input.paths, record.immutableGenerationId);
  const targetRoot = join(input.paths.generationsDir, record.immutableGenerationId);
  try {
    await verifyPersistedGeneration(targetRoot, record);
    return {
      rootPath: targetRoot,
      reference: PluginRegistryGenerationReferenceSchema.parse({
        immutableGenerationId: record.immutableGenerationId,
        generationRecordDigest: digestJson(record),
        installedArtifactRecord: record.installedArtifactRecord,
      }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }

  await mkdir(input.paths.generationsDir, { recursive: true });
  const stagingRoot = join(input.paths.generationsDir, `.staging-${record.immutableGenerationId}-${process.pid}-${randomUUID()}`);
  try {
    const stagedDirectories = new Set<string>([stagingRoot]);
    for (const file of record.files) {
      const source = join(input.sourceRootPath, ...file.relativePath.split('/'));
      await verifyFile(source, file);
      const destination = join(stagingRoot, ...file.relativePath.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await verifyFile(destination, file);
      await flushFileDurably(destination);
      let directory = dirname(destination);
      while (true) {
        stagedDirectories.add(directory);
        if (directory === stagingRoot) break;
        const parent = dirname(directory);
        if (parent === directory) throw new Error('Generation staging directory escaped its immutable root');
        directory = parent;
      }
    }
    const generationRecordPath = join(stagingRoot, 'plugin-generation.v1.json');
    await writeJsonAtomic(generationRecordPath, record);
    await flushFileDurably(generationRecordPath);
    for (const directory of [...stagedDirectories].sort((left, right) => right.length - left.length)) {
      await flushDirectoryDurably(directory);
    }
    await verifyPersistedGeneration(stagingRoot, record);
    try {
      await rename(stagingRoot, targetRoot);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException | null)?.code ?? '')) throw error;
      await verifyPersistedGeneration(targetRoot, record);
    }
    await flushDirectoryDurably(input.paths.generationsDir);
    return {
      rootPath: targetRoot,
      reference: PluginRegistryGenerationReferenceSchema.parse({
        immutableGenerationId: record.immutableGenerationId,
        generationRecordDigest: digestJson(record),
        installedArtifactRecord: record.installedArtifactRecord,
      }),
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function readPreparedImmutablePluginGeneration(input: Readonly<{
  paths: PluginStorePaths;
  immutableGenerationId: string;
}>): Promise<Readonly<{
  rootPath: string;
  record: ImmutablePluginGenerationRecord;
  reference: PluginRegistryGenerationReference;
}>> {
  const immutableGenerationId = PortableStorageIdSchema.parse(input.immutableGenerationId);
  await assertGenerationNotRetired(input.paths, immutableGenerationId);
  const rootPath = join(input.paths.generationsDir, immutableGenerationId);
  const record = await readGenerationRecord(join(rootPath, 'plugin-generation.v1.json'));
  if (record.immutableGenerationId !== immutableGenerationId) {
    throw new Error(`Immutable generation identity mismatch for '${immutableGenerationId}'`);
  }
  await verifyPersistedGeneration(rootPath, record);
  return Object.freeze({
    rootPath,
    record,
    reference: PluginRegistryGenerationReferenceSchema.parse({
      immutableGenerationId,
      generationRecordDigest: digestJson(record),
      installedArtifactRecord: record.installedArtifactRecord,
    }),
  });
}

function stateRevisionPath(paths: PluginStorePaths, revisionId: string): string {
  return join(paths.stateRevisionsDir, revisionId, 'plugin-installations.v1.json');
}

export async function persistInstallationStateRevision(input: Readonly<{
  paths: PluginStorePaths;
  state: PluginInstallationStateRevision;
  flushDirectory?: (path: string) => Promise<void>;
}>): Promise<InstallationStateRevisionReference> {
  const state = PluginInstallationStateRevisionSchema.parse(input.state);
  const path = stateRevisionPath(input.paths, state.revisionId);
  const reference = Object.freeze({ revisionId: state.revisionId, digest: digestJson(state) });
  try {
    const existing = await readFile(path, 'utf8');
    if (digestBytes(Buffer.from(existing, 'utf8')) !== reference.digest || JSON.stringify(JSON.parse(existing)) !== JSON.stringify(state)) {
      throw new Error(`Immutable installation state revision '${state.revisionId}' already exists with different content`);
    }
    return reference;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
  await writeJsonAtomic(path, state);
  await flushFileDurably(path);
  const flushDirectoryDurably = input.flushDirectory ?? flushDirectoryDurablyDefault;
  await flushDirectoryDurably(dirname(path));
  await flushDirectoryDurably(input.paths.stateRevisionsDir);
  return reference;
}

export async function readInstallationStateRevision(input: Readonly<{
  paths: PluginStorePaths;
  reference: InstallationStateRevisionReference;
}>): Promise<PluginInstallationStateRevision> {
  const raw = await readFile(stateRevisionPath(input.paths, input.reference.revisionId), 'utf8');
  if (digestBytes(Buffer.from(raw, 'utf8')) !== input.reference.digest) throw new Error('Installation state revision digest mismatch');
  const parsed = PluginInstallationStateRevisionSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success || parsed.data.revisionId !== input.reference.revisionId) throw new Error('Invalid installation state revision');
  return parsed.data;
}

export async function cleanupUnreferencedPluginGenerations(input: Readonly<{
  paths: PluginStorePaths;
  commit: PluginRegistryCommitRecord;
  state: PluginInstallationStateRevision;
  retireGeneration?: (generation: Readonly<{
    pluginId: string;
    immutableGenerationId: string;
  }>) => Promise<void>;
  isCommitCurrent?: () => Promise<boolean>;
  withCommitFence?: <T>(operation: () => Promise<T>) => Promise<T>;
  flushDirectory?: (path: string) => Promise<void>;
}>): Promise<Readonly<{
  referenced: readonly string[];
  retained: readonly string[];
  removed: readonly string[];
  failures: readonly Readonly<{ generationId: string; message: string }>[];
}>> {
  const commit = PluginRegistryCommitRecordSchema.parse(input.commit);
  const state = PluginInstallationStateRevisionSchema.parse(input.state);
  if (
    state.revisionId !== commit.installationState.revisionId
    || digestJson(state) !== commit.installationState.digest
  ) {
    throw new Error('Cleanup installation state revision does not match the durable registry commit');
  }
  for (const [pluginId, generation] of Object.entries(commit.pluginGenerations)) {
    const plugin = state.plugins[pluginId];
    const health = state.health[generation.immutableGenerationId];
    if (!plugin || !health || health.pluginId !== pluginId) {
      throw new Error(`Cleanup installation state is incomplete for current plugin '${pluginId}'`);
    }
  }
  const currentGenerationIds = new Set(Object.values(commit.pluginGenerations).map((generation) => generation.immutableGenerationId));
  const retainedGenerationIds = new Set(state.rollbackRetention.map((retention) => retention.immutableGenerationId));
  for (const generationId of retainedGenerationIds) {
    if (currentGenerationIds.has(generationId)) {
      throw new Error(`Current generation '${generationId}' cannot also be a rollback retention record`);
    }
  }
  for (const generationId of Object.keys(state.health)) {
    if (!currentGenerationIds.has(generationId) && !retainedGenerationIds.has(generationId)) {
      throw new Error(`Generation health '${generationId}' is neither current nor retained`);
    }
  }
  const referenced = [...new Set(Object.values(commit.pluginGenerations).map((entry) => entry.immutableGenerationId))].sort();
  const retained = [...new Set(state.rollbackRetention
    .filter((entry) => entry.byteAvailability === 'available' && !referenced.includes(entry.immutableGenerationId))
    .map((entry) => entry.immutableGenerationId))].sort();
  const live = new Set([...referenced, ...retained]);
  const entries = await readdir(input.paths.generationsDir, { withFileTypes: true, encoding: 'utf8' }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!entries) return { referenced, retained, removed: [], failures: [] };
  const obsoleteGenerations = new Map<string, { canonicalName?: string; retiringName?: string }>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const retiringGenerationId = entry.name.startsWith('.retiring-')
      ? entry.name.slice('.retiring-'.length)
      : null;
    const generationId = retiringGenerationId ?? entry.name;
    if (
      (!retiringGenerationId && entry.name.startsWith('.'))
      || live.has(generationId)
      || isProcessLocalPreparedPluginGeneration(input.paths, generationId)
    ) continue;
    const grouped = obsoleteGenerations.get(generationId) ?? {};
    if (retiringGenerationId) grouped.retiringName = entry.name;
    else grouped.canonicalName = entry.name;
    obsoleteGenerations.set(generationId, grouped);
  }
  const removed = new Set<string>();
  const failures: Array<{ generationId: string; message: string }> = [];
  const flushDirectoryDurably = input.flushDirectory ?? flushDirectoryDurablyDefault;
  for (const [generationId, grouped] of [...obsoleteGenerations.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    try {
      let generationRoot = join(input.paths.generationsDir, grouped.retiringName ?? grouped.canonicalName!);
      const generationRootsToRemove = new Set(
        [grouped.retiringName, grouped.canonicalName]
          .filter((name): name is string => name !== undefined)
          .map((name) => join(input.paths.generationsDir, name)),
      );
      let record!: ImmutablePluginGenerationRecord;
      const withCommitFence = input.withCommitFence ?? (async <T>(operation: () => Promise<T>) => await operation());
      await withCommitFence(async () => {
        if (input.isCommitCurrent && !await input.isCommitCurrent()) {
          throw new Error('Plugin registry commit changed before obsolete generation retirement');
        }
        record = await readGenerationRecord(join(generationRoot, 'plugin-generation.v1.json'));
        if (record.immutableGenerationId !== generationId) {
          throw new Error(`Obsolete generation record identity mismatch for '${generationId}'`);
        }
        await verifyPersistedGeneration(generationRoot, record);
        for (const duplicateRoot of generationRootsToRemove) {
          if (duplicateRoot === generationRoot) continue;
          const duplicateRecord = await readGenerationRecord(join(duplicateRoot, 'plugin-generation.v1.json'));
          if (digestJson(duplicateRecord) !== digestJson(record)) {
            throw new Error(`Obsolete generation duplicate content mismatch for '${generationId}'`);
          }
          await verifyPersistedGeneration(duplicateRoot, duplicateRecord);
        }
        if (!grouped.retiringName) {
          const retiringRoot = join(input.paths.generationsDir, `.retiring-${generationId}`);
          await rename(generationRoot, retiringRoot);
          generationRootsToRemove.delete(generationRoot);
          generationRootsToRemove.add(retiringRoot);
          generationRoot = retiringRoot;
          await flushDirectoryDurably(input.paths.generationsDir);
          if (input.isCommitCurrent && !await input.isCommitCurrent()) {
            await rename(retiringRoot, join(input.paths.generationsDir, generationId));
            await flushDirectoryDurably(input.paths.generationsDir);
            throw new Error('Plugin registry commit changed during obsolete generation retirement');
          }
        }
      });
      if (input.retireGeneration) {
        await input.retireGeneration({
          pluginId: record.pluginId,
          immutableGenerationId: record.immutableGenerationId,
        });
      }
      await persistRetiredGenerationTombstone({
        paths: input.paths,
        record,
        flushDirectoryDurably,
      });
      for (const root of generationRootsToRemove) {
        await rm(root, { recursive: true, force: false });
      }
      await flushDirectoryDurably(input.paths.generationsDir);
      removed.add(generationId);
    } catch (error) {
      failures.push({ generationId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return Object.freeze({ referenced, retained, removed: [...removed].sort(), failures });
}
