import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import {
  PluginAvailabilityPortableReleaseSourceClassV1Schema,
  PluginIdSchema,
  PluginInstallReviewPrincipalDigestSchema,
  PluginInstallReviewPrincipalPresentationV1Schema,
  PluginReleaseFactsV1Schema,
  type PluginId,
} from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { resolveCliRuntimeRootPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { pluginInstallReviewPrincipalPresentationMatchesDigest } from '@/plugins/daemon/installReviewPrincipal';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import {
  PluginStateFileV1Schema,
  PluginStateRecordSchema,
} from '../state';
import {
  flushDirectoryDurably as flushDirectoryDurablyDefault,
  flushFileDurably,
} from './durability';

import {
  pluginSourceProvenanceForDistribution,
  pluginSourceProvenanceForKind,
  PluginSourceProvenanceSchema,
} from '@/plugins/manifest/sourceProvenance';
import { PluginAccessSelectionSchema } from '../install/accessScopeRegistry';
import {
  AlgorithmQualifiedIntegritySchema,
  PluginDistributionIdentitySchema,
  PluginTrustRecordSchema,
  PluginUpdatePolicySchema,
  isPluginTrustRecordAuthorized,
  pluginDistributionRollbackLineagesEqual,
  type PluginDistributionIdentity,
} from '../install/trustIdentity';
import type { PluginStorePaths } from '../paths';
import {
  pluginRegistryCommitRecordsEqual,
  PortableRelativePathSchema,
  PortableStorageIdSchema,
  PluginRegistryCommitRecordSchema,
  PluginRegistryGenerationReferenceSchema,
  readPluginRegistryCommitRecord,
  type PluginRegistryCommitRecord,
  type PluginRegistryGenerationReference,
} from './commitRecord';

type InstallReviewPrincipalPair = Readonly<{
  installReviewPrincipalDigest?: z.infer<typeof PluginInstallReviewPrincipalDigestSchema>;
  installReviewPrincipalPresentation?: z.infer<typeof PluginInstallReviewPrincipalPresentationV1Schema>;
}>;

function installReviewPrincipalPairMatches(record: InstallReviewPrincipalPair): boolean {
  return !record.installReviewPrincipalPresentation
    || Boolean(
      record.installReviewPrincipalDigest
      && pluginInstallReviewPrincipalPresentationMatchesDigest(
        record.installReviewPrincipalDigest,
        record.installReviewPrincipalPresentation,
      )
    );
}

function validateInstallReviewPrincipalPair(
  record: InstallReviewPrincipalPair,
  context: z.RefinementCtx,
): void {
  if (record.installReviewPrincipalPresentation && !record.installReviewPrincipalDigest) {
    context.addIssue({
      code: 'custom',
      path: ['installReviewPrincipalPresentation'],
      message: 'Install-review principal presentation requires its digest',
    });
    return;
  }
  if (!installReviewPrincipalPairMatches(record)) {
    context.addIssue({
      code: 'custom',
      path: ['installReviewPrincipalPresentation'],
      message: 'Install-review principal presentation digest mismatch',
    });
  }
}

const GenerationFileSchema = z.object({
  relativePath: PortableRelativePathSchema,
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const ValidatedAgentSessionRunnerFactoryFactV1Schema = z.object({
  localAgentId: z.string().trim().min(1).max(256),
  locator: z.object({
    module: z.string().regex(/^\.[/][A-Za-z0-9._/-]+$/u),
    export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u),
    runtimeApiVersion: z.literal(1),
    externalSessionsExport:
      z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u).optional(),
  }).strict(),
  normalizedModulePath: PortableRelativePathSchema,
  loadMode: z.enum(['immutable-js', 'source-ts']),
}).strict();

export const ValidatedAgentSessionRunnerFactoriesRecordV1Schema = z.object({
  t: z.literal('happier_agent_session_runner_factories_v1'),
  schemaVersion: z.literal(1),
  pluginId: asHostProtocolZod(PluginIdSchema),
  immutableGenerationId: PortableStorageIdSchema,
  manifestAuthority:
    z.enum(['external', 'bundled_first_party']),
  factories: z.array(ValidatedAgentSessionRunnerFactoryFactV1Schema).max(256),
}).strict().superRefine((record, context) => {
  const ids = record.factories.map((factory) => factory.localAgentId);
  if (
    new Set(ids).size !== ids.length
    || ids.some((id, index) => index > 0 && ids[index - 1]! >= id)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['factories'],
      message: 'Validated Agent runner factory facts must be unique and sorted by Agent id',
    });
  }
});
export type ValidatedAgentSessionRunnerFactoriesRecordV1 = z.infer<
  typeof ValidatedAgentSessionRunnerFactoriesRecordV1Schema
>;

function validatedAgentSessionRunnerFactoriesRecordPath(
  paths: PluginStorePaths,
  immutableGenerationId: string,
): string {
  return join(
    paths.stateDir,
    'validated-agent-session-runner-factories',
    `${immutableGenerationId}.v1.json`,
  );
}

// The official packed plugin SDK currently brings a measured 6,356-file
// runtime closure. Keep conservative power-of-two headroom while preserving a
// hard inventory bound and the independent 512 MiB byte ceiling.
export const MAXIMUM_IMMUTABLE_GENERATION_FILES = 16_384;

const OWNED_DEVELOPMENT_DRAFT_FILE_NAME = '.owned-development-draft.v1.json';
const OwnedDevelopmentDraftSchema = z.object({
  t: z.literal('happier_owned_plugin_development_draft_v1'),
  schemaVersion: z.literal(1),
  immutableGenerationId: PortableStorageIdSchema,
}).strict();

// This is an exact storage-identity fact, not a health, revocation, or
// currentness registry. Its only purpose is to prevent a completed retirement
// from being undone by the old directory reappearing after cleanup/restart.
const RetiredPluginGenerationMarkerV1Schema = z.object({
  t: z.literal('happier_retired_plugin_generation_v1'),
  schemaVersion: z.literal(1),
  pluginId: asHostProtocolZod(PluginIdSchema),
  immutableGenerationId: PortableStorageIdSchema,
}).strict();

export const ImmutablePluginGenerationRecordSchema = z.object({
  t: z.literal('happier_plugin_generation_v1'),
  schemaVersion: z.literal(1),
  pluginId: asHostProtocolZod(PluginIdSchema),
  immutableGenerationId: PortableStorageIdSchema,
  createdAtMs: z.number().int().nonnegative(),
  files: z.array(GenerationFileSchema).max(MAXIMUM_IMMUTABLE_GENERATION_FILES),
  manifestRelativePath: PortableRelativePathSchema,
  /**
   * Derived once, at mint time, from the distribution identity the generation
   * was admitted under. A generation is a daemon-owned, symlink-free copy, so
   * no reader can re-derive this from the materialized bytes.
   */
  sourceProvenance: PluginSourceProvenanceSchema,
}).strict().superRefine((record, context) => {
  const paths = record.files.map((file) => file.relativePath);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Generation file inventory must be unique and sorted' });
  }
  if (!record.files.some((file) => file.relativePath === record.manifestRelativePath)) {
    context.addIssue({ code: 'custom', path: ['manifestRelativePath'], message: 'Generation manifest must be present in the structural inventory' });
  }
});
export type ImmutablePluginGenerationRecord = z.infer<typeof ImmutablePluginGenerationRecordSchema>;

export type ImmutablePluginGenerationMaterialization = Readonly<{
  copiedFileCount: number;
  copiedByteCount: number;
  reusedFileCount: number;
}>;

export type PreparedImmutablePluginGeneration = Readonly<{
  reference: PluginRegistryGenerationReference;
  rootPath: string;
  materialization?: ImmutablePluginGenerationMaterialization;
}>;

export type OwnedPreparedImmutablePluginGeneration = Readonly<{
  rootPath: string;
  record: ImmutablePluginGenerationRecord;
  reference: PluginRegistryGenerationReference;
  adopt: () => void;
  cleanup: () => Promise<void>;
}>;

// Development drafts produce the same daemon-owned immutable candidate that
// archive, npm, and path review use. Keep this alias while callers migrate to
// the neutral ownership seam.
export type OwnedPreparedPluginDevelopmentGeneration = OwnedPreparedImmutablePluginGeneration;

function createOwnedPreparedImmutablePluginGenerationHandle(input: Readonly<{
  rootPath: string;
  record: ImmutablePluginGenerationRecord;
  adopt: () => void;
  cleanup: () => Promise<void>;
}>): OwnedPreparedImmutablePluginGeneration {
  const record = ImmutablePluginGenerationRecordSchema.parse(input.record);
  return Object.freeze({
    rootPath: input.rootPath,
    record,
    reference: PluginRegistryGenerationReferenceSchema.parse({
      immutableGenerationId: record.immutableGenerationId,
    }),
    adopt: input.adopt,
    cleanup: input.cleanup,
  });
}

const PluginInstallationAvailabilitySourceClassSchema = z.union([
  asHostProtocolZod(PluginAvailabilityPortableReleaseSourceClassV1Schema),
  z.literal('localPath'),
]);

/**
 * Local installation facts only. This is part of the canonical install
 * revision so a full inventory can be reconstructed after restart; it is not
 * an Availability snapshot, authority, or currentness decision.
 */
export type PluginInstallationAvailabilityProjection = {
  sourceClass: z.infer<typeof PluginInstallationAvailabilitySourceClassSchema>;
  portableRelease: boolean;
  release?: z.infer<typeof PluginReleaseFactsV1Schema>;
};

export const PluginInstallationAvailabilityProjectionSchema: z.ZodType<
  PluginInstallationAvailabilityProjection
> = z.object({
  sourceClass: PluginInstallationAvailabilitySourceClassSchema,
  portableRelease: z.boolean(),
  release: asHostProtocolZod(PluginReleaseFactsV1Schema).optional(),
}).strict().superRefine((value, context) => {
  if (value.sourceClass === 'localPath' && value.portableRelease) {
    context.addIssue({
      code: 'custom',
      path: ['portableRelease'],
      message: 'Local-path installations cannot claim a portable release',
    });
  }
  if (value.portableRelease !== Boolean(value.release)) {
    context.addIssue({
      code: 'custom',
      path: ['release'],
      message: 'Portable installation availability must carry exactly one release fact set',
    });
  }
});

export function createDefaultPluginInstallationAvailabilityProjection(
  distribution: PluginDistributionIdentity,
): PluginInstallationAvailabilityProjection {
  return Object.freeze({
    sourceClass: distribution.kind === 'npm'
      ? 'registryPackage'
      : distribution.kind === 'archive'
        ? 'versionedArchive'
        : 'localPath',
    portableRelease: false,
  });
}

export type PluginRollbackRetentionRecord = {
  pluginId: PluginId;
  immutableGenerationId: z.infer<typeof PortableStorageIdSchema>;
  retainedAtMs: number;
  byteAvailability: 'available' | 'missing' | 'corrupt' | 'evicted' | 'sourceIneligible';
  pluginVersion: string;
  distribution: PluginDistributionIdentity;
  admittedIntegrity?: z.infer<typeof AlgorithmQualifiedIntegritySchema>;
  availability?: PluginInstallationAvailabilityProjection;
  installReviewPrincipalDigest?: z.infer<typeof PluginInstallReviewPrincipalDigestSchema>;
  installReviewPrincipalPresentation?: z.infer<typeof PluginInstallReviewPrincipalPresentationV1Schema>;
};

export const PluginRollbackRetentionRecordSchema: z.ZodType<PluginRollbackRetentionRecord> = z.object({
  pluginId: asHostProtocolZod(PluginIdSchema),
  immutableGenerationId: PortableStorageIdSchema,
  retainedAtMs: z.number().int().nonnegative(),
  byteAvailability: z.enum(['available', 'missing', 'corrupt', 'evicted', 'sourceIneligible']),
  pluginVersion: z.string().min(1).max(256),
  distribution: PluginDistributionIdentitySchema,
  admittedIntegrity: AlgorithmQualifiedIntegritySchema.optional(),
  availability: PluginInstallationAvailabilityProjectionSchema.optional(),
  installReviewPrincipalDigest: asHostProtocolZod(PluginInstallReviewPrincipalDigestSchema).optional(),
  installReviewPrincipalPresentation: asHostProtocolZod(PluginInstallReviewPrincipalPresentationV1Schema).optional(),
}).strict().superRefine((record, context) => {
  if (record.distribution.kind === 'localPath' && record.admittedIntegrity) {
    context.addIssue({ code: 'custom', path: ['admittedIntegrity'], message: 'Local path rollback retention cannot declare acquisition integrity' });
  }
  if (
    record.availability
    && record.availability.sourceClass
      !== createDefaultPluginInstallationAvailabilityProjection(record.distribution).sourceClass
  ) {
    context.addIssue({ code: 'custom', path: ['availability', 'sourceClass'], message: 'Rollback availability source class must match its installation distribution' });
  }
  validateInstallReviewPrincipalPair(record, context);
});

export type PluginInstallationStateRecord = {
  enabled: boolean;
  materializationId?: z.infer<typeof PortableStorageIdSchema>;
  trust?: z.infer<typeof PluginTrustRecordSchema>;
  source: {
    distribution: PluginDistributionIdentity;
    admittedIntegrity?: z.infer<typeof AlgorithmQualifiedIntegritySchema>;
  };
  updatePolicy: z.infer<typeof PluginUpdatePolicySchema>;
  optionalAccess: Array<z.infer<typeof PluginAccessSelectionSchema>>;
  availability?: PluginInstallationAvailabilityProjection;
  installReviewPrincipalDigest?: z.infer<typeof PluginInstallReviewPrincipalDigestSchema>;
  installReviewPrincipalPresentation?: z.infer<typeof PluginInstallReviewPrincipalPresentationV1Schema>;
};

const PluginInstallationStateRecordSchema: z.ZodType<PluginInstallationStateRecord> = z.object({
  enabled: z.boolean(),
  /** Stable across updates/rollbacks; replaced only when the installation is removed. */
  materializationId: PortableStorageIdSchema.optional(),
  trust: PluginTrustRecordSchema.optional(),
  source: z.object({
    distribution: PluginDistributionIdentitySchema,
    admittedIntegrity: AlgorithmQualifiedIntegritySchema.optional(),
  }).strict(),
  updatePolicy: PluginUpdatePolicySchema,
  optionalAccess: z.array(PluginAccessSelectionSchema).max(512),
  availability: PluginInstallationAvailabilityProjectionSchema.optional(),
  installReviewPrincipalDigest: asHostProtocolZod(PluginInstallReviewPrincipalDigestSchema).optional(),
  installReviewPrincipalPresentation: asHostProtocolZod(PluginInstallReviewPrincipalPresentationV1Schema).optional(),
}).strict().superRefine((record, context) => {
  if (record.source.distribution.kind === 'localPath' && record.source.admittedIntegrity) {
    context.addIssue({ code: 'custom', path: ['source', 'admittedIntegrity'], message: 'Local path installation cannot declare acquisition integrity' });
  }
  if (
    record.availability
    && record.availability.sourceClass
      !== createDefaultPluginInstallationAvailabilityProjection(record.source.distribution).sourceClass
  ) {
    context.addIssue({ code: 'custom', path: ['availability', 'sourceClass'], message: 'Installation availability source class must match its installation distribution' });
  }
  validateInstallReviewPrincipalPair(record, context);
});

export type PluginInstallationStateRevision = {
  t: 'happier_plugin_installations_v1';
  schemaVersion: 1;
  revisionId: z.infer<typeof PortableStorageIdSchema>;
  createdAtMs: number;
  plugins: Record<PluginId, PluginInstallationStateRecord>;
  rollbackRetention: PluginRollbackRetentionRecord[];
  hardRevocationRevisions?: Record<PluginId, number>;
  runtimeCatalog?: z.infer<typeof PluginStateFileV1Schema>;
  retainedRuntimeCatalog?: Record<
    z.infer<typeof PortableStorageIdSchema>,
    z.infer<typeof PluginStateRecordSchema>
  >;
};

const CanonicalPluginInstallationStateRevisionSchema: z.ZodType<PluginInstallationStateRevision> = z.object({
  t: z.literal('happier_plugin_installations_v1'),
  schemaVersion: z.literal(1),
  revisionId: PortableStorageIdSchema,
  createdAtMs: z.number().int().nonnegative(),
  plugins: z.record(asHostProtocolZod(PluginIdSchema), PluginInstallationStateRecordSchema),
  rollbackRetention: z.array(PluginRollbackRetentionRecordSchema),
  hardRevocationRevisions: z.record(
    asHostProtocolZod(PluginIdSchema),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ).optional(),
  runtimeCatalog: PluginStateFileV1Schema.optional(),
  retainedRuntimeCatalog: z.record(PortableStorageIdSchema, PluginStateRecordSchema).optional(),
}).strict().superRefine((state, context) => {
  const priorRetentionCount = new Map<string, number>();
  const retainedGenerationIds = new Set<string>();
  const materializationIds = new Set<string>();
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
    if (plugin.materializationId) {
      if (materializationIds.has(plugin.materializationId)) {
        context.addIssue({ code: 'custom', path: ['plugins', pluginId, 'materializationId'], message: 'Installation materialization ids must be unique' });
      }
      materializationIds.add(plugin.materializationId);
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
      if (
        installation?.availability?.release
        && catalog
        && installation.availability.release.ref.version !== catalog.install.manifestVersion
      ) {
        context.addIssue({
          code: 'custom',
          path: ['plugins', pluginId, 'availability', 'release', 'ref', 'version'],
          message: 'Portable release availability version must match the installed catalog version',
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
  for (const [index, retention] of state.rollbackRetention.entries()) {
    if (retainedGenerationIds.has(retention.immutableGenerationId)) {
      context.addIssue({ code: 'custom', path: ['rollbackRetention', index], message: 'A generation may have only one rollback retention role' });
    }
    retainedGenerationIds.add(retention.immutableGenerationId);
    const count = (priorRetentionCount.get(retention.pluginId) ?? 0) + 1;
    priorRetentionCount.set(retention.pluginId, count);
    if (count > 1) {
      context.addIssue({
        code: 'custom',
        path: ['rollbackRetention', index],
        message: 'Bounded rollback retention permits at most one prior generation per plugin',
      });
    }
    const plugin = state.plugins[retention.pluginId];
    if (!plugin || !pluginDistributionRollbackLineagesEqual(plugin.source.distribution, retention.distribution)) {
      context.addIssue({ code: 'custom', path: ['rollbackRetention', index], message: 'Retention source identity must match the current installation' });
    }
  }
});

export const PluginInstallationStateRevisionSchema: z.ZodType<PluginInstallationStateRevision> =
  CanonicalPluginInstallationStateRevisionSchema;

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

export type InstallationStateRevisionReference = Readonly<{ revisionId: string }>;

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

function retiredPluginGenerationMarkerFileName(
  immutableGenerationId: string,
): string {
  return `.retired-${PortableStorageIdSchema.parse(immutableGenerationId)}.v1.json`;
}

function retiredPluginGenerationMarkerPath(
  paths: PluginStorePaths,
  immutableGenerationId: string,
): string {
  return join(
    paths.generationsDir,
    retiredPluginGenerationMarkerFileName(immutableGenerationId),
  );
}

function isRetiredPluginGenerationMarkerFileName(name: string): boolean {
  const prefix = '.retired-';
  const suffix = '.v1.json';
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  return PortableStorageIdSchema.safeParse(
    name.slice(prefix.length, -suffix.length),
  ).success;
}

async function readRetiredPluginGenerationMarker(
  paths: PluginStorePaths,
  immutableGenerationId: string,
): Promise<z.infer<typeof RetiredPluginGenerationMarkerV1Schema> | null> {
  const expectedId = PortableStorageIdSchema.parse(immutableGenerationId);
  try {
    const marker = RetiredPluginGenerationMarkerV1Schema.parse(JSON.parse(await readFile(
      retiredPluginGenerationMarkerPath(paths, expectedId),
      'utf8',
    )) as unknown);
    if (marker.immutableGenerationId !== expectedId) {
      throw new Error(`Retired generation marker identity mismatch for '${expectedId}'`);
    }
    return marker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertGenerationNotRetired(
  paths: PluginStorePaths,
  immutableGenerationId: string,
): Promise<void> {
  const expectedId = PortableStorageIdSchema.parse(immutableGenerationId);
  for (const path of [
    join(paths.generationsDir, `.retiring-${expectedId}`),
    retiredPluginGenerationMarkerPath(paths, expectedId),
  ]) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`Immutable generation '${expectedId}' is retired or staged for retirement`);
  }
}

async function persistRetiredPluginGenerationMarker(input: Readonly<{
  paths: PluginStorePaths;
  record: ImmutablePluginGenerationRecord;
  flushDirectoryDurably: (path: string) => Promise<void>;
}>): Promise<void> {
  const expected = RetiredPluginGenerationMarkerV1Schema.parse({
    t: 'happier_retired_plugin_generation_v1',
    schemaVersion: 1,
    pluginId: input.record.pluginId,
    immutableGenerationId: input.record.immutableGenerationId,
  });
  const assertExpected = (
    marker: z.infer<typeof RetiredPluginGenerationMarkerV1Schema>,
  ): void => {
    if (!isDeepStrictEqual(marker, expected)) {
      throw new Error(
        `Retired generation marker identity mismatch for '${expected.immutableGenerationId}'`,
      );
    }
  };
  const path = retiredPluginGenerationMarkerPath(
    input.paths,
    expected.immutableGenerationId,
  );
  const existing = await readRetiredPluginGenerationMarker(
    input.paths,
    expected.immutableGenerationId,
  );
  if (existing) {
    assertExpected(existing);
  } else {
    try {
      await writeJsonAtomic(path, expected);
    } catch (writeError) {
      const winner = await readRetiredPluginGenerationMarker(
        input.paths,
        expected.immutableGenerationId,
      );
      if (!winner) throw writeError;
      assertExpected(winner);
    }
  }
  await flushFileDurably(path);
  await input.flushDirectoryDurably(input.paths.generationsDir);
}

type ImmutablePluginGenerationFile = ImmutablePluginGenerationRecord['files'][number];

/**
 * Immutable generations need independent writable inodes, not eager duplicate
 * blocks. COPYFILE_FICLONE asks supporting filesystems for copy-on-write and
 * deliberately falls back to the ordinary copy semantics everywhere else.
 */
export async function copyOwnedPluginGenerationFile(
  sourcePath: string,
  destinationPath: string,
  copyFileImpl: typeof copyFile = copyFile,
): Promise<void> {
  await copyFileImpl(sourcePath, destinationPath, constants.COPYFILE_FICLONE);
}

function createImmutablePluginGenerationRecord(input: Readonly<{
  pluginId: string;
  manifestRelativePath: string;
  distribution: z.input<typeof PluginDistributionIdentitySchema>;
  updatePolicy: z.input<typeof PluginUpdatePolicySchema>;
  createdAtMs: number;
  immutableGenerationId?: string;
  files: readonly ImmutablePluginGenerationFile[];
}>): ImmutablePluginGenerationRecord {
  const files = [...input.files].sort((left, right) => (
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  ));
  const totalBytes = files.reduce((total, file) => total + file.byteLength, 0);
  if (files.length > MAXIMUM_IMMUTABLE_GENERATION_FILES || totalBytes > 512 * 1024 * 1024) {
    throw new Error('Immutable plugin generation source exceeds its bounded inventory');
  }
  const manifestRelativePath = PortableRelativePathSchema.parse(
    input.manifestRelativePath.replaceAll('\\', '/'),
  );
  if (!files.some((file) => file.relativePath === manifestRelativePath)) {
    throw new Error('Immutable plugin generation manifest is absent from the source inventory');
  }
  return ImmutablePluginGenerationRecordSchema.parse({
    t: 'happier_plugin_generation_v1',
    schemaVersion: 1,
    pluginId: input.pluginId,
    immutableGenerationId: input.immutableGenerationId ?? `gen-${input.createdAtMs}-${randomUUID()}`,
    createdAtMs: input.createdAtMs,
    files,
    manifestRelativePath,
    sourceProvenance: pluginSourceProvenanceForDistribution(
      PluginDistributionIdentitySchema.parse(input.distribution),
    ),
  });
}

export async function createImmutablePluginGenerationRecordFromSource(input: Readonly<{
  pluginId: string;
  sourceRootPath: string;
  manifestRelativePath: string;
  distribution: z.input<typeof PluginDistributionIdentitySchema>;
  updatePolicy: z.input<typeof PluginUpdatePolicySchema>;
  createdAtMs: number;
  immutableGenerationId?: string;
  singleFileRelativePath?: string;
  generatedManifestContents?: string;
  excludeOwnedDevelopmentDraftMarker?: true;
}>): Promise<ImmutablePluginGenerationRecord> {
  const rootPath = await realpath(input.sourceRootPath);
  const manifestRelativePath = PortableRelativePathSchema.parse(input.manifestRelativePath.split(sep).join('/'));
  const files: Array<{ relativePath: string; byteLength: number }> = [];
  const selectedSourcePath = input.singleFileRelativePath === undefined
    ? null
    : PortableRelativePathSchema.parse(input.singleFileRelativePath.replaceAll('\\', '/'));
  if (selectedSourcePath?.includes('/')) {
    throw new Error('Literal one-file generation source must be directly below its source root');
  }
  const selectedSourcePaths = selectedSourcePath === null ? null : [selectedSourcePath];
  const pending = selectedSourcePaths ? [] : [''];
  let totalBytes = 0;
  if (selectedSourcePaths) {
    for (const relativePath of [...new Set(selectedSourcePaths)].sort()) {
      const absolutePath = join(rootPath, ...relativePath.split('/'));
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Selected immutable plugin generation source must be a regular file: ${relativePath}`);
      }
      totalBytes += metadata.size;
      files.push({ relativePath, byteLength: metadata.size });
    }
  }
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
      if (
        input.excludeOwnedDevelopmentDraftMarker
        && relativePath === OWNED_DEVELOPMENT_DRAFT_FILE_NAME
      ) continue;
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
      totalBytes += metadata.size;
      if (files.length >= MAXIMUM_IMMUTABLE_GENERATION_FILES || totalBytes > 512 * 1024 * 1024) {
        throw new Error('Immutable plugin generation source exceeds its bounded inventory');
      }
      files.push({ relativePath, byteLength: metadata.size });
    }
  }
  if (input.generatedManifestContents !== undefined) {
    if (files.some((file) => file.relativePath === manifestRelativePath)) {
      throw new Error('Host-generated plugin manifest collides with an author source file');
    }
    const bytes = Buffer.from(input.generatedManifestContents, 'utf8');
    files.push({
      relativePath: manifestRelativePath,
      byteLength: bytes.byteLength,
    });
  }
  return createImmutablePluginGenerationRecord({
    pluginId: input.pluginId,
    manifestRelativePath,
    distribution: input.distribution,
    updatePolicy: input.updatePolicy,
    createdAtMs: input.createdAtMs,
    ...(input.immutableGenerationId ? { immutableGenerationId: input.immutableGenerationId } : {}),
    files,
  });
}

async function readGenerationRecord(
  path: string,
): Promise<ImmutablePluginGenerationRecord> {
  const raw = await readFile(path);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('Invalid immutable plugin generation record', { cause: error });
  }
  return ImmutablePluginGenerationRecordSchema.parse(value);
}

/**
 * The exact structural fact that made one generation path inadmissible.
 *
 * The containment walk below already distinguishes these; naming them lets an
 * administration reader report and repair-guide the real condition instead of
 * re-deriving it from English message text or walking the tree a second time.
 */
export type ContainedGenerationFileFailure =
  | 'root_not_directory'
  | 'missing'
  | 'escaped'
  | 'not_regular'
  | 'shared_inode'
  | 'size_mismatch';

export class ContainedGenerationFileError extends Error {
  readonly failure: ContainedGenerationFileFailure;
  readonly relativePath: string;

  constructor(
    failure: ContainedGenerationFileFailure,
    relativePath: string,
    message: string,
  ) {
    super(message);
    this.name = 'ContainedGenerationFileError';
    this.failure = failure;
    this.relativePath = relativePath;
  }
}

async function assertGenerationRootDirectory(root: string): Promise<void> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ContainedGenerationFileError(
      'root_not_directory',
      '',
      'Immutable plugin generation root must be a real directory, not a symbolic link',
    );
  }
}

async function assertContainedRegularFile(
  root: string,
  relativePath: string,
  label: string,
  options?: Readonly<{
    expectedByteLength?: number;
    requireExclusiveInode?: boolean;
  }>,
): Promise<void> {
  const normalizedPath = PortableRelativePathSchema.parse(relativePath);
  await assertGenerationRootDirectory(root);
  let currentPath = root;
  const segments = normalizedPath.split('/');
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        throw new ContainedGenerationFileError('missing', normalizedPath, `${label} is missing from the immutable generation root: ${normalizedPath}`);
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new ContainedGenerationFileError('escaped', normalizedPath, `${label} must be contained in the immutable generation root, not a symbolic link: ${normalizedPath}`);
    }
    if (index === segments.length - 1) {
      if (!metadata.isFile()) {
        throw new ContainedGenerationFileError('not_regular', normalizedPath, `${label} must be a regular file: ${normalizedPath}`);
      }
      if (
        options?.expectedByteLength !== undefined
        && metadata.size !== options.expectedByteLength
      ) {
        throw new ContainedGenerationFileError('size_mismatch', normalizedPath, `${label} has an unexpected byte length: ${normalizedPath}`);
      }
      if (options?.requireExclusiveInode && metadata.nlink > 1) {
        throw new ContainedGenerationFileError('shared_inode', normalizedPath, `${label} must not share a writable inode: ${normalizedPath}`);
      }
    } else if (!metadata.isDirectory()) {
      throw new ContainedGenerationFileError('not_regular', normalizedPath, `${label} ancestor must be a real directory: ${normalizedPath}`);
    }
  }
}

export async function assertContainedRegularGenerationFile(
  root: string,
  relativePath: string,
  label: string,
  options?: Readonly<{ expectedByteLength?: number }>,
): Promise<void> {
  await assertContainedRegularFile(root, relativePath, label, {
    requireExclusiveInode: true,
    ...(options?.expectedByteLength === undefined
      ? {}
      : { expectedByteLength: options.expectedByteLength }),
  });
}
async function verifyPersistedGeneration(root: string, expected: ImmutablePluginGenerationRecord): Promise<void> {
  await assertGenerationRootDirectory(root);
  const recordPath = join(root, 'plugin-generation.v1.json');
  await assertContainedRegularGenerationFile(
    root,
    'plugin-generation.v1.json',
    'Immutable plugin generation record',
  );
  const record = await readGenerationRecord(recordPath);
  if (JSON.stringify(record) !== JSON.stringify(expected)) {
    throw new Error('Immutable plugin generation substitution detected');
  }
  const manifestFile = record.files.find(
    (file) => file.relativePath === record.manifestRelativePath,
  );
  if (!manifestFile) {
    throw new Error('Immutable plugin generation manifest is absent from the structural inventory');
  }
  await assertContainedRegularFile(
    root,
    record.manifestRelativePath,
    'Immutable plugin generation manifest',
    {
      expectedByteLength: manifestFile.byteLength,
      requireExclusiveInode: true,
    },
  );
}

export async function persistValidatedAgentSessionRunnerFactories(input: Readonly<{
  paths: PluginStorePaths;
  record: ImmutablePluginGenerationRecord;
  manifestAuthority: 'external' | 'bundled_first_party';
  factories: readonly z.input<
    typeof ValidatedAgentSessionRunnerFactoryFactV1Schema
  >[];
}>): Promise<ValidatedAgentSessionRunnerFactoriesRecordV1> {
  const generation = ImmutablePluginGenerationRecordSchema.parse(input.record);
  await assertGenerationNotRetired(input.paths, generation.immutableGenerationId);
  const sortedFactories = [...input.factories].sort((left, right) =>
    left.localAgentId.localeCompare(right.localAgentId));
  const validated = ValidatedAgentSessionRunnerFactoriesRecordV1Schema.parse({
    t: 'happier_agent_session_runner_factories_v1',
    schemaVersion: 1,
    pluginId: generation.pluginId,
    immutableGenerationId: generation.immutableGenerationId,
    manifestAuthority: input.manifestAuthority,
    factories: sortedFactories,
  });
  const path = validatedAgentSessionRunnerFactoriesRecordPath(
    input.paths,
    generation.immutableGenerationId,
  );
  try {
    const existing = ValidatedAgentSessionRunnerFactoriesRecordV1Schema.parse(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
    );
    if (!isDeepStrictEqual(existing, validated)) {
      throw new Error('Validated Agent runner factories record is immutable');
    }
    return Object.freeze(existing);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomic(path, validated);
  await flushFileDurably(path);
  return Object.freeze(validated);
}

export async function readValidatedAgentSessionRunnerFactories(input: Readonly<{
  paths: PluginStorePaths;
  record: ImmutablePluginGenerationRecord;
}>): Promise<ValidatedAgentSessionRunnerFactoriesRecordV1> {
  await assertGenerationNotRetired(
    input.paths,
    input.record.immutableGenerationId,
  );
  const path = validatedAgentSessionRunnerFactoriesRecordPath(
    input.paths,
    input.record.immutableGenerationId,
  );
  const parsed = ValidatedAgentSessionRunnerFactoriesRecordV1Schema.parse(
    JSON.parse(await readFile(path, 'utf8')) as unknown,
  );
  const expected = ImmutablePluginGenerationRecordSchema.parse(input.record);
  if (
    parsed.pluginId !== expected.pluginId
    || parsed.immutableGenerationId !== expected.immutableGenerationId
  ) {
    throw new Error('Validated Agent runner factories generation binding mismatch');
  }
  return Object.freeze(parsed);
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
  /**
   * The package root export, which resolves the installed plugin root and is the
   * TypeScript compiler's own emit.
   */
  packageEntryRelativePath: string;
  /**
   * The activation module the daemon imports. It is published by the bundled-plugin
   * publisher outside the compiler's output directory, so it is a different file from
   * the package root export.
   */
  daemonEntryRelativePath?: string | null;
  /**
   * Structural generation facts only. Provenance is not one of them: the host
   * itself ships these bytes, so `admitBundledImmutablePluginGeneration`
   * stamps that custody fact rather than the artifact generator restating it.
   */
  record: Omit<ImmutablePluginGenerationRecord, 'sourceProvenance'>;
}>;

/**
 * Host custody of one exact plugin generation: the host itself ships these
 * bytes under this generation id.
 *
 * This is the only derivation of first-party runner authority. A plugin's own
 * `happier.*` id is a claim its manifest makes about itself, and an installed
 * plugin may legitimately carry one while it is being developed from a local
 * working tree — so the id can never stand in for custody. An ambiguous
 * inventory (more than one artifact for the same plugin) resolves to no
 * custody rather than picking one.
 */
export function resolveBundledImmutablePluginArtifact(input: Readonly<{
  bundledArtifacts: readonly BundledImmutablePluginArtifact[];
  pluginId: string;
  immutableGenerationId: string;
}>): BundledImmutablePluginArtifact | null {
  const forPlugin = input.bundledArtifacts.filter(
    (artifact) => artifact.record.pluginId === input.pluginId,
  );
  const artifact = forPlugin.length === 1 ? forPlugin[0]! : null;
  return artifact?.record.immutableGenerationId === input.immutableGenerationId
    ? artifact
    : null;
}

function bundledPackageNameSegments(packageName: string): string[] {
  const segments = packageName.split('/');
  if (segments.some((segment) => (
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.includes('\\')
  ))) {
    throw new Error(`Bundled plugin package name is not a contained package path: '${packageName}'`);
  }
  return segments;
}

async function resolveBundledPackageEntry(
  packageName: string,
  packageEntryRelativePath: string,
): Promise<string> {
  // Standalone daemon code is embedded in its binary, while the packaged
  // workspace closure is staged beside that binary. A bundled artifact already
  // declares its exact package entry, so resolve that contained physical path
  // directly instead of asking the embedded Bun runtime to resolve a package.
  const packageRoot = join(
    resolveCliRuntimeRootPath(),
    'node_modules',
    ...bundledPackageNameSegments(packageName),
  );
  const normalizedEntryRelativePath = PortableRelativePathSchema.parse(packageEntryRelativePath);
  await assertContainedRegularFile(
    packageRoot,
    'package.json',
    'Bundled plugin package metadata',
  );
  let packageMetadata: unknown;
  try {
    packageMetadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    throw new Error(`Bundled plugin package metadata is invalid for '${packageName}'`);
  }
  const parsedPackageMetadata = z.object({ name: z.string() }).passthrough().safeParse(packageMetadata);
  if (!parsedPackageMetadata.success || parsedPackageMetadata.data.name !== packageName) {
    throw new Error(`Bundled plugin package metadata name mismatch for '${packageName}'`);
  }
  return join(packageRoot, ...normalizedEntryRelativePath.split('/'));
}

async function admitBundledImmutablePluginGeneration(input: Readonly<{
  paths: PluginStorePaths;
  artifact: BundledImmutablePluginArtifact;
  resolvePackageEntry: (
    packageName: string,
    packageEntryRelativePath: string,
  ) => Promise<string>;
}>): Promise<CurrentCommittedPluginGeneration> {
  const artifact = Object.freeze({
    ...input.artifact,
    packageEntryRelativePath: PortableRelativePathSchema.parse(
      input.artifact.packageEntryRelativePath,
    ),
    record: ImmutablePluginGenerationRecordSchema.parse({
      ...input.artifact.record,
      sourceProvenance: pluginSourceProvenanceForKind('bundled'),
    }),
  });
  try {
    const prepared = await readPreparedImmutablePluginGeneration({
      paths: input.paths,
      immutableGenerationId: artifact.record.immutableGenerationId,
    });
    if (
      prepared.record.pluginId !== artifact.record.pluginId
      || !isDeepStrictEqual(prepared.record, artifact.record)
    ) {
      throw new Error(
        `Bundled plugin generation custody mismatch for '${artifact.record.pluginId}'`,
      );
    }
    return Object.freeze({
      pluginId: artifact.record.pluginId,
      immutableGenerationId: artifact.record.immutableGenerationId,
      rootPath: prepared.rootPath,
      record: prepared.record,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
  const lexicalEntryPath = resolve(await input.resolvePackageEntry(
    artifact.packageName,
    artifact.packageEntryRelativePath,
  ));
  const entrySegments = artifact.packageEntryRelativePath.split('/');
  let lexicalRootPath = lexicalEntryPath;
  for (let index = 0; index < entrySegments.length; index += 1) lexicalRootPath = dirname(lexicalRootPath);
  await assertContainedRegularFile(
    lexicalRootPath,
    artifact.record.manifestRelativePath,
    'Bundled plugin manifest',
  );
  await assertContainedRegularFile(
    lexicalRootPath,
    artifact.packageEntryRelativePath,
    'Bundled plugin package entry',
  );
  const entryPath = await realpath(lexicalEntryPath);
  const rootPath = await realpath(lexicalRootPath);
  const actualRelativeEntry = relative(rootPath, entryPath);
  if (
    entryPath === rootPath
    || !isCanonicalAbsolutePathInsideRoot(rootPath, entryPath)
    || actualRelativeEntry.split(sep).join('/') !== artifact.packageEntryRelativePath
  ) {
    throw new Error(`Bundled plugin package entry identity mismatch for '${artifact.record.pluginId}'`);
  }
  if (!artifact.record.files.some((file) => file.relativePath === artifact.packageEntryRelativePath)) {
    throw new Error(`Bundled plugin package entry is absent from immutable inventory for '${artifact.record.pluginId}'`);
  }
  const daemonEntryRelativePath = artifact.daemonEntryRelativePath ?? null;
  if (daemonEntryRelativePath !== null) {
    await assertContainedRegularFile(
      lexicalRootPath,
      daemonEntryRelativePath,
      'Bundled plugin daemon entry',
    );
    if (!artifact.record.files.some((file) => file.relativePath === daemonEntryRelativePath)) {
      throw new Error(`Bundled plugin daemon entry is absent from immutable inventory for '${artifact.record.pluginId}'`);
    }
  }
  const prepared = await prepareImmutablePluginGeneration({
    paths: input.paths,
    sourceRootPath: rootPath,
    record: artifact.record,
  });
  return Object.freeze({
    pluginId: artifact.record.pluginId,
    immutableGenerationId: artifact.record.immutableGenerationId,
    rootPath: prepared.rootPath,
    record: prepared.record,
  });
}

/**
 * Joins the sole durable installed-current record and generated bundled
 * artifact identities to their structurally admitted immutable generations.
 * The installed record is re-read after admission so callers never receive a
 * generation set assembled across a concurrent execution-authority
 * replacement. Ordinary currentness subsequently compares only durable
 * execution authority; it does not re-walk or hash admitted generation roots.
 */
export async function readCurrentCommittedPluginGenerations(
  paths: PluginStorePaths,
  options?: Readonly<{
    bundledArtifacts?: readonly BundledImmutablePluginArtifact[];
    resolveBundledPackageEntry?: (
      packageName: string,
      packageEntryRelativePath: string,
    ) => Promise<string>;
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
    ? await readPluginRegistryCommitInstallationAuthority(paths, commit)
    : null;
  const executionAuthority = commit && installationState
    ? pluginExecutionAuthority(commit, installationState)
    : null;
  for (const [pluginId, reference] of Object.entries(commit?.pluginGenerations ?? {})) {
    try {
      await assertGenerationNotRetired(paths, reference.immutableGenerationId);
      const generationRootPath = join(paths.generationsDir, reference.immutableGenerationId);
      const record = await readGenerationRecord(
        join(generationRootPath, 'plugin-generation.v1.json'),
      );
      if (record.pluginId !== pluginId || record.immutableGenerationId !== reference.immutableGenerationId) {
        throw new Error(`Committed plugin generation identity mismatch for '${pluginId}'`);
      }
      const installation = installationState?.plugins[pluginId];
      if (!installation) throw new Error(`Committed plugin generation is missing installation authority for '${pluginId}'`);
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
    } catch (error) {
      if (!options?.isolateInvalidInstalledGenerations) throw error;
      rejectedGenerations.set(pluginId, Object.freeze({
        pluginId,
        immutableGenerationId: reference.immutableGenerationId,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const unavailableBundledPackageNames = new Set<string>();
  for (const artifact of bundledArtifacts) {
    let admitted: CurrentCommittedPluginGeneration;
    try {
      await assertGenerationNotRetired(paths, artifact.record.immutableGenerationId);
      admitted = await admitBundledImmutablePluginGeneration({
        paths,
        artifact,
        resolvePackageEntry: options?.resolveBundledPackageEntry ?? resolveBundledPackageEntry,
      });
    } catch (error) {
      unavailableBundledPackageNames.add(artifact.packageName);
      // Keep the reason with its plugin so the host can report which bundled
      // plugin was quarantined and why, instead of discarding it here. An
      // already-admitted plugin keeps its admission: a superseded bundled
      // artifact must not retract a generation this runtime accepted.
      const bundledPluginId = artifact.record.pluginId;
      if (!generations.has(bundledPluginId) && !rejectedGenerations.has(bundledPluginId)) {
        rejectedGenerations.set(bundledPluginId, Object.freeze({
          pluginId: bundledPluginId,
          immutableGenerationId: artifact.record.immutableGenerationId,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      continue;
    }
    if (generations.has(admitted.pluginId)) {
      throw new Error(`Plugin generation authority collision for '${admitted.pluginId}'`);
    }
    generations.set(admitted.pluginId, admitted);
  }

  let after = await readPluginRegistryCommitRecord(paths);
  while (!pluginRegistryCommitRecordsEqual(after, commit)) {
    if (!after || !executionAuthority) {
      throw new Error('Plugin registry execution authority changed while resolving immutable generations');
    }
    const afterInstallationState = await readPluginRegistryCommitInstallationAuthority(paths, after);
    if (!afterInstallationState) {
      throw new Error('Plugin registry execution authority changed while resolving immutable generations');
    }
    const confirmedAfter = await readPluginRegistryCommitRecord(paths);
    if (!pluginRegistryCommitRecordsEqual(confirmedAfter, after)) {
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
        for (const generation of generations.values()) {
          await assertGenerationNotRetired(paths, generation.immutableGenerationId);
        }
        if (commit && installationState) {
          if (!current) return false;
          const currentInstallationState = await readPluginRegistryCommitInstallationAuthority(
            paths,
            current,
          );
          if (!currentInstallationState) return false;
          if (!isDeepStrictEqual(
            pluginExecutionAuthority(current, currentInstallationState),
            executionAuthority,
          )) return false;
        } else if (current) {
          return false;
        }
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
    && parsed.installationState.revisionId === 'state-0';
  const state = isEmptyBootstrap
    ? null
    : await readInstallationStateRevision({
        paths,
        reference: parsed.installationState,
        commit,
      });
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
  const state = await readPluginRegistryCommitInstallationAuthority(paths, commit);
  for (const [pluginId, reference] of Object.entries(parsed.pluginGenerations)) {
    // An unchanged-reference allowance can preserve unrelated corrupt/missing
    // bytes across a transaction, but it cannot republish an identity that
    // this store has already retired.
    await assertGenerationNotRetired(paths, reference.immutableGenerationId);
    try {
      const rootPath = join(paths.generationsDir, reference.immutableGenerationId);
      const record = await readGenerationRecord(
        join(rootPath, 'plugin-generation.v1.json'),
      );
      if (record.pluginId !== pluginId || record.immutableGenerationId !== reference.immutableGenerationId) {
        throw new Error(`Plugin registry commit generation identity mismatch for '${pluginId}'`);
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

export function collectPluginGenerationStagingAncestorDirectories(
  stagingRoot: string,
  destinationDirectory: string,
): readonly string[] {
  const directories: string[] = [];
  let directory = destinationDirectory;
  while (true) {
    directories.push(directory);
    if (directory === stagingRoot) return directories;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('Generation staging directory escaped its immutable root');
    }
    directory = parent;
  }
}

async function prepareImmutablePluginGenerationWithReuse(input: Readonly<{
  paths: PluginStorePaths;
  sourceRootPath: string;
  record: ImmutablePluginGenerationRecord;
  generatedManifestContents?: string;
  flushDirectory?: (path: string) => Promise<void>;
  reuseUnchangedFilesFrom?: Readonly<{
    rootPath: string;
    record: ImmutablePluginGenerationRecord;
    sourceFileRelativePaths: ReadonlySet<string>;
  }>;
}>): Promise<PreparedImmutablePluginGeneration> {
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
      }),
      materialization: Object.freeze({
        copiedFileCount: 0,
        copiedByteCount: 0,
        reusedFileCount: record.files.length,
      }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }

  const sourceRootPath = await realpath(input.sourceRootPath);
  await mkdir(input.paths.generationsDir, { recursive: true });
  const stagingRoot = join(input.paths.generationsDir, `.staging-${record.immutableGenerationId}-${process.pid}-${randomUUID()}`);
  let copiedFileCount = 0;
  let copiedByteCount = 0;
  let reusedFileCount = 0;
  try {
    await mkdir(stagingRoot, { recursive: true });
    const stagedDirectories = new Set<string>([stagingRoot]);
    const reusableFiles = input.reuseUnchangedFilesFrom
      ? new Map(input.reuseUnchangedFilesFrom.record.files.map((file) => [file.relativePath, file]))
      : null;
    for (const file of record.files) {
      const destination = join(stagingRoot, ...file.relativePath.split('/'));
      const destinationDirectory = dirname(destination);
      if (!stagedDirectories.has(destinationDirectory)) {
        await mkdir(destinationDirectory, { recursive: true });
        for (const directory of collectPluginGenerationStagingAncestorDirectories(
          stagingRoot,
          destinationDirectory,
        )) {
          stagedDirectories.add(directory);
        }
      }
      const reusableFile = reusableFiles?.get(file.relativePath);
      const canReuse = input.reuseUnchangedFilesFrom !== undefined
        && !input.reuseUnchangedFilesFrom.sourceFileRelativePaths.has(file.relativePath)
        && reusableFile?.byteLength === file.byteLength;
      if (canReuse) {
        reusedFileCount += 1;
      }
      if (
        input.generatedManifestContents !== undefined
        && file.relativePath === record.manifestRelativePath
      ) {
        const bytes = Buffer.from(input.generatedManifestContents, 'utf8');
        if (bytes.byteLength !== file.byteLength) {
          throw new Error('Host-generated plugin manifest differs from its structural materialization record');
        }
        await writeFile(destination, bytes);
      } else {
        const sourceRoot = canReuse
          ? input.reuseUnchangedFilesFrom!.rootPath
          : sourceRootPath;
        const source = join(sourceRoot, ...file.relativePath.split('/'));
        await assertContainedRegularFile(
          sourceRoot,
          file.relativePath,
          'Immutable plugin generation materialization source',
          {
            expectedByteLength: file.byteLength,
            ...(canReuse ? { requireExclusiveInode: true } : {}),
          },
        );
        await copyOwnedPluginGenerationFile(source, destination);
      }
      copiedFileCount += 1;
      copiedByteCount += file.byteLength;
      await assertContainedRegularFile(
        stagingRoot,
        file.relativePath,
        'Immutable plugin generation materialization destination',
        { expectedByteLength: file.byteLength, requireExclusiveInode: true },
      );
      await flushFileDurably(destination);
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
      }),
      materialization: Object.freeze({
        copiedFileCount,
        copiedByteCount,
        reusedFileCount,
      }),
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function prepareImmutablePluginGeneration(input: Readonly<{
  paths: PluginStorePaths;
  sourceRootPath: string;
  record: ImmutablePluginGenerationRecord;
  generatedManifestContents?: string;
  flushDirectory?: (path: string) => Promise<void>;
}>): Promise<PreparedImmutablePluginGeneration> {
  return await prepareImmutablePluginGenerationWithReuse(input);
}

export async function prepareOwnedImmutablePluginGeneration(input: Readonly<{
  paths: PluginStorePaths;
  pluginId: string;
  sourceRootPath: string;
  manifestRelativePath: string;
  distribution: z.input<typeof PluginDistributionIdentitySchema>;
  updatePolicy: z.input<typeof PluginUpdatePolicySchema>;
  createdAtMs: number;
  immutableGenerationId?: string;
  singleFileRelativePath?: string;
  generatedManifestContents?: string;
  flushDirectory?: (path: string) => Promise<void>;
}>): Promise<OwnedPreparedImmutablePluginGeneration> {
  const record = await createImmutablePluginGenerationRecordFromSource({
    pluginId: input.pluginId,
    sourceRootPath: input.sourceRootPath,
    manifestRelativePath: input.manifestRelativePath,
    distribution: input.distribution,
    updatePolicy: input.updatePolicy,
    createdAtMs: input.createdAtMs,
    ...(input.immutableGenerationId ? { immutableGenerationId: input.immutableGenerationId } : {}),
    ...(input.singleFileRelativePath
      ? { singleFileRelativePath: input.singleFileRelativePath }
      : {}),
    ...(input.generatedManifestContents !== undefined
      ? { generatedManifestContents: input.generatedManifestContents }
      : {}),
  });
  const rootPath = join(input.paths.generationsDir, record.immutableGenerationId);
  try {
    await lstat(rootPath);
    throw new Error(
      `Owned immutable plugin generation '${record.immutableGenerationId}' already exists`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
  const custody = retainProcessLocalPreparedPluginGeneration(
    input.paths,
    record.immutableGenerationId,
  );
  let ownershipTransferred = false;
  try {
    const prepared = await prepareImmutablePluginGeneration({
      paths: input.paths,
      sourceRootPath: input.sourceRootPath,
      record,
      ...(input.generatedManifestContents !== undefined
        ? { generatedManifestContents: input.generatedManifestContents }
        : {}),
      ...(input.flushDirectory ? { flushDirectory: input.flushDirectory } : {}),
    });
    if (!prepared.materialization || prepared.materialization.copiedFileCount === 0) {
      throw new Error(
        `Owned immutable plugin generation '${record.immutableGenerationId}' was not newly materialized`,
      );
    }
    let adopted = false;
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      try {
        if (!adopted) {
          await rm(prepared.rootPath, { recursive: true, force: true });
          await flushDirectoryDurablyDefault(input.paths.generationsDir);
        }
      } finally {
        custody.release();
      }
    };
    ownershipTransferred = true;
    return createOwnedPreparedImmutablePluginGenerationHandle({
      rootPath: prepared.rootPath,
      record,
      adopt() {
        if (cleaned) {
          throw new Error(
            `Owned immutable plugin generation '${record.immutableGenerationId}' is already cleaned`,
          );
        }
        adopted = true;
      },
      cleanup,
    });
  } finally {
    if (!ownershipTransferred) custody.release();
  }
}

function normalizeDevelopmentChangedPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/u, '');
  if (!normalized || normalized === '.') {
    throw new Error('Development generation changes must name a path below the plugin root');
  }
  return PortableRelativePathSchema.parse(normalized);
}

async function readDevelopmentChangedSourceFiles(input: Readonly<{
  sourceRootPath: string;
  changedPaths: readonly string[];
  priorFiles: readonly ImmutablePluginGenerationFile[];
}>): Promise<Readonly<{
  files: readonly ImmutablePluginGenerationFile[];
  sourceFileRelativePaths: ReadonlySet<string>;
}>> {
  const rootPath = await realpath(input.sourceRootPath);
  const files = new Map(input.priorFiles.map((file) => [file.relativePath, file]));
  const sourceFileRelativePaths = new Set<string>();
  const changedPaths = [...new Set(input.changedPaths.map(normalizeDevelopmentChangedPath))].sort();
  if (changedPaths.length === 0) {
    throw new Error('Development generation changes require at least one observed path');
  }

  for (const changedPath of changedPaths) {
    for (const relativePath of files.keys()) {
      if (relativePath === changedPath || relativePath.startsWith(`${changedPath}/`)) {
        files.delete(relativePath);
      }
    }

    const changedSegments = changedPath.split('/');
    let changedSourcePath = rootPath;
    let changedSourceMetadata: Awaited<ReturnType<typeof lstat>> | null = null;
    let missing = false;
    for (const segment of changedSegments) {
      changedSourcePath = join(changedSourcePath, segment);
      try {
        changedSourceMetadata = await lstat(changedSourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          missing = true;
          break;
        }
        throw error;
      }
      if (changedSourceMetadata.isSymbolicLink()) {
        throw new Error(`Immutable plugin generation source contains a symbolic link: ${changedPath}`);
      }
    }
    if (missing) continue;
    if (!changedSourceMetadata) throw new Error(`Development generation change is unavailable: ${changedPath}`);

    const pending = changedSourceMetadata.isDirectory()
      ? [changedPath]
      : [];
    if (!changedSourceMetadata.isDirectory()) {
      if (!changedSourceMetadata.isFile()) {
        throw new Error(`Immutable plugin generation source contains a non-file entry: ${changedPath}`);
      }
      const file = Object.freeze({
        relativePath: changedPath,
        byteLength: changedSourceMetadata.size,
      });
      files.set(changedPath, file);
      sourceFileRelativePaths.add(changedPath);
    }

    while (pending.length > 0) {
      const relativeDirectory = pending.pop()!;
      const directoryPath = join(rootPath, ...relativeDirectory.split('/'));
      const entries = await readdir(directoryPath, { withFileTypes: true, encoding: 'utf8' });
      for (const entry of entries) {
        const relativePath = PortableRelativePathSchema.parse(`${relativeDirectory}/${entry.name}`);
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
        files.set(relativePath, Object.freeze({
          relativePath,
          byteLength: metadata.size,
        }));
        sourceFileRelativePaths.add(relativePath);
      }
    }
  }

  return Object.freeze({
    files: Object.freeze([...files.values()]),
    sourceFileRelativePaths,
  });
}

export type OwnedPluginDevelopmentGenerationDraft = Readonly<{
  rootPath: string;
  immutableGenerationId: string;
  runWithIntegrityFence: <T>(operation: () => Promise<T>) => Promise<T>;
  finalize: (input: Readonly<{
    pluginId: string;
    manifestRelativePath: string;
    generatedManifestContents: string;
    distribution: z.input<typeof PluginDistributionIdentitySchema>;
    updatePolicy: z.input<typeof PluginUpdatePolicySchema>;
    createdAtMs: number;
  }>) => Promise<OwnedPreparedPluginDevelopmentGeneration>;
  cleanup: () => Promise<void>;
}>;

async function readOwnedDevelopmentGenerationDraftStructure(
  rootPath: string,
): Promise<readonly Readonly<{ relativePath: string; byteLength: number }>[]> {
  const files: Array<Readonly<{ relativePath: string; byteLength: number }>> = [];
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!;
    const directoryPath = relativeDirectory
      ? join(rootPath, ...relativeDirectory.split('/'))
      : rootPath;
    const entries = await readdir(directoryPath, { withFileTypes: true, encoding: 'utf8' });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const path = join(directoryPath, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Owned development generation contains a symbolic link: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Owned development generation contains a non-file entry: ${relativePath}`);
      }
      if (metadata.nlink > 1) {
        throw new Error(`Owned development generation contains a writable inode alias: ${relativePath}`);
      }
      files.push({ relativePath, byteLength: metadata.size });
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return Object.freeze(files);
}

async function createOwnedDevelopmentGenerationDraft(input: Readonly<{
  paths: PluginStorePaths;
  immutableGenerationId?: string;
  populate: (rootPath: string) => Promise<void>;
}>): Promise<OwnedPluginDevelopmentGenerationDraft> {
  const immutableGenerationId = PortableStorageIdSchema.parse(
    input.immutableGenerationId ?? `gen-${Date.now()}-${randomUUID()}`,
  );
  await assertGenerationNotRetired(input.paths, immutableGenerationId);
  await mkdir(input.paths.generationsDir, { recursive: true });
  const rootPath = join(input.paths.generationsDir, immutableGenerationId);
  const custody = retainProcessLocalPreparedPluginGeneration(
    input.paths,
    immutableGenerationId,
  );
  let finalized = false;
  let adopted = false;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (!adopted) await rm(rootPath, { recursive: true, force: true });
    custody.release();
  };
  try {
    await mkdir(rootPath);
    const draftMarkerPath = join(rootPath, OWNED_DEVELOPMENT_DRAFT_FILE_NAME);
    await writeJsonAtomic(draftMarkerPath, OwnedDevelopmentDraftSchema.parse({
      t: 'happier_owned_plugin_development_draft_v1',
      schemaVersion: 1,
      immutableGenerationId,
    }));
    await flushFileDurably(draftMarkerPath);
    await flushDirectoryDurablyDefault(rootPath);
    await flushDirectoryDurablyDefault(input.paths.generationsDir);
    await input.populate(rootPath);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return Object.freeze({
    rootPath,
    immutableGenerationId,
    async runWithIntegrityFence<T>(operation: () => Promise<T>): Promise<T> {
      if (cleaned || finalized) {
        throw new Error(`Development generation '${immutableGenerationId}' is not mutable draft custody`);
      }
      const before = await readOwnedDevelopmentGenerationDraftStructure(rootPath);
      const result = await operation();
      if (!isDeepStrictEqual(
        await readOwnedDevelopmentGenerationDraftStructure(rootPath),
        before,
      )) {
        throw new Error('Owned plugin development generation changed during evaluation');
      }
      return result;
    },
    async finalize(finalizeInput) {
      if (finalized) throw new Error(`Development generation '${immutableGenerationId}' is already finalized`);
      if (cleaned) throw new Error(`Development generation '${immutableGenerationId}' is no longer owned`);
      const manifestRelativePath = PortableRelativePathSchema.parse(
        finalizeInput.manifestRelativePath.replaceAll('\\', '/'),
      );
      const manifestPath = join(rootPath, ...manifestRelativePath.split('/'));
      try {
        await lstat(manifestPath);
        throw new Error('Host-generated plugin manifest collides with an author source file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
      }
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, finalizeInput.generatedManifestContents, 'utf8');
      const record = await createImmutablePluginGenerationRecordFromSource({
        pluginId: finalizeInput.pluginId,
        sourceRootPath: rootPath,
        manifestRelativePath,
        distribution: finalizeInput.distribution,
        updatePolicy: finalizeInput.updatePolicy,
        createdAtMs: finalizeInput.createdAtMs,
        immutableGenerationId,
        excludeOwnedDevelopmentDraftMarker: true,
      });
      for (const file of record.files) {
        await assertContainedRegularFile(
          rootPath,
          file.relativePath,
          'Owned development generation materialization file',
          { expectedByteLength: file.byteLength, requireExclusiveInode: true },
        );
        await flushFileDurably(join(rootPath, ...file.relativePath.split('/')));
      }
      const generationRecordPath = join(rootPath, 'plugin-generation.v1.json');
      await writeJsonAtomic(generationRecordPath, record);
      await flushFileDurably(generationRecordPath);
      await rm(join(rootPath, OWNED_DEVELOPMENT_DRAFT_FILE_NAME));
      await flushDirectoryDurablyDefault(rootPath);
      await flushDirectoryDurablyDefault(input.paths.generationsDir);
      await verifyPersistedGeneration(rootPath, record);
      finalized = true;
      return createOwnedPreparedImmutablePluginGenerationHandle({
        rootPath,
        record,
        adopt() {
          adopted = true;
        },
        cleanup,
      });
    },
    cleanup,
  });
}

export async function prepareOwnedPluginDevelopmentGeneration(input: Readonly<{
  paths: PluginStorePaths;
  populate: (rootPath: string) => Promise<void>;
}>): Promise<OwnedPluginDevelopmentGenerationDraft> {
  return await createOwnedDevelopmentGenerationDraft(input);
}

export async function prepareOwnedPluginDevelopmentGenerationFromEdit(input: Readonly<{
  paths: PluginStorePaths;
  sourceRootPath: string;
  changedPaths: readonly string[];
  priorReference: PluginRegistryGenerationReference;
  generatedManifestRelativePath: string;
}>): Promise<OwnedPluginDevelopmentGenerationDraft> {
  const sourceRootPath = await realpath(input.sourceRootPath);
  const priorReference = PluginRegistryGenerationReferenceSchema.parse(input.priorReference);
  await assertGenerationNotRetired(input.paths, priorReference.immutableGenerationId);
  const priorRootPath = join(input.paths.generationsDir, priorReference.immutableGenerationId);
  const priorRecord = await readGenerationRecord(
    join(priorRootPath, 'plugin-generation.v1.json'),
  );
  if (
    priorRecord.immutableGenerationId !== priorReference.immutableGenerationId
  ) {
    throw new Error('Development generation base identity mismatch');
  }
  const changed = await readDevelopmentChangedSourceFiles({
    sourceRootPath,
    changedPaths: input.changedPaths,
    priorFiles: priorRecord.files,
  });
  const generatedManifestRelativePath = PortableRelativePathSchema.parse(
    input.generatedManifestRelativePath.replaceAll('\\', '/'),
  );
  return await createOwnedDevelopmentGenerationDraft({
    paths: input.paths,
    populate: async (rootPath) => {
      const directories = new Set<string>([rootPath]);
      for (const file of changed.files) {
        if (file.relativePath === generatedManifestRelativePath) continue;
        const destination = join(rootPath, ...file.relativePath.split('/'));
        const destinationDirectory = dirname(destination);
        if (!directories.has(destinationDirectory)) {
          await mkdir(destinationDirectory, { recursive: true });
          directories.add(destinationDirectory);
        }
        if (changed.sourceFileRelativePaths.has(file.relativePath)) {
          const source = join(sourceRootPath, ...file.relativePath.split('/'));
          await assertContainedRegularFile(
            sourceRootPath,
            file.relativePath,
            'Owned development generation edit source',
            { expectedByteLength: file.byteLength },
          );
          await copyOwnedPluginGenerationFile(source, destination);
        } else {
          await copyOwnedPluginGenerationFile(
            join(priorRootPath, ...file.relativePath.split('/')),
            destination,
          );
        }
        await assertContainedRegularFile(
          rootPath,
          file.relativePath,
          'Owned development generation edit destination',
          { expectedByteLength: file.byteLength, requireExclusiveInode: true },
        );
      }
    },
  });
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
  const record = await readGenerationRecord(
    join(rootPath, 'plugin-generation.v1.json'),
  );
  if (record.immutableGenerationId !== immutableGenerationId) {
    throw new Error(`Immutable generation identity mismatch for '${immutableGenerationId}'`);
  }
  await verifyPersistedGeneration(rootPath, record);
  return Object.freeze({
    rootPath,
    record,
    reference: PluginRegistryGenerationReferenceSchema.parse({
      immutableGenerationId,
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
  const reference = Object.freeze({ revisionId: state.revisionId });
  try {
    const existing = await readFile(path, 'utf8');
    if (JSON.stringify(JSON.parse(existing)) !== JSON.stringify(state)) {
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
  commit?: PluginRegistryCommitRecord;
}>): Promise<PluginInstallationStateRevision> {
  if (
    input.commit
    && input.commit.installationState.revisionId !== input.reference.revisionId
  ) {
    throw new Error('Installation state reference does not match its registry commit');
  }
  const raw = await readFile(
    stateRevisionPath(input.paths, input.reference.revisionId),
    'utf8',
  );
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('Invalid installation state revision', { cause: error });
  }
  const parsed = PluginInstallationStateRevisionSchema.safeParse(value);
  if (!parsed.success || parsed.data.revisionId !== input.reference.revisionId) {
    throw new Error('Invalid installation state revision');
  }
  return parsed.data;
}

export function resolvePluginHardRevocationRevision(
  state: PluginInstallationStateRevision,
  pluginId: string,
): number {
  const canonicalPluginId = PluginIdSchema.parse(pluginId);
  return state.hardRevocationRevisions?.[canonicalPluginId] ?? 0;
}

export async function readCurrentPluginHardRevocationRevision(input: Readonly<{
  paths: PluginStorePaths;
  pluginId: string;
}>): Promise<number> {
  const pluginId = PluginIdSchema.parse(input.pluginId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await readPluginRegistryCommitRecord(input.paths);
    if (!before) return 0;
    const state = await readPluginRegistryCommitInstallationAuthority(input.paths, before);
    const after = await readPluginRegistryCommitRecord(input.paths);
    if (pluginRegistryCommitRecordsEqual(after, before)) {
      return state ? resolvePluginHardRevocationRevision(state, pluginId) : 0;
    }
  }
  throw new Error(
    `Plugin '${pluginId}' hard-revocation currentness changed during read`,
  );
}

async function readCurrentPluginBundledAuthorityBarriers(input: Readonly<{
  paths: PluginStorePaths;
  pluginId: string;
  immutableGenerationId: string;
}>): Promise<Readonly<{
  installedAuthorityPresent: boolean;
}>> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await readPluginRegistryCommitRecord(input.paths);
    if (!before) {
      if (!await readPluginRegistryCommitRecord(input.paths)) {
        return Object.freeze({
          installedAuthorityPresent: false,
        });
      }
      continue;
    }
    const state = await readPluginRegistryCommitInstallationAuthority(input.paths, before);
    const after = await readPluginRegistryCommitRecord(input.paths);
    if (pluginRegistryCommitRecordsEqual(after, before)) {
      return Object.freeze({
        installedAuthorityPresent: Boolean(
          before.pluginGenerations[input.pluginId]
          || state?.plugins[input.pluginId],
        ),
      });
    }
  }
  throw new Error(
    `Plugin '${input.pluginId}' bundled authority barriers changed during read`,
  );
}

export async function readCurrentPluginImmutableGenerationIntegrityCurrentness(
  input: Readonly<{
    paths: PluginStorePaths;
    pluginId: string;
    immutableGenerationId: string;
    bundledArtifacts?: readonly BundledImmutablePluginArtifact[];
    retainedManifestAuthority?: 'external' | 'bundled_first_party';
    requiredAgentSessionRunnerFactoryLocalAgentId?: string;
    resolveBundledPackageEntry?: (
      packageName: string,
      packageEntryRelativePath: string,
    ) => Promise<string>;
  }>,
): Promise<boolean> {
  const pluginId = PluginIdSchema.parse(input.pluginId);
  const immutableGenerationId = PortableStorageIdSchema.parse(
    input.immutableGenerationId,
  );
  try {
    await assertGenerationNotRetired(input.paths, immutableGenerationId);
  } catch {
    return false;
  }
  const bundledArtifacts = (input.bundledArtifacts ?? []).filter(
    (artifact) => artifact.record.pluginId === pluginId,
  );
  const requiredAgentSessionRunnerFactoryLocalAgentId =
    input.requiredAgentSessionRunnerFactoryLocalAgentId?.trim();
  let retainedManifestAuthority = input.retainedManifestAuthority;
  if (bundledArtifacts.length > 1) return false;
  const exactBundledArtifact = resolveBundledImmutablePluginArtifact({
    bundledArtifacts,
    pluginId,
    immutableGenerationId,
  });
  if (exactBundledArtifact) {
    if (retainedManifestAuthority === 'external') return false;
    try {
      const beforeBarriers = await readCurrentPluginBundledAuthorityBarriers({
        paths: input.paths,
        pluginId,
        immutableGenerationId,
      });
      if (beforeBarriers.installedAuthorityPresent) return false;
      const generation = await admitBundledImmutablePluginGeneration({
        paths: input.paths,
        artifact: exactBundledArtifact,
        resolvePackageEntry:
          input.resolveBundledPackageEntry
          ?? resolveBundledPackageEntry,
      });
      // Runner custody is generation-store based. Copy the already admitted
      // generated bundle into that one immutable owner before publishing or
      // retaining runner authority, then recheck the generated source bytes.
      const prepared = await prepareImmutablePluginGeneration({
        paths: input.paths,
        sourceRootPath: generation.rootPath,
        record: generation.record,
      });
      if (
        generation.record.pluginId !== pluginId
        || prepared.reference.immutableGenerationId
          !== immutableGenerationId
      ) {
        return false;
      }
      const afterBarriers = await readCurrentPluginBundledAuthorityBarriers({
        paths: input.paths,
        pluginId,
        immutableGenerationId,
      });
      return !afterBarriers.installedAuthorityPresent;
    } catch {
      return false;
    }
  }

  if (requiredAgentSessionRunnerFactoryLocalAgentId) {
    try {
      const prepared = await readPreparedImmutablePluginGeneration({
        paths: input.paths,
        immutableGenerationId,
      });
      if (prepared.record.pluginId !== pluginId) return false;
      const factories = await readValidatedAgentSessionRunnerFactories({
        paths: input.paths,
        record: prepared.record,
      });
      if (!factories.factories.some((factory) =>
        factory.localAgentId
          === requiredAgentSessionRunnerFactoryLocalAgentId)) {
        return false;
      }
      if (
        retainedManifestAuthority !== undefined
        && retainedManifestAuthority !== factories.manifestAuthority
      ) {
        return false;
      }
      retainedManifestAuthority = factories.manifestAuthority;
    } catch {
      return false;
    }
  }
  if (
    retainedManifestAuthority === 'bundled_first_party'
  ) {
    try {
      const beforeBarriers = await readCurrentPluginBundledAuthorityBarriers({
        paths: input.paths,
        pluginId,
        immutableGenerationId,
      });
      if (beforeBarriers.installedAuthorityPresent) return false;
      const prepared = await readPreparedImmutablePluginGeneration({
        paths: input.paths,
        immutableGenerationId,
      });
      if (prepared.record.pluginId !== pluginId) return false;
      const afterBarriers = await readCurrentPluginBundledAuthorityBarriers({
        paths: input.paths,
        pluginId,
        immutableGenerationId,
      });
      return !afterBarriers.installedAuthorityPresent;
    } catch {
      return false;
    }
  }

  // A known bundle for this plugin with a different generation is an explicit
  // replacement, not permission to fall through to same-id installed bytes.
  if (
    bundledArtifacts.length > 0
    && retainedManifestAuthority !== 'external'
  ) return false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await readPluginRegistryCommitRecord(input.paths);
    if (!before) return false;
    const state = await readPluginRegistryCommitInstallationAuthority(input.paths, before);
    const after = await readPluginRegistryCommitRecord(input.paths);
    if (pluginRegistryCommitRecordsEqual(after, before)) {
      if (!state?.plugins[pluginId]) return false;
      try {
        const prepared = await readPreparedImmutablePluginGeneration({
          paths: input.paths,
          immutableGenerationId,
        });
        if (prepared.record.pluginId !== pluginId) return false;
      } catch {
        return false;
      }
      const confirmed = await readPluginRegistryCommitRecord(input.paths);
      if (pluginRegistryCommitRecordsEqual(confirmed, before)) {
        return true;
      }
    }
  }
  throw new Error(
    `Plugin '${pluginId}' immutable generation integrity currentness changed during read`,
  );
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
  runnerRetainedGenerationIds?: ReadonlySet<string>;
  readRunnerRetainedGenerationIds?: () => Promise<ReadonlySet<string>>;
}>): Promise<Readonly<{
  referenced: readonly string[];
  retained: readonly string[];
  removed: readonly string[];
  failures: readonly Readonly<{ generationId: string | null; message: string }>[];
}>> {
  const commit = PluginRegistryCommitRecordSchema.parse(input.commit);
  const state = PluginInstallationStateRevisionSchema.parse(input.state);
  if (state.revisionId !== commit.installationState.revisionId) {
    throw new Error('Cleanup installation state revision does not match the durable registry commit');
  }
  for (const [pluginId, generation] of Object.entries(commit.pluginGenerations)) {
    const plugin = state.plugins[pluginId];
    if (!plugin) {
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
  const referenced = [...new Set(Object.values(commit.pluginGenerations).map((entry) => entry.immutableGenerationId))].sort();
  const runnerRetainedGenerationIds = input.readRunnerRetainedGenerationIds
    ? await input.readRunnerRetainedGenerationIds()
    : input.runnerRetainedGenerationIds ?? new Set<string>();
  const retained = [...new Set([
    ...state.rollbackRetention
    .filter((entry) => entry.byteAvailability === 'available' && !referenced.includes(entry.immutableGenerationId))
    .map((entry) => entry.immutableGenerationId),
    ...[...runnerRetainedGenerationIds]
      .filter((generationId) => !referenced.includes(generationId)),
  ])].sort();
  const live = new Set([...referenced, ...retained]);
  const entries = await readdir(input.paths.generationsDir, { withFileTypes: true, encoding: 'utf8' }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!entries) return { referenced, retained, removed: [], failures: [] };
  const obsoleteGenerations = new Map<string, { canonicalName?: string; retiringName?: string }>();
  let foundInvalidObsoleteGenerationDirectory = false;
  for (const entry of entries) {
    // Completed-retirement markers are owner metadata, never generation roots.
    if (isRetiredPluginGenerationMarkerFileName(entry.name)) continue;
    if (!entry.isDirectory()) continue;
    const retiringGenerationId = entry.name.startsWith('.retiring-')
      ? entry.name.slice('.retiring-'.length)
      : null;
    if (!retiringGenerationId && entry.name.startsWith('.')) continue;
    const parsedGenerationId = PortableStorageIdSchema.safeParse(
      retiringGenerationId ?? entry.name,
    );
    if (!parsedGenerationId.success) {
      foundInvalidObsoleteGenerationDirectory = true;
      continue;
    }
    const generationId = parsedGenerationId.data;
    if (
      live.has(generationId)
      || isProcessLocalPreparedPluginGeneration(input.paths, generationId)
    ) continue;
    const grouped = obsoleteGenerations.get(generationId) ?? {};
    if (retiringGenerationId) grouped.retiringName = entry.name;
    else grouped.canonicalName = entry.name;
    obsoleteGenerations.set(generationId, grouped);
  }
  const removed = new Set<string>();
  const failures: Array<{ generationId: string | null; message: string }> = [];
  if (foundInvalidObsoleteGenerationDirectory) {
    failures.push({
      generationId: null,
      message: 'An obsolete plugin generation directory has an invalid storage id',
    });
  }
  const flushDirectoryDurably = input.flushDirectory ?? flushDirectoryDurablyDefault;
  for (const [generationId, grouped] of [...obsoleteGenerations.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    try {
      let generationRoot = join(input.paths.generationsDir, grouped.retiringName ?? grouped.canonicalName!);
      const generationRootsToRemove = new Set(
        [grouped.retiringName, grouped.canonicalName]
          .filter((name): name is string => name !== undefined)
          .map((name) => join(input.paths.generationsDir, name)),
      );
      type RetirementClaim =
        | Readonly<{ claimed: false }>
        | Readonly<{
            claimed: true;
            record: ImmutablePluginGenerationRecord;
            retirementAlreadyCompleted: boolean;
          }>;
      const withCommitFence = input.withCommitFence ?? (async <T>(operation: () => Promise<T>) => await operation());
      const retirementClaim: RetirementClaim = await withCommitFence(async (): Promise<RetirementClaim> => {
        if (input.isCommitCurrent && !await input.isCommitCurrent()) {
          throw new Error('Plugin registry commit changed before obsolete generation retirement');
        }
        const currentRunnerRetainedGenerationIds =
          input.readRunnerRetainedGenerationIds
            ? await input.readRunnerRetainedGenerationIds()
            : runnerRetainedGenerationIds;
        if (currentRunnerRetainedGenerationIds.has(generationId)) {
          if (!retained.includes(generationId)) {
            retained.push(generationId);
            retained.sort();
          }
          return { claimed: false };
        }
        const retiredMarker = await readRetiredPluginGenerationMarker(
          input.paths,
          generationId,
        );
        if (retiredMarker) {
          const record = await readGenerationRecord(
            join(generationRoot, 'plugin-generation.v1.json'),
          );
          if (
            record.pluginId !== retiredMarker.pluginId
            || record.immutableGenerationId !== retiredMarker.immutableGenerationId
            || record.immutableGenerationId !== generationId
          ) {
            throw new Error(
              `Retired generation marker identity mismatch for '${generationId}'`,
            );
          }
          await verifyPersistedGeneration(generationRoot, record);
          return {
            claimed: true,
            record,
            retirementAlreadyCompleted: true,
          };
        }
        try {
          const marker = OwnedDevelopmentDraftSchema.parse(JSON.parse(await readFile(
            join(generationRoot, OWNED_DEVELOPMENT_DRAFT_FILE_NAME),
            'utf8',
          )) as unknown);
          if (marker.immutableGenerationId !== generationId) {
            throw new Error(`Owned development draft identity mismatch for '${generationId}'`);
          }
          await rm(generationRoot, { recursive: true, force: false });
          await flushDirectoryDurably(input.paths.generationsDir);
          removed.add(generationId);
          return { claimed: false };
        } catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
        }
        const record = await readGenerationRecord(
          join(generationRoot, 'plugin-generation.v1.json'),
        );
        if (record.immutableGenerationId !== generationId) {
          throw new Error(`Obsolete generation record identity mismatch for '${generationId}'`);
        }
        await verifyPersistedGeneration(generationRoot, record);
        for (const duplicateRoot of generationRootsToRemove) {
          if (duplicateRoot === generationRoot) continue;
          const duplicateRecord = await readGenerationRecord(
            join(duplicateRoot, 'plugin-generation.v1.json'),
          );
          if (!isDeepStrictEqual(duplicateRecord, record)) {
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
        return {
          claimed: true,
          record,
          retirementAlreadyCompleted: false,
        };
      });
      if (!retirementClaim.claimed) continue;
      if (!retirementClaim.retirementAlreadyCompleted) {
        if (input.retireGeneration) {
          await input.retireGeneration({
            pluginId: retirementClaim.record.pluginId,
            immutableGenerationId: retirementClaim.record.immutableGenerationId,
          });
        }
        await persistRetiredPluginGenerationMarker({
          paths: input.paths,
          record: retirementClaim.record,
          flushDirectoryDurably,
        });
      }
      for (const root of generationRootsToRemove) {
        await rm(root, { recursive: true, force: false });
      }
      await rm(
        validatedAgentSessionRunnerFactoriesRecordPath(input.paths, generationId),
        { force: true },
      );
      await flushDirectoryDurably(input.paths.generationsDir);
      removed.add(generationId);
    } catch (error) {
      failures.push({ generationId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return Object.freeze({ referenced, retained, removed: [...removed].sort(), failures });
}
