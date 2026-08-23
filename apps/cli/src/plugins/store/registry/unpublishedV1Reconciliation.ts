import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import {
  PluginIdSchema,
  PluginInstallReviewPrincipalDigestSchema,
  PluginInstallReviewPrincipalPresentationV1Schema,
} from '@happier-dev/protocol';

import { pluginInstallReviewPrincipalPresentationMatchesDigest } from '@/plugins/daemon/installReviewPrincipal';
import {
  pluginSourceProvenanceForDistribution,
  type PluginSourceProvenance,
} from '@/plugins/manifest/sourceProvenance';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import {
  createDefaultPluginAccessScopeRegistry,
  PluginAccessSelectionSchema,
} from '../install/accessScopeRegistry';
import {
  PluginDistributionIdentitySchema,
  PluginTrustRecordSchema,
  PluginUpdatePolicySchema,
  pluginDistributionRollbackLineagesEqual,
} from '../install/trustIdentity';
import {
  resolvePluginStorePaths,
  type PluginStorePaths,
} from '../paths';
import {
  PluginStateFileV1Schema,
  PluginStateRecordSchema,
} from '../state';
import { withPluginRegistryCommitFence } from './commitCoordinator';
import {
  PortableRelativePathSchema,
  PortableStorageIdSchema,
  PluginRegistryCommitRecordSchema,
  readPluginRegistryCommitRecord,
} from './commitRecord';
import {
  flushDirectoryDurably,
  flushFileDurably,
} from './durability';
import {
  collectPluginGenerationStagingAncestorDirectories,
  ImmutablePluginGenerationRecordSchema,
  MAXIMUM_IMMUTABLE_GENERATION_FILES,
  persistInstallationStateRevision,
  PluginInstallationStateRevisionSchema,
  readInstallationStateRevision,
  readPreparedImmutablePluginGeneration,
  verifyPluginRegistryCommitGenerationReferences,
  type ImmutablePluginGenerationRecord,
  type PluginInstallationStateRevision,
} from './generationStore';

export const UNPUBLISHED_PLUGIN_REGISTRY_V1_PRODUCER_COMMIT =
  '8173b221801c0f7ca747574559ba314303f8c211' as const;

type PredecessorInstallReviewPrincipalPair = Readonly<{
  installReviewPrincipalDigest?: z.infer<typeof PluginInstallReviewPrincipalDigestSchema>;
  installReviewPrincipalPresentation?: z.infer<typeof PluginInstallReviewPrincipalPresentationV1Schema>;
}>;

function validatePredecessorInstallReviewPrincipalPair(
  record: PredecessorInstallReviewPrincipalPair,
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
  if (
    record.installReviewPrincipalPresentation
    && record.installReviewPrincipalDigest
    && !pluginInstallReviewPrincipalPresentationMatchesDigest(
      record.installReviewPrincipalDigest,
      record.installReviewPrincipalPresentation,
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['installReviewPrincipalPresentation'],
      message: 'Install-review principal presentation digest mismatch',
    });
  }
}

const AlgorithmQualifiedDigestSchema = z.string().regex(
  /^(?:sha256:[a-f0-9]{64}|sha384:[a-f0-9]{96}|sha512:[a-f0-9]{128})$/u,
  'Expected an algorithm-qualified hexadecimal digest',
);

const GenerationFileSchema = z.object({
  relativePath: PortableRelativePathSchema,
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  digest: AlgorithmQualifiedDigestSchema,
}).strict();

const PredecessorImmutablePluginGenerationRecordSchema = z.object({
  t: z.literal('happier_plugin_generation_v1'),
  schemaVersion: z.literal(1),
  pluginId: asHostProtocolZod(PluginIdSchema),
  immutableGenerationId: PortableStorageIdSchema,
  fingerprint: AlgorithmQualifiedDigestSchema,
  packageDigest: AlgorithmQualifiedDigestSchema,
  manifestDigest: AlgorithmQualifiedDigestSchema,
  runtimeDigest: AlgorithmQualifiedDigestSchema,
  installedUiArtifactDigest: AlgorithmQualifiedDigestSchema,
  createdAtMs: z.number().int().nonnegative(),
  files: z.array(GenerationFileSchema).max(MAXIMUM_IMMUTABLE_GENERATION_FILES),
  installedArtifactRecord: z.object({
    relativePath: PortableRelativePathSchema,
    digest: AlgorithmQualifiedDigestSchema,
  }).strict(),
}).strict().superRefine((record, context) => {
  const paths = record.files.map((file) => file.relativePath);
  if (
    new Set(paths).size !== paths.length
    || paths.some((path, index) => index > 0 && paths[index - 1]! >= path)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['files'],
      message: 'Generation file inventory must be unique and sorted',
    });
  }
  const artifact = record.files.find(
    (file) => file.relativePath === record.installedArtifactRecord.relativePath,
  );
  if (!artifact || artifact.digest !== record.installedArtifactRecord.digest) {
    context.addIssue({
      code: 'custom',
      path: ['installedArtifactRecord'],
      message: 'Installed artifact must identify verified generation bytes',
    });
  }
});
type PredecessorImmutablePluginGenerationRecord = z.infer<
  typeof PredecessorImmutablePluginGenerationRecordSchema
>;

const PredecessorPluginGenerationHealthRecordSchema = z.object({
  pluginId: asHostProtocolZod(PluginIdSchema),
  immutableGenerationId: PortableStorageIdSchema,
  fingerprint: AlgorithmQualifiedDigestSchema,
  state: z.enum(['pending', 'healthy', 'trial', 'quarantined']),
  tryOnce: z.enum(['unavailable', 'available', 'consumed']),
  eligibleFailures: z.array(z.object({
    attemptId: z.string().min(1).max(160),
    occurredAtMs: z.number().int().nonnegative(),
  }).strict()),
  consumedAttemptIds: z.array(z.string().min(1).max(160)),
  observation: z.object({
    daemonInstanceId: z.string().min(1).max(160),
    startedAtUptimeMs: z.number().int().nonnegative(),
  }).strict().nullable(),
}).strict().superRefine((record, context) => {
  const legal = record.state === 'quarantined'
    ? ['unavailable', 'available', 'consumed'].includes(record.tryOnce)
    : record.state === 'trial'
      ? record.tryOnce === 'consumed'
      : record.tryOnce === 'unavailable';
  if (!legal) {
    context.addIssue({
      code: 'custom',
      path: ['tryOnce'],
      message: 'Illegal health state and Try-once pair',
    });
  }
  if (new Set(record.consumedAttemptIds).size !== record.consumedAttemptIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['consumedAttemptIds'],
      message: 'Duplicate consumed attempt id',
    });
  }
});

const PredecessorPluginRollbackRetentionRecordSchema = z.object({
  pluginId: asHostProtocolZod(PluginIdSchema),
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
  installReviewPrincipalDigest: asHostProtocolZod(PluginInstallReviewPrincipalDigestSchema).optional(),
  installReviewPrincipalPresentation: asHostProtocolZod(PluginInstallReviewPrincipalPresentationV1Schema).optional(),
}).strict().superRefine((record, context) => {
  if (
    record.automaticRecoveryEligible
    && (record.role !== 'lastKnownGood' || record.byteAvailability !== 'available')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['automaticRecoveryEligible'],
      message: 'Only available LKG bytes are automatic-recovery eligible',
    });
  }
  validatePredecessorInstallReviewPrincipalPair(record, context);
});

const PredecessorPluginInstallationStateRecordSchema = z.object({
  enabled: z.boolean(),
  trust: PluginTrustRecordSchema.optional(),
  source: z.object({
    distribution: PluginDistributionIdentitySchema,
    admittedIntegrity: AlgorithmQualifiedDigestSchema,
  }).strict(),
  updatePolicy: PluginUpdatePolicySchema,
  optionalAccess: z.array(PluginAccessSelectionSchema).max(512),
  installReviewPrincipalDigest: asHostProtocolZod(PluginInstallReviewPrincipalDigestSchema).optional(),
  installReviewPrincipalPresentation: asHostProtocolZod(PluginInstallReviewPrincipalPresentationV1Schema).optional(),
}).strict().superRefine(validatePredecessorInstallReviewPrincipalPair);

const PredecessorHealthTombstoneSchema = z.object({
  pluginId: asHostProtocolZod(PluginIdSchema),
  fingerprint: AlgorithmQualifiedDigestSchema.optional(),
  immutableGenerationId: PortableStorageIdSchema.optional(),
  state: z.enum(['quarantined', 'consumed']),
  recordedAtMs: z.number().int().nonnegative(),
}).strict().superRefine((tombstone, context) => {
  if (!tombstone.fingerprint && !tombstone.immutableGenerationId) {
    context.addIssue({
      code: 'custom',
      message: 'Health tombstone must identify a package fingerprint or exact immutable generation',
    });
  }
});

const PredecessorPluginDiagnosticCodeSchema = z.enum([
  'plugin_source_missing',
  'plugin_source_kind_unsupported',
  'plugin_manifest_missing',
  'plugin_manifest_invalid',
  'plugin_manifest_duplicate_id',
  'plugin_manifest_semantic_invalid',
  'plugin_trust_approval_required',
  'plugin_untrusted',
  'plugin_daemon_module_load_failed',
  'plugin_activation_failed',
  'plugin_runtime_capability_missing',
  'plugin_permission_missing',
  'plugin_backend_engine_undeclared_backend_id',
  'plugin_backend_engine_duplicate_backend_id',
  'plugin_agent_runtime_undeclared_agent_id',
  'plugin_agent_runtime_duplicate_agent_id',
  'plugin_daemon_auth_bridge_invalid_service_id',
  'plugin_daemon_auth_bridge_duplicate_service_id',
  'plugin_tool_undeclared_id',
  'plugin_command_undeclared_id',
  'plugin_hook_undeclared_id',
  'plugin_hook_unsupported_id',
  'plugin_lifecycle_handler_undeclared_id',
  'plugin_notification_category_undeclared_id',
  'plugin_notification_category_duplicate_id',
  'plugin_notification_channel_undeclared_id',
  'plugin_notification_channel_duplicate_id',
  'plugin_execution_run_profile_undeclared_id',
  'plugin_request_interceptor_invalid_registration',
  'plugin_request_interceptor_manifest_fields_redeclared',
  'plugin_request_interceptor_undeclared_id',
  'plugin_request_interceptor_duplicate_id',
  'plugin_scm_hosting_provider_invalid_registration',
  'plugin_scm_hosting_provider_undeclared_id',
  'plugin_scm_hosting_provider_duplicate_id',
  'scm_hosting_provider_duplicate',
  'plugin_scm_backend_invalid_registration',
  'plugin_scm_backend_undeclared_id',
  'plugin_scm_backend_duplicate_id',
  'plugin_scm_backend_missing_activation',
  'plugin_scm_backend_activation_drift',
  'scm_backend_duplicate',
  'plugin_mcp_server_undeclared_id',
  'plugin_mcp_discovery_provider_undeclared_id',
  'installable_duplicate_key',
  'installable_duplicate_capability',
  'installable_disallowed_source_provenance',
  'plugin_hook_handler_missing',
  'plugin_hook_handler_invalid',
  'plugin_action_undeclared_id',
  'plugin_action_duplicate_id',
  'plugin_action_metadata_drift',
  'plugin_action_manifest_fields_redeclared',
  'plugin_tool_manifest_fields_redeclared',
  'plugin_command_manifest_fields_redeclared',
  'plugin_manifest_engine_range_invalid',
]);

const PredecessorPluginStateSourceRecordSchema = z.object({
  kind: z.enum(['bundled', 'path', 'marketplace', 'package', 'archive']),
  locator: z.string().trim().min(1),
  trustPolicy: z.enum(['local_trusted', 'prompt', 'untrusted']),
  installPolicy: z.enum(['link', 'copy', 'managed_install']),
  resolvedVersion: z.string().trim().min(1).optional(),
  resolvedDigest: z.string().trim().min(1).optional(),
  installedAt: z.number().int().nonnegative().optional(),
  devWatch: z.boolean().optional(),
  resolvedPath: z.string().min(1),
  manifestPath: z.string().min(1),
}).strict();

const PredecessorPluginStateRecordSchema = z.object({
  source: PredecessorPluginStateSourceRecordSchema,
  compatibility: z.object({
    status: z.enum(['unknown', 'compatible', 'incompatible', 'load_error']),
    checkedAtMs: z.number().int().nonnegative().optional(),
    diagnostics: z.array(z.object({
      code: PredecessorPluginDiagnosticCodeSchema,
      message: z.string().min(1),
    }).strict()).default([]),
  }).strict(),
  install: z.object({
    mode: z.enum(['link', 'managed_install']),
    manifestVersion: z.string().min(1),
    manifestDigest: z.string().min(1).nullable().optional(),
    installedPath: z.string().min(1).nullable().optional(),
    trust: PluginTrustRecordSchema.optional(),
    updatePolicy: PluginUpdatePolicySchema.optional(),
    optionalAccess: z.array(PluginAccessSelectionSchema).optional(),
  }).strict(),
  state: z.object({
    enabled: z.boolean(),
    lastLoadedAtMs: z.number().int().nonnegative().optional(),
    lastError: z.string().min(1).nullable().optional(),
  }).strict(),
}).strict();

const PredecessorPluginStateFileV1Schema = z.object({
  t: z.literal('happier_plugin_state_v1'),
  schemaVersion: z.literal(1),
  plugins: z.record(asHostProtocolZod(PluginIdSchema), PredecessorPluginStateRecordSchema),
}).strict();

const PredecessorPluginInstallationStateRevisionSchema = z.object({
  t: z.literal('happier_plugin_installations_v1'),
  schemaVersion: z.literal(1),
  revisionId: PortableStorageIdSchema,
  createdAtMs: z.number().int().nonnegative(),
  plugins: z.record(asHostProtocolZod(PluginIdSchema), PredecessorPluginInstallationStateRecordSchema),
  health: z.record(PortableStorageIdSchema, PredecessorPluginGenerationHealthRecordSchema),
  rollbackRetention: z.array(PredecessorPluginRollbackRetentionRecordSchema),
  healthTombstones: z.array(PredecessorHealthTombstoneSchema),
  hardRevocationRevisions: z.record(
    asHostProtocolZod(PluginIdSchema),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ).optional(),
  runtimeCatalog: PredecessorPluginStateFileV1Schema.optional(),
  retainedRuntimeCatalog: z.record(
    PortableStorageIdSchema,
    PredecessorPluginStateRecordSchema,
  ).optional(),
}).strict();
type PredecessorPluginInstallationStateRevision = z.infer<
  typeof PredecessorPluginInstallationStateRevisionSchema
>;

const PredecessorPluginRegistryGenerationReferenceSchema = z.object({
  immutableGenerationId: PortableStorageIdSchema,
  generationRecordDigest: AlgorithmQualifiedDigestSchema,
  installedArtifactRecord: z.object({
    relativePath: PortableRelativePathSchema,
    digest: AlgorithmQualifiedDigestSchema,
  }).strict(),
}).strict();

const PredecessorPluginRegistryCommitRecordSchema = z.object({
  t: z.literal('happier_plugin_registry_commit_v1'),
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  transactionId: PortableStorageIdSchema,
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  installationState: z.object({
    revisionId: PortableStorageIdSchema,
    digest: AlgorithmQualifiedDigestSchema,
  }).strict(),
  pluginGenerations: z.record(
    asHostProtocolZod(PluginIdSchema),
    PredecessorPluginRegistryGenerationReferenceSchema,
  ),
  createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  creator: z.object({
    pid: z.number().int().positive().max(0x7fffffff),
    instanceId: PortableStorageIdSchema,
  }).strict(),
}).strict().superRefine((record, context) => {
  const expectedBase = record.revision === 0 ? null : record.revision - 1;
  if (record.baseRevision !== expectedBase) {
    context.addIssue({
      code: 'custom',
      path: ['baseRevision'],
      message: `Revision ${record.revision} must name base revision ${String(expectedBase)}`,
    });
  }
});
type PredecessorPluginRegistryCommitRecord = z.infer<
  typeof PredecessorPluginRegistryCommitRecordSchema
>;

type VerifiedPredecessorGeneration = Readonly<{
  rootPath: string;
  record: PredecessorImmutablePluginGenerationRecord;
  replacementId: string;
  replacementRecord: ImmutablePluginGenerationRecord;
}>;

export type UnpublishedPluginRegistryV1ReconciliationResult = Readonly<{
  status: 'reconciled' | 'no_op';
  installationRevisionId: string;
  replacedGenerationIds: Readonly<Record<string, string>>;
}>;

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digestJson(value: unknown): `sha256:${string}` {
  return digestBytes(Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

function replacementId(kind: 'generation' | 'state', identity: unknown): string {
  const digest = createHash('sha256')
    .update(`happier.unpublished-plugin-registry-v1-reconciliation.${kind}\n`)
    .update(JSON.stringify(identity))
    .digest('hex');
  return kind === 'generation' ? `reconciled-${digest}` : `state-reconciled-${digest}`;
}

function stateRevisionPath(paths: PluginStorePaths, revisionId: string): string {
  return join(paths.stateRevisionsDir, revisionId, 'plugin-installations.v1.json');
}

function generationRecordPath(paths: PluginStorePaths, immutableGenerationId: string): string {
  return join(paths.generationsDir, immutableGenerationId, 'plugin-generation.v1.json');
}

/**
 * The replacement identity is content-addressed from the predecessor record
 * alone, so it can be resolved before the facts the current registry supplies
 * for the replacement body are known.
 */
function predecessorReplacementGenerationId(
  record: PredecessorImmutablePluginGenerationRecord,
): string {
  return replacementId('generation', {
    producerCommit: UNPUBLISHED_PLUGIN_REGISTRY_V1_PRODUCER_COMMIT,
    immutableGenerationId: record.immutableGenerationId,
    generationRecordDigest: digestJson(record),
  });
}

function replacementGenerationFromPredecessor(input: Readonly<{
  record: PredecessorImmutablePluginGenerationRecord;
  manifestRelativePath: string;
  sourceProvenance: PluginSourceProvenance;
}>): Readonly<{
  replacementId: string;
  replacementRecord: ImmutablePluginGenerationRecord;
}> {
  const nextId = predecessorReplacementGenerationId(input.record);
  return Object.freeze({
    replacementId: nextId,
    replacementRecord: ImmutablePluginGenerationRecordSchema.parse({
      t: input.record.t,
      schemaVersion: input.record.schemaVersion,
      pluginId: input.record.pluginId,
      immutableGenerationId: nextId,
      createdAtMs: input.record.createdAtMs,
      files: input.record.files.map(({ relativePath, byteLength }) => ({
        relativePath,
        byteLength,
      })),
      manifestRelativePath: input.manifestRelativePath,
      sourceProvenance: input.sourceProvenance,
    }),
  });
}

async function readJsonFile(path: string, label: string): Promise<Readonly<{
  raw: string;
  value: unknown;
}>> {
  const raw = await readFile(path, 'utf8');
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error });
  }
}

function validatePredecessorStateRelations(
  state: PredecessorPluginInstallationStateRevision,
): void {
  const accessRegistry = createDefaultPluginAccessScopeRegistry();
  const validateCatalogRecord = (
    pluginId: string,
    catalog: z.infer<typeof PredecessorPluginStateRecordSchema>,
  ): void => {
    if (catalog.install.trust?.pluginId !== undefined && catalog.install.trust.pluginId !== pluginId) {
      throw new Error(`Predecessor catalog trust identity mismatch for '${pluginId}'`);
    }
    for (const selection of catalog.install.optionalAccess ?? []) {
      if (selection.pluginId !== pluginId || !accessRegistry.validateSelection(selection)) {
        throw new Error(`Invalid predecessor catalog optional access for '${pluginId}'`);
      }
    }
  };
  const currentIds = Object.keys(state.plugins).sort();
  const catalogIds = Object.keys(state.runtimeCatalog?.plugins ?? {}).sort();
  if (
    state.runtimeCatalog
    && (
      currentIds.length !== catalogIds.length
      || currentIds.some((pluginId, index) => pluginId !== catalogIds[index])
    )
  ) {
    throw new Error('Predecessor runtime catalog identities do not match installations');
  }
  for (const [pluginId, installation] of Object.entries(state.plugins)) {
    if (
      installation.trust
      && (
        installation.trust.pluginId !== pluginId
        || JSON.stringify(installation.trust.distribution)
          !== JSON.stringify(installation.source.distribution)
      )
    ) {
      throw new Error(`Predecessor installation trust/source mismatch for '${pluginId}'`);
    }
    for (const selection of installation.optionalAccess) {
      if (selection.pluginId !== pluginId || !accessRegistry.validateSelection(selection)) {
        throw new Error(`Invalid predecessor optional access for '${pluginId}'`);
      }
    }
    const catalog = state.runtimeCatalog?.plugins[pluginId];
    if (catalog && catalog.state.enabled !== installation.enabled) {
      throw new Error(`Predecessor catalog enabled state mismatch for '${pluginId}'`);
    }
    if (catalog) {
      validateCatalogRecord(pluginId, catalog);
      if (
        installation.trust
        && catalog.install.trust
        && JSON.stringify(installation.trust) !== JSON.stringify(catalog.install.trust)
      ) {
        throw new Error(`Predecessor catalog/installation trust mismatch for '${pluginId}'`);
      }
    }
  }
  const retainedIds = new Set(state.rollbackRetention.map(
    (retention) => retention.immutableGenerationId,
  ));
  for (const generationId of Object.keys(state.retainedRuntimeCatalog ?? {})) {
    if (!retainedIds.has(generationId)) {
      throw new Error(`Predecessor retained catalog has no retention for '${generationId}'`);
    }
    const retention = state.rollbackRetention.find(
      (candidate) => candidate.immutableGenerationId === generationId,
    );
    const retainedCatalog = state.retainedRuntimeCatalog?.[generationId];
    if (retention && retainedCatalog) {
      validateCatalogRecord(retention.pluginId, retainedCatalog);
    }
  }
  const priorCount = new Map<string, number>();
  const quarantinedCount = new Map<string, number>();
  const seenGenerations = new Set<string>();
  for (const [generationId, health] of Object.entries(state.health)) {
    if (health.immutableGenerationId !== generationId) {
      throw new Error(`Predecessor health identity mismatch for '${generationId}'`);
    }
  }
  for (const retention of state.rollbackRetention) {
    if (seenGenerations.has(retention.immutableGenerationId)) {
      throw new Error(`Duplicate predecessor rollback generation '${retention.immutableGenerationId}'`);
    }
    seenGenerations.add(retention.immutableGenerationId);
    const counts = retention.role === 'quarantined' ? quarantinedCount : priorCount;
    const count = (counts.get(retention.pluginId) ?? 0) + 1;
    counts.set(retention.pluginId, count);
    if (count > 1) {
      throw new Error(`Predecessor rollback retention is not bounded for '${retention.pluginId}'`);
    }
    const health = state.health[retention.healthGenerationId];
    if (
      !health
      || health.pluginId !== retention.pluginId
      || health.immutableGenerationId !== retention.immutableGenerationId
    ) {
      throw new Error(`Predecessor rollback health mismatch for '${retention.pluginId}'`);
    }
    const installation = state.plugins[retention.pluginId];
    if (
      !installation
      || !pluginDistributionRollbackLineagesEqual(
        installation.source.distribution,
        retention.distribution,
      )
    ) {
      throw new Error(`Predecessor rollback lineage mismatch for '${retention.pluginId}'`);
    }
  }
}

async function verifyGenerationInventory(
  rootPath: string,
  record: PredecessorImmutablePluginGenerationRecord,
): Promise<void> {
  const rootMetadata = await lstat(rootPath);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Predecessor generation root is not a real directory: ${record.immutableGenerationId}`);
  }
  const expectedFiles = new Map(record.files.map((file) => [file.relativePath, file]));
  const expectedDirectories = new Set<string>();
  for (const relativePath of expectedFiles.keys()) {
    const segments = relativePath.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      expectedDirectories.add(segments.slice(0, length).join('/'));
    }
  }
  const seen = new Set<string>();
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!;
    const directoryPath = relativeDirectory
      ? join(rootPath, ...relativeDirectory.split('/'))
      : rootPath;
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const relativePath = PortableRelativePathSchema.parse(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      const path = join(directoryPath, entry.name);
      const metadata = await lstat(path);
      const expected = expectedFiles.get(relativePath);
      if (expected) {
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error(`Predecessor generation file is not regular: ${relativePath}`);
        }
        const bytes = await readFile(path);
        if (bytes.byteLength !== expected.byteLength || digestBytes(bytes) !== expected.digest) {
          throw new Error(`Predecessor generation file digest mismatch: ${relativePath}`);
        }
        seen.add(relativePath);
        continue;
      }
      if (expectedDirectories.has(relativePath)) {
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(`Predecessor generation directory is invalid: ${relativePath}`);
        }
        pending.push(relativePath);
        continue;
      }
      if (
        relativeDirectory === ''
        && relativePath === 'plugin-generation.v1.json'
        && !metadata.isSymbolicLink()
        && metadata.isFile()
      ) continue;
      throw new Error(`Unexpected predecessor generation entry: ${relativePath}`);
    }
  }
  if (seen.size !== expectedFiles.size) {
    throw new Error(`Predecessor generation inventory is incomplete: ${record.immutableGenerationId}`);
  }
}

function validateGenerationDigests(input: Readonly<{
  record: PredecessorImmutablePluginGenerationRecord;
  distribution: z.infer<typeof PluginDistributionIdentitySchema>;
  updatePolicy: z.infer<typeof PluginUpdatePolicySchema>;
  catalog: z.infer<typeof PredecessorPluginStateRecordSchema>;
}>): void {
  const { record, catalog } = input;
  if (digestJson(record.files) !== record.packageDigest) {
    throw new Error(`Predecessor generation package digest mismatch for '${record.immutableGenerationId}'`);
  }
  const installedArtifact = record.files.find(
    (file) => file.relativePath === record.installedArtifactRecord.relativePath,
  );
  if (
    !installedArtifact
    || installedArtifact.digest !== record.installedArtifactRecord.digest
    || record.manifestDigest !== installedArtifact.digest
  ) {
    throw new Error(`Predecessor generation manifest digest mismatch for '${record.immutableGenerationId}'`);
  }
  if (
    record.runtimeDigest !== record.packageDigest
    || record.installedUiArtifactDigest !== record.packageDigest
  ) {
    throw new Error(`Predecessor generation materialized digest mismatch for '${record.immutableGenerationId}'`);
  }
  const fingerprint = digestBytes(Buffer.from(
    `happier.plugin-generation-fingerprint.v1\n${JSON.stringify({
      pluginId: record.pluginId,
      distribution: input.distribution,
      updatePolicy: input.updatePolicy,
      normalizedManifestDigest: record.manifestDigest,
      packageDigest: record.packageDigest,
      runtimeDigest: record.runtimeDigest,
      installedUiArtifactDigest: record.installedUiArtifactDigest,
    })}`,
    'utf8',
  ));
  if (fingerprint !== record.fingerprint) {
    throw new Error(`Predecessor generation fingerprint mismatch for '${record.immutableGenerationId}'`);
  }
  if (
    catalog.source.resolvedDigest !== undefined
    && catalog.source.resolvedDigest !== record.manifestDigest
  ) {
    throw new Error(`Predecessor catalog source digest mismatch for '${record.pluginId}'`);
  }
  if (
    catalog.install.manifestDigest !== undefined
    && catalog.install.manifestDigest !== null
    && catalog.install.manifestDigest !== record.manifestDigest
  ) {
    throw new Error(`Predecessor catalog manifest digest mismatch for '${record.pluginId}'`);
  }
}

async function verifyPredecessorGeneration(input: Readonly<{
  paths: PluginStorePaths;
  immutableGenerationId: string;
  expectedPluginId: string;
  distribution: z.infer<typeof PluginDistributionIdentitySchema>;
  updatePolicy: z.infer<typeof PluginUpdatePolicySchema>;
  catalog: z.infer<typeof PredecessorPluginStateRecordSchema>;
  installedArtifactReference?: Readonly<{ relativePath: string; digest: string }>;
}>): Promise<VerifiedPredecessorGeneration> {
  const recordFile = await readJsonFile(
    generationRecordPath(input.paths, input.immutableGenerationId),
    'predecessor immutable generation record',
  );
  const record = PredecessorImmutablePluginGenerationRecordSchema.parse(recordFile.value);
  if (
    record.pluginId !== input.expectedPluginId
    || record.immutableGenerationId !== input.immutableGenerationId
  ) {
    throw new Error(`Predecessor generation identity mismatch for '${input.expectedPluginId}'`);
  }
  const rootPath = join(input.paths.generationsDir, input.immutableGenerationId);
  await verifyGenerationInventory(rootPath, record);
  validateGenerationDigests({
    record,
    distribution: input.distribution,
    updatePolicy: input.updatePolicy,
    catalog: input.catalog,
  });
  if (
    input.installedArtifactReference
    && JSON.stringify(input.installedArtifactReference)
      !== JSON.stringify(record.installedArtifactRecord)
  ) {
    throw new Error(`Predecessor installed-artifact reference mismatch for '${input.expectedPluginId}'`);
  }
  const manifestRelativePath = PortableRelativePathSchema.parse(
    input.installedArtifactReference?.relativePath
      ?? record.installedArtifactRecord.relativePath,
  );
  if (
    input.catalog.source.resolvedPath !== rootPath
    || input.catalog.source.manifestPath
      !== join(rootPath, ...record.installedArtifactRecord.relativePath.split('/'))
    || (
      input.catalog.install.installedPath !== undefined
      && input.catalog.install.installedPath !== null
      && input.catalog.install.installedPath !== rootPath
    )
  ) {
    throw new Error(`Predecessor catalog generation path mismatch for '${input.expectedPluginId}'`);
  }
  const replacement = replacementGenerationFromPredecessor({
    record,
    // Desired-current generations take this path from the independently
    // verified commit reference. Rollback-only records use their verified
    // predecessor generation artifact because no commit reference exists.
    manifestRelativePath,
    sourceProvenance: pluginSourceProvenanceForDistribution(input.distribution),
  });
  return Object.freeze({ rootPath, record, ...replacement });
}

function transformCatalogRecord(input: Readonly<{
  record: z.infer<typeof PredecessorPluginStateRecordSchema>;
  priorRootPath: string;
  replacementRootPath: string;
  manifestRelativePath: string;
}>): z.infer<typeof PluginStateRecordSchema> {
  const { resolvedDigest: _resolvedDigest, ...sourceWithoutDigest } = input.record.source;
  const { manifestDigest: _manifestDigest, ...installWithoutDigest } = input.record.install;
  return PluginStateRecordSchema.parse({
    ...input.record,
    source: {
      ...sourceWithoutDigest,
      resolvedPath: input.replacementRootPath,
      manifestPath: join(input.replacementRootPath, ...input.manifestRelativePath.split('/')),
    },
    install: {
      ...installWithoutDigest,
      ...(input.record.install.installedPath === input.priorRootPath
        ? { installedPath: input.replacementRootPath }
        : {}),
    },
  });
}

async function verifyReplacementGeneration(
  targetRoot: string,
  generation: VerifiedPredecessorGeneration,
): Promise<void> {
  const record = ImmutablePluginGenerationRecordSchema.parse(JSON.parse(await readFile(
    join(targetRoot, 'plugin-generation.v1.json'),
    'utf8',
  )) as unknown);
  if (JSON.stringify(record) !== JSON.stringify(generation.replacementRecord)) {
    throw new Error(`Replacement generation identity collision for '${generation.replacementId}'`);
  }
  await verifyGenerationInventory(targetRoot, {
    ...generation.record,
    immutableGenerationId: generation.replacementId,
  });
}

async function materializeReplacementGeneration(
  paths: PluginStorePaths,
  generation: VerifiedPredecessorGeneration,
): Promise<void> {
  const targetRoot = join(paths.generationsDir, generation.replacementId);
  try {
    await lstat(targetRoot);
    await verifyReplacementGeneration(targetRoot, generation);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
  const stagingRoot = join(
    paths.generationsDir,
    `.reconciling-${generation.replacementId}-${randomUUID()}`,
  );
  await mkdir(stagingRoot, { recursive: false });
  const directories = new Set<string>([stagingRoot]);
  for (const file of generation.record.files) {
    const destination = join(stagingRoot, ...file.relativePath.split('/'));
    const destinationDirectory = dirname(destination);
    await mkdir(destinationDirectory, { recursive: true });
    for (const directory of collectPluginGenerationStagingAncestorDirectories(
      stagingRoot,
      destinationDirectory,
    )) {
      directories.add(directory);
    }
    await copyFile(join(generation.rootPath, ...file.relativePath.split('/')), destination);
    await flushFileDurably(destination);
  }
  await writeJsonAtomic(
    join(stagingRoot, 'plugin-generation.v1.json'),
    generation.replacementRecord,
  );
  await flushFileDurably(join(stagingRoot, 'plugin-generation.v1.json'));
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await flushDirectoryDurably(directory);
  }
  await verifyReplacementGeneration(stagingRoot, generation);
  await rename(stagingRoot, targetRoot);
  await flushDirectoryDurably(paths.generationsDir);
  await verifyReplacementGeneration(targetRoot, generation);
}

function transformInstallationState(input: Readonly<{
  state: PredecessorPluginInstallationStateRevision;
  generations: ReadonlyMap<string, VerifiedPredecessorGeneration>;
}>): PluginInstallationStateRevision {
  const plugins = Object.fromEntries(Object.entries(input.state.plugins).map(
    ([pluginId, installation]) => {
      const { admittedIntegrity: _admittedIntegrity, ...source } = installation.source;
      return [pluginId, { ...installation, source }];
    },
  ));
  const runtimeCatalog = input.state.runtimeCatalog
    ? PluginStateFileV1Schema.parse({
        ...input.state.runtimeCatalog,
        plugins: Object.fromEntries(Object.entries(input.state.runtimeCatalog.plugins).map(
          ([pluginId, record]) => {
            const generation = [...input.generations.values()].find(
              (candidate) => candidate.record.pluginId === pluginId
                && input.state.plugins[pluginId]
                && !input.state.rollbackRetention.some(
                  (retention) => retention.immutableGenerationId === candidate.record.immutableGenerationId,
                ),
            );
            if (!generation) throw new Error(`Missing verified current generation for '${pluginId}'`);
            return [pluginId, transformCatalogRecord({
              record,
              priorRootPath: generation.rootPath,
              replacementRootPath: join(dirname(generation.rootPath), generation.replacementId),
              manifestRelativePath: generation.replacementRecord.manifestRelativePath,
            })];
          },
        )),
      })
    : undefined;
  const rollbackRetention = input.state.rollbackRetention.map((retention) => {
    const generation = input.generations.get(retention.immutableGenerationId);
    if (!generation) {
      throw new Error(`Missing verified rollback generation '${retention.immutableGenerationId}'`);
    }
    return {
      pluginId: retention.pluginId,
      immutableGenerationId: generation.replacementId,
      retainedAtMs: retention.retainedAtMs,
      byteAvailability: retention.byteAvailability,
      pluginVersion: retention.pluginVersion,
      distribution: retention.distribution,
      ...(retention.installReviewPrincipalDigest
        ? { installReviewPrincipalDigest: retention.installReviewPrincipalDigest }
        : {}),
      ...(retention.installReviewPrincipalPresentation
        ? { installReviewPrincipalPresentation: retention.installReviewPrincipalPresentation }
        : {}),
    };
  });
  const retainedRuntimeCatalog = input.state.retainedRuntimeCatalog
    ? Object.fromEntries(Object.entries(input.state.retainedRuntimeCatalog).map(
        ([generationId, record]) => {
          const generation = input.generations.get(generationId);
          if (!generation) throw new Error(`Missing verified retained generation '${generationId}'`);
          return [generation.replacementId, transformCatalogRecord({
            record,
            priorRootPath: generation.rootPath,
            replacementRootPath: join(dirname(generation.rootPath), generation.replacementId),
            manifestRelativePath: generation.replacementRecord.manifestRelativePath,
          })];
        },
      ))
    : undefined;
  return PluginInstallationStateRevisionSchema.parse({
    t: input.state.t,
    schemaVersion: input.state.schemaVersion,
    revisionId: replacementId('state', {
      producerCommit: UNPUBLISHED_PLUGIN_REGISTRY_V1_PRODUCER_COMMIT,
      revisionId: input.state.revisionId,
      stateDigest: digestJson(input.state),
    }),
    createdAtMs: input.state.createdAtMs,
    plugins,
    rollbackRetention,
    ...(input.state.hardRevocationRevisions
      ? { hardRevocationRevisions: input.state.hardRevocationRevisions }
      : {}),
    ...(runtimeCatalog ? { runtimeCatalog } : {}),
    ...(retainedRuntimeCatalog ? { retainedRuntimeCatalog } : {}),
  });
}

async function verifyCompletePredecessorGraph(
  paths: PluginStorePaths,
  rawCommit: string,
): Promise<Readonly<{
  commit: PredecessorPluginRegistryCommitRecord;
  state: PredecessorPluginInstallationStateRevision;
  generations: ReadonlyMap<string, VerifiedPredecessorGeneration>;
}>> {
  let commitValue: unknown;
  try {
    commitValue = JSON.parse(rawCommit) as unknown;
  } catch (error) {
    throw new Error('Invalid predecessor plugin registry commit', { cause: error });
  }
  const commit = PredecessorPluginRegistryCommitRecordSchema.parse(commitValue);
  const stateFile = await readJsonFile(
    stateRevisionPath(paths, commit.installationState.revisionId),
    'predecessor installation revision',
  );
  if (digestBytes(Buffer.from(stateFile.raw, 'utf8')) !== commit.installationState.digest) {
    throw new Error('Predecessor installation revision digest mismatch');
  }
  const state = PredecessorPluginInstallationStateRevisionSchema.parse(stateFile.value);
  if (state.revisionId !== commit.installationState.revisionId) {
    throw new Error('Predecessor installation revision identity mismatch');
  }
  validatePredecessorStateRelations(state);
  const currentIds = new Set(Object.values(commit.pluginGenerations).map(
    (reference) => reference.immutableGenerationId,
  ));
  for (const retention of state.rollbackRetention) {
    if (currentIds.has(retention.immutableGenerationId)) {
      throw new Error(`Predecessor current generation is also rollback-retained: '${retention.immutableGenerationId}'`);
    }
  }

  const generations = new Map<string, VerifiedPredecessorGeneration>();
  for (const [pluginId, reference] of Object.entries(commit.pluginGenerations)) {
    const installation = state.plugins[pluginId];
    const catalog = state.runtimeCatalog?.plugins[pluginId];
    if (!installation || !catalog) {
      throw new Error(`Incomplete predecessor current graph for '${pluginId}'`);
    }
    const generation = await verifyPredecessorGeneration({
      paths,
      immutableGenerationId: reference.immutableGenerationId,
      expectedPluginId: pluginId,
      distribution: installation.source.distribution,
      updatePolicy: installation.updatePolicy,
      catalog,
      installedArtifactReference: reference.installedArtifactRecord,
    });
    if (digestJson(generation.record) !== reference.generationRecordDigest) {
      throw new Error(`Predecessor generation record digest mismatch for '${pluginId}'`);
    }
    if (installation.source.admittedIntegrity !== generation.record.packageDigest) {
      throw new Error(`Predecessor admitted integrity mismatch for '${pluginId}'`);
    }
    const health = state.health[reference.immutableGenerationId];
    if (
      !health
      || health.pluginId !== pluginId
      || health.fingerprint !== generation.record.fingerprint
    ) {
      throw new Error(`Predecessor current health digest mismatch for '${pluginId}'`);
    }
    generations.set(reference.immutableGenerationId, generation);
  }

  for (const retention of state.rollbackRetention) {
    const catalog = state.retainedRuntimeCatalog?.[retention.immutableGenerationId];
    const installation = state.plugins[retention.pluginId];
    if (!catalog || !installation) {
      throw new Error(`Incomplete predecessor rollback graph for '${retention.pluginId}'`);
    }
    const updatePolicy = catalog.install.updatePolicy ?? installation.updatePolicy;
    const generation = await verifyPredecessorGeneration({
      paths,
      immutableGenerationId: retention.immutableGenerationId,
      expectedPluginId: retention.pluginId,
      distribution: retention.distribution,
      updatePolicy,
      catalog,
    });
    if (
      retention.packageDigest !== generation.record.packageDigest
      || retention.artifactDigest !== generation.record.installedArtifactRecord.digest
    ) {
      throw new Error(`Predecessor rollback digest mismatch for '${retention.pluginId}'`);
    }
    const health = state.health[retention.healthGenerationId];
    if (!health || health.fingerprint !== generation.record.fingerprint) {
      throw new Error(`Predecessor rollback health digest mismatch for '${retention.pluginId}'`);
    }
    generations.set(retention.immutableGenerationId, generation);
  }

  const referencedHealthIds = new Set([
    ...Object.values(commit.pluginGenerations).map((reference) => reference.immutableGenerationId),
    ...state.rollbackRetention.map((retention) => retention.healthGenerationId),
  ]);
  for (const healthId of Object.keys(state.health)) {
    if (!referencedHealthIds.has(healthId)) {
      throw new Error(`Unreferenced predecessor generation health '${healthId}' cannot be reconciled safely`);
    }
  }
  return Object.freeze({ commit, state, generations });
}

type CurrentReplacementReference = Readonly<{
  pluginId: string;
  replacementBytesRequired: boolean;
}>;

function currentReplacementReferences(input: Readonly<{
  commit: z.infer<typeof PluginRegistryCommitRecordSchema>;
  state: PluginInstallationStateRevision;
}>): ReadonlyMap<string, CurrentReplacementReference> {
  const referencesByGenerationId = new Map<string, CurrentReplacementReference>();
  const add = (
    immutableGenerationId: string,
    pluginId: string,
    replacementBytesRequired: boolean,
  ): void => {
    const prior = referencesByGenerationId.get(immutableGenerationId);
    if (prior && prior.pluginId !== pluginId) {
      throw new Error(
        `Current plugin registry maps immutable generation '${immutableGenerationId}' to multiple plugins`,
      );
    }
    referencesByGenerationId.set(immutableGenerationId, Object.freeze({
      pluginId,
      replacementBytesRequired: prior?.replacementBytesRequired || replacementBytesRequired,
    }));
  };
  for (const [pluginId, reference] of Object.entries(input.commit.pluginGenerations)) {
    add(reference.immutableGenerationId, pluginId, true);
  }
  for (const retention of input.state.rollbackRetention) {
    add(
      retention.immutableGenerationId,
      retention.pluginId,
      retention.byteAvailability === 'available',
    );
  }
  return referencesByGenerationId;
}

/**
 * Retire only a predecessor root whose immutable record maps to a current
 * replacement. Required replacement bytes are verified; a retention that
 * already records unavailable bytes can instead retire its stale predecessor
 * root directly. Normal runtime cleanup never learns the unpublished shape.
 */
async function retireProvablySupersededPredecessorRoots(input: Readonly<{
  paths: PluginStorePaths;
  commit: z.infer<typeof PluginRegistryCommitRecordSchema>;
  state: PluginInstallationStateRevision;
}>): Promise<void> {
  const entries = await readdir(input.paths.generationsDir, {
    withFileTypes: true,
    encoding: 'utf8',
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!entries) return;
  const referencesByReplacementGenerationId = currentReplacementReferences(input);
  const candidates: VerifiedPredecessorGeneration[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const immutableGenerationId = PortableStorageIdSchema.safeParse(entry.name);
    if (!immutableGenerationId.success) continue;
    const rootPath = join(input.paths.generationsDir, immutableGenerationId.data);
    let record: PredecessorImmutablePluginGenerationRecord;
    try {
      const file = await readJsonFile(
        generationRecordPath(input.paths, immutableGenerationId.data),
        'predecessor immutable generation record',
      );
      const parsed = PredecessorImmutablePluginGenerationRecordSchema.safeParse(file.value);
      if (!parsed.success || parsed.data.immutableGenerationId !== immutableGenerationId.data) continue;
      record = parsed.data;
    } catch {
      continue;
    }
    const currentReference = referencesByReplacementGenerationId.get(
      predecessorReplacementGenerationId(record),
    );
    // The replacement body has to be reproduced exactly, so it needs the same
    // provenance reconciliation derived from this plugin's distribution. A
    // rollback retention's distribution shares its installation's lineage, and
    // a lineage fixes the kind, so the current installation record is the one
    // authority for both roles. Without it the root is not provably superseded.
    const installation = input.state.plugins[record.pluginId];
    if (!currentReference || currentReference.pluginId !== record.pluginId || !installation) {
      continue;
    }
    const replacement = replacementGenerationFromPredecessor({
      record,
      manifestRelativePath: record.installedArtifactRecord.relativePath,
      sourceProvenance: pluginSourceProvenanceForDistribution(installation.source.distribution),
    });
    const candidate = Object.freeze({ rootPath, record, ...replacement });
    try {
      await verifyGenerationInventory(candidate.rootPath, candidate.record);
      if (currentReference.replacementBytesRequired) {
        await verifyReplacementGeneration(
          join(input.paths.generationsDir, candidate.replacementId),
          candidate,
        );
      }
    } catch {
      continue;
    }
    candidates.push(candidate);
  }
  for (const candidate of candidates) {
    await rm(candidate.rootPath, { recursive: true, force: false });
    await flushDirectoryDurably(input.paths.generationsDir);
  }
}

async function verifyCurrentNoOp(paths: PluginStorePaths): Promise<UnpublishedPluginRegistryV1ReconciliationResult> {
  const commit = await readPluginRegistryCommitRecord(paths);
  if (!commit) throw new Error('Plugin registry current record is absent');
  await verifyPluginRegistryCommitGenerationReferences(paths, commit);
  const state = await readInstallationStateRevision({
    paths,
    reference: commit.installationState,
    commit,
  });
  for (const retention of state.rollbackRetention) {
    if (retention.byteAvailability !== 'available') continue;
    await readPreparedImmutablePluginGeneration({
      paths,
      immutableGenerationId: retention.immutableGenerationId,
    });
  }
  await retireProvablySupersededPredecessorRoots({ paths, commit, state });
  return Object.freeze({
    status: 'no_op',
    installationRevisionId: commit.installationState.revisionId,
    replacedGenerationIds: Object.freeze({}),
  });
}

/**
 * One-time operator reconciliation for the exact unpublished registry written
 * by the pinned producer checkpoint. Runtime readers deliberately remain strict.
 * The caller must target an explicit retained-stack CLI home and attest that
 * its owning stack and daemon are stopped; this function never resolves a
 * default user home and never manages a process lifecycle.
 */
export async function reconcileUnpublishedPluginRegistryV1(input: Readonly<{
  happyHomeDir: string;
  expectedProducerCommit: string;
  ownerStopped: true;
  owner: Readonly<{ pid: number; instanceId: string }>;
}>): Promise<UnpublishedPluginRegistryV1ReconciliationResult> {
  if (input.expectedProducerCommit !== UNPUBLISHED_PLUGIN_REGISTRY_V1_PRODUCER_COMMIT) {
    throw new Error(
      `Unsupported unpublished plugin registry producer '${input.expectedProducerCommit}'`,
    );
  }
  if (input.ownerStopped !== true) {
    throw new Error('Unpublished plugin registry reconciliation requires a stopped retained-stack owner');
  }
  if (!isAbsolute(input.happyHomeDir)) {
    throw new Error('Unpublished plugin registry reconciliation requires an explicit absolute Happier home');
  }
  const happyHomeDir = resolve(input.happyHomeDir);
  const retainedStackSuffix = happyHomeDir.split(/[\\/]+/u).slice(-4);
  if (
    retainedStackSuffix.length !== 4
    || retainedStackSuffix[0] !== '.happier'
    || retainedStackSuffix[1] !== 'stacks'
    || !retainedStackSuffix[2]
    || retainedStackSuffix[3] !== 'cli'
  ) {
    throw new Error(
      'Unpublished plugin registry reconciliation requires an explicit retained-stack CLI home ending in .happier/stacks/<stack>/cli',
    );
  }
  const paths = resolvePluginStorePaths({ happyHomeDir });
  return await withPluginRegistryCommitFence({
    paths,
    owner: input.owner,
    operation: async () => {
      const rawCommit = await readFile(paths.registryCurrentFilePath, 'utf8');
      const currentValue = (() => {
        try {
          return JSON.parse(rawCommit) as unknown;
        } catch {
          return null;
        }
      })();
      if (PluginRegistryCommitRecordSchema.safeParse(currentValue).success) {
        return await verifyCurrentNoOp(paths);
      }

      // Complete validation is intentionally finished before the first write.
      const predecessor = await verifyCompletePredecessorGraph(paths, rawCommit);
      const replacementState = transformInstallationState({
        state: predecessor.state,
        generations: predecessor.generations,
      });
      const nextCommit = PluginRegistryCommitRecordSchema.parse({
        t: predecessor.commit.t,
        schemaVersion: predecessor.commit.schemaVersion,
        revision: predecessor.commit.revision,
        transactionId: predecessor.commit.transactionId,
        baseRevision: predecessor.commit.baseRevision,
        installationState: { revisionId: replacementState.revisionId },
        pluginGenerations: Object.fromEntries(Object.entries(
          predecessor.commit.pluginGenerations,
        ).map(([pluginId, reference]) => {
          const generation = predecessor.generations.get(reference.immutableGenerationId);
          if (!generation) throw new Error(`Missing verified current generation for '${pluginId}'`);
          return [pluginId, { immutableGenerationId: generation.replacementId }];
        })),
        createdAtMs: predecessor.commit.createdAtMs,
        creator: predecessor.commit.creator,
      });

      for (const generation of predecessor.generations.values()) {
        await materializeReplacementGeneration(paths, generation);
      }
      const installationReference = await persistInstallationStateRevision({
        paths,
        state: replacementState,
      });
      if (installationReference.revisionId !== nextCommit.installationState.revisionId) {
        throw new Error('Reconciled installation revision identity mismatch');
      }
      await verifyPluginRegistryCommitGenerationReferences(paths, nextCommit);
      if (await readFile(paths.registryCurrentFilePath, 'utf8') !== rawCommit) {
        throw new Error('Plugin registry current record changed during unpublished reconciliation');
      }
      await writeJsonAtomic(paths.registryCurrentFilePath, nextCommit);
      await flushFileDurably(paths.registryCurrentFilePath);
      await flushDirectoryDurably(paths.stateDir);
      await verifyPluginRegistryCommitGenerationReferences(paths, nextCommit);
      await retireProvablySupersededPredecessorRoots({
        paths,
        commit: nextCommit,
        state: replacementState,
      });

      return Object.freeze({
        status: 'reconciled' as const,
        installationRevisionId: replacementState.revisionId,
        replacedGenerationIds: Object.freeze(Object.fromEntries(
          [...predecessor.generations.entries()].map(([priorId, generation]) => [
            priorId,
            generation.replacementId,
          ]),
        )),
      });
    },
  });
}
