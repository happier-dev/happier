import { z } from '../zodRuntimePolicy.js';
import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentTextV1Schema as text } from './storedAppInputV1.js';
import { DeploymentBackupDestinationBindingIdentityV1Schema, environmentSecretBindingIdentityV1 } from './storedAppInputV1.js';
import { BackupDestinationContributionV1Schema } from '../plugins/contributions/backupDestinations.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import type { DeploymentBackupActionIdV1 } from './deploymentActionIdsV1.js';
import { DeploymentBackupHistoryResultV1Schema } from './deploymentBackupHistoryV1.js';
import { DeploymentFailureRecoveryV1Schema } from './deploymentFailureRecoveryV1.js';
import { DeploymentBackupRetentionV1Schema } from './deploymentBackupRetentionV1.js';
export { DeploymentBackupRetentionV1Schema, type DeploymentBackupRetentionV1 } from './deploymentBackupRetentionV1.js';
export * from './deploymentBackupHistoryV1.js';

/** Shared backup evidence and policy: deployment-protocol consumes this same closed wire owner. */
export const DeploymentBackupSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dump'), sourceId: text, service: text, consistency: z.literal('logical') }),
  z.strictObject({ kind: z.literal('volume'), sourceId: text, service: text, volume: text, consistency: z.literal('stopDuringCopy') }),
]));
export type DeploymentBackupSourceV1 = z.infer<typeof DeploymentBackupSourceV1Schema>;
/** Restic 0.19.1 repository, snapshot and tree identities are full SHA-256 hex strings. */
const nativeDigest = lazyZodSchema(() => z.string().check(z.regex(/^[0-9a-f]{64}$/u)));
const processedCount = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const DeploymentBackupSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  snapshotId: nativeDigest, treeId: nativeDigest, hostname: text,
  time: z.iso.datetime({ offset: true }), paths: z.array(text), tags: z.array(text),
}));
export type DeploymentBackupSnapshotV1 = z.infer<typeof DeploymentBackupSnapshotV1Schema>;
/** Completed native diagnostics, credential-redacted by the admitted process owner before release. */
export const DeploymentBackupNativeFailureV1Schema = lazyZodSchema(() => z.strictObject({
  exitCode: z.number().check(z.int()), stderr: z.string(), stderrTruncated: z.boolean(),
}));
export type DeploymentBackupNativeFailureV1 = z.infer<typeof DeploymentBackupNativeFailureV1Schema>;
/** Closed nonsecret facts retained when native maintenance fails or is cancelled. */
const backupFailureFields = () => ({
  step: z.string(), code: z.string(),
  probe: z.optional(z.strictObject({ key: text, cleanup: z.enum(['deleted', 'failed', 'unknown']) })),
  nativeFailure: z.optional(DeploymentBackupNativeFailureV1Schema),
});
const backupFailureVariants = () => [
  z.strictObject(backupFailureFields()),
  z.strictObject({ ...backupFailureFields(),
    removedSnapshotIds: z.array(DeploymentBackupSnapshotV1Schema.shape.snapshotId),
    uncertainSnapshotIds: z.array(DeploymentBackupSnapshotV1Schema.shape.snapshotId) }),
] as const;
export const DeploymentBackupFailureResultV1Schema = lazyZodSchema(() => z.union(backupFailureVariants()));
export type DeploymentBackupFailureResultV1 = z.infer<typeof DeploymentBackupFailureResultV1Schema>;
/** The same native evidence with the Action envelope's existing recovery facts. */
export const DeploymentBackupFailureDetailsV1Schema = lazyZodSchema(() => {
  const variants = backupFailureVariants();
  const recovery = z.partial(DeploymentFailureRecoveryV1Schema).shape;
  return z.union([z.extend(variants[0], recovery), z.extend(variants[1], recovery)]);
});
export type DeploymentBackupMaintenanceFailureEvidenceV1 = Readonly<{
  removedSnapshotIds?: readonly string[]; uncertainSnapshotIds?: readonly string[];
  probe?: DeploymentBackupFailureResultV1['probe'];
  nativeFailure?: DeploymentBackupNativeFailureV1;
}>;

/** The Action failure presenter may disclose these native identities, never arbitrary thrown details or payloads. */
export function readDeploymentBackupMaintenanceFailureEvidenceV1(error: unknown): DeploymentBackupMaintenanceFailureEvidenceV1 | undefined {
  if (!error || typeof error !== 'object' || !('details' in error)) return undefined;
  const details = error.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const candidate = {
    ...('removedSnapshotIds' in details ? { removedSnapshotIds: details.removedSnapshotIds } : {}),
    ...('uncertainSnapshotIds' in details ? { uncertainSnapshotIds: details.uncertainSnapshotIds } : {}),
    ...('probe' in details && details.probe !== undefined ? { probe: details.probe } : {}),
    ...('nativeFailure' in details && details.nativeFailure !== undefined ? { nativeFailure: details.nativeFailure } : {}),
  };
  if (!Object.keys(candidate).length) return undefined;
  const parsed = DeploymentBackupFailureResultV1Schema.safeParse({ step: '', code: '', ...candidate });
  if (!parsed.success) return undefined;
  const { step, code, ...evidence } = parsed.data;
  return evidence;
}
export const DeploymentBackupManifestV1Schema = lazyZodSchema(() => z.strictObject({
  schemaVersion: z.literal(1), environmentId: id, sourceId: text, kind: z.enum(['dump', 'volume']),
  configRevision: revision, repositoryId: nativeDigest, snapshot: DeploymentBackupSnapshotV1Schema,
  totalBytesProcessed: processedCount, totalFilesProcessed: processedCount, producerChecksumSha256: z.optional(nativeDigest),
}).check(z.refine(manifest => manifest.kind !== 'dump' || manifest.producerChecksumSha256 !== undefined,
  { message: 'A dump manifest requires the successful producer checksum.' })));
export type DeploymentBackupManifestV1 = z.infer<typeof DeploymentBackupManifestV1Schema>;

/** Nonsecret configured destination; credentials remain with the native host. */
export const DeploymentBackupConfigurationV1Schema = lazyZodSchema(() => z.strictObject({
  configRevision: revision, destinationRef: BackupDestinationContributionV1Schema.shape.actions.shape.open,
  occurrenceId: text,
  config: z.pipe(z.pipe(StrictJsonValueSchema,
    z.transform((value: z.output<typeof StrictJsonValueSchema>): unknown => value)), z.record(z.string(), StrictJsonValueSchema)),
  credentialBindings: z.array(DeploymentBackupDestinationBindingIdentityV1Schema).check(z.refine(bindings =>
    new Set(bindings.map(environmentSecretBindingIdentityV1)).size === bindings.length,
  { message: 'Backup binding identities must be unique.' })),
  sources: z.array(DeploymentBackupSourceV1Schema).check(z.minLength(1), z.refine(sources =>
    new Set(sources.map(source => source.sourceId)).size === sources.length,
  { message: 'Backup source identities must be unique.' })),
  ownership: z.strictObject({ environmentId: id, prefix: z.string() }), retention: DeploymentBackupRetentionV1Schema,
}));
export type DeploymentBackupConfigurationV1 = z.infer<typeof DeploymentBackupConfigurationV1Schema>;
/** Standing backup intent excludes only the freshness revision resolved per occurrence. */
export const DeploymentBackupPolicyV1Schema = lazyZodSchema(() => z.omit(DeploymentBackupConfigurationV1Schema, { configRevision: true }));
export type DeploymentBackupPolicyV1 = z.infer<typeof DeploymentBackupPolicyV1Schema>;
export function deploymentBackupPolicyV1(configuration: DeploymentBackupConfigurationV1): DeploymentBackupPolicyV1 {
  const { configRevision: _configRevision, ...policy } = configuration;
  return policy;
}
/** Original source/configuration/native target, retained without credential values. */
export const DeploymentPreMigrationBackupV1Schema = lazyZodSchema(() => z.strictObject({
  source: DeploymentBackupManifestV1Schema, sourceFormat: z.literal('postgresCustom'),
  target: z.strictObject({ service: text, adapter: z.literal('postgres-v1'), database: text }),
  configuration: DeploymentBackupConfigurationV1Schema,
  repository: z.strictObject({ repository: text, s3: z.optional(z.strictObject({
    region: z.optional(text), addressing: z.optional(z.enum(['auto', 'dns', 'path'])),
  })) }),
}));
export type DeploymentPreMigrationBackupV1 = z.infer<typeof DeploymentPreMigrationBackupV1Schema>;
/** A consistent SQLite API snapshot retains its declared service-owned path. */
export const DeploymentSqliteBackupV1Schema = lazyZodSchema(() => z.strictObject({
  source: DeploymentBackupManifestV1Schema, sourceFormat: z.literal('sqlite'),
  target: z.strictObject({ service: text, adapter: z.literal('sqlite-v1'), path: text }),
  configuration: DeploymentBackupConfigurationV1Schema,
  repository: DeploymentPreMigrationBackupV1Schema.shape.repository,
}));
export type DeploymentSqliteBackupV1 = z.infer<typeof DeploymentSqliteBackupV1Schema>;
/** A volume retains the same repository/configuration custody as a logical dump. */
export const DeploymentBackupRestoreCaptureV1Schema = lazyZodSchema(() => z.union([
  DeploymentPreMigrationBackupV1Schema, DeploymentSqliteBackupV1Schema,
  z.strictObject({ source: DeploymentBackupManifestV1Schema, sourceFormat: z.literal('volume'),
    target: z.strictObject({ service: text, adapter: z.literal('volume-v1'), volume: text }),
    configuration: DeploymentBackupConfigurationV1Schema,
    repository: DeploymentPreMigrationBackupV1Schema.shape.repository }),
]));
export type DeploymentBackupRestoreCaptureV1 = z.infer<typeof DeploymentBackupRestoreCaptureV1Schema>;

/** Exact configured capture target; the installed host resolves configuration and credentials. */
export const DeploymentBackupTargetV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, environmentId: id, machineId: id, installationId: id, targetLinkId: id, deploymentId: id,
}));
export type DeploymentBackupTargetV1 = z.infer<typeof DeploymentBackupTargetV1Schema>;
const target = () => ({ ...DeploymentBackupTargetV1Schema.shape, expectedRevision: revision, configRevision: revision });
export const DeploymentBackupInventoryInputV1Schema = lazyZodSchema(() => z.strictObject(target()));
export const DeploymentBackupTestInputV1Schema = DeploymentBackupInventoryInputV1Schema;
export const DeploymentBackupHistoryInputV1Schema = DeploymentBackupInventoryInputV1Schema;
export const DeploymentBackupRunInputV1Schema = DeploymentBackupInventoryInputV1Schema;
export const DeploymentBackupVerifyInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), backupOperationId: id, snapshotId: nativeDigest, level: z.enum(['manifestReadBack', 'repositoryCheck']),
}));
/** Verification is resolved from existing terminal operations, never a changing approval operand. */
export const DeploymentBackupPruneInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), retention: DeploymentBackupRetentionV1Schema,
}));
export type DeploymentBackupInventoryInputV1 = z.infer<typeof DeploymentBackupInventoryInputV1Schema>;
export type DeploymentBackupTestInputV1 = z.infer<typeof DeploymentBackupTestInputV1Schema>;
export type DeploymentBackupHistoryInputV1 = z.infer<typeof DeploymentBackupHistoryInputV1Schema>;
export type DeploymentBackupRunInputV1 = z.infer<typeof DeploymentBackupRunInputV1Schema>;
export type DeploymentBackupVerifyInputV1 = z.infer<typeof DeploymentBackupVerifyInputV1Schema>;
export type DeploymentBackupPruneInputV1 = z.infer<typeof DeploymentBackupPruneInputV1Schema>;

/** Restic 0.19.1 scripting exit codes; native text and credentials never cross this boundary. */
export const DeploymentBackupTestResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('reachable'), repositoryId: nativeDigest }),
  z.strictObject({ kind: z.literal('failed'), step: z.literal('repository'),
    reason: z.enum(['repository_missing', 'native_failed']), nativeExitCode: z.number().check(z.int()),
    remedy: z.literal('review_destination') }),
  z.strictObject({ kind: z.literal('failed'), step: z.literal('repository'),
    reason: z.literal('repository_locked'), nativeExitCode: z.literal(11), remedy: z.literal('retry_after_operation') }),
  z.strictObject({ kind: z.literal('failed'), step: z.literal('repository'),
    reason: z.literal('repository_password_incorrect'), nativeExitCode: z.literal(12), remedy: z.literal('review_credentials') }),
  z.strictObject({ kind: z.literal('failed'), step: z.literal('repository'),
    reason: z.enum(['cancelled', 'outcome_unknown']), remedy: z.literal('retry') }),
]));
export type DeploymentBackupTestResultV1 = z.infer<typeof DeploymentBackupTestResultV1Schema>;

export const DeploymentBackupInventoryResultV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('inventory'), environmentId: id, configRevision: revision, repositoryId: nativeDigest,
  snapshots: z.array(z.strictObject({
    snapshot: DeploymentBackupSnapshotV1Schema, totalBytesProcessed: z.optional(processedCount),
    source: z.nullable(z.strictObject({ sourceId: text, kind: z.enum(['dump', 'volume']) })),
    verification: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('verified'), backupOperationId: id, configRevision: revision }),
      z.strictObject({ kind: z.literal('unknown'), reason: z.enum(['captureReceiptUnavailable', 'manifestUnavailable']) }),
    ]),
  })),
}));
export const DeploymentBackupRunResultV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('verified'), operationId: id, manifests: z.array(DeploymentBackupManifestV1Schema).check(z.minLength(1)),
  restoreCaptures: z.optional(z.array(DeploymentBackupRestoreCaptureV1Schema)),
}));
export const DeploymentBackupVerifyResultV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('verified'), operationId: id, backupOperationId: id, environmentId: id, configRevision: revision,
  repositoryId: nativeDigest, snapshotId: nativeDigest, level: z.enum(['manifestReadBack', 'repositoryCheck']), verified: z.literal(true),
}));
export const DeploymentBackupPruneResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pruned'), environmentId: id, configRevision: revision,
    forgottenSnapshotIds: z.array(nativeDigest) }),
  z.strictObject({ kind: z.literal('noop'), environmentId: id, configRevision: revision,
    forgottenSnapshotIds: z.array(nativeDigest).check(z.maxLength(0)) }),
]));
export type DeploymentBackupInventoryResultV1 = z.infer<typeof DeploymentBackupInventoryResultV1Schema>;
export type DeploymentBackupRunResultV1 = z.infer<typeof DeploymentBackupRunResultV1Schema>;
export type DeploymentBackupVerifyResultV1 = z.infer<typeof DeploymentBackupVerifyResultV1Schema>;
export type DeploymentBackupPruneResultV1 = z.infer<typeof DeploymentBackupPruneResultV1Schema>;

export const DeploymentBackupActionInputSchemasV1 = lazyDefinition(() => ({
  'deployments.backups.history': DeploymentBackupHistoryInputV1Schema,
  'deployments.backups.test': DeploymentBackupTestInputV1Schema,
  'deployments.backups.inventory': DeploymentBackupInventoryInputV1Schema,
  'deployments.backups.run': DeploymentBackupRunInputV1Schema,
  'deployments.backups.verify': DeploymentBackupVerifyInputV1Schema,
  'deployments.backups.prune': DeploymentBackupPruneInputV1Schema,
}));
export const DeploymentBackupActionResultSchemasV1 = lazyDefinition(() => ({
  'deployments.backups.history': DeploymentBackupHistoryResultV1Schema,
  'deployments.backups.test': DeploymentBackupTestResultV1Schema,
  'deployments.backups.inventory': DeploymentBackupInventoryResultV1Schema,
  'deployments.backups.run': DeploymentBackupRunResultV1Schema,
  'deployments.backups.verify': DeploymentBackupVerifyResultV1Schema,
  'deployments.backups.prune': DeploymentBackupPruneResultV1Schema,
}));
export type DeploymentBackupActionInputV1<TId extends DeploymentBackupActionIdV1 = DeploymentBackupActionIdV1> =
  z.infer<(typeof DeploymentBackupActionInputSchemasV1)[TId]>;
export type DeploymentBackupActionResultV1<TId extends DeploymentBackupActionIdV1 = DeploymentBackupActionIdV1> =
  z.infer<(typeof DeploymentBackupActionResultSchemasV1)[TId]>;
/** UI, CLI and agent callers build the same exact authored input through this schema owner. */
export function buildDeploymentBackupActionInputV1<TId extends DeploymentBackupActionIdV1>(
  actionId: TId, input: DeploymentBackupActionInputV1<TId>,
): DeploymentBackupActionInputV1<TId>;
export function buildDeploymentBackupActionInputV1(
  actionId: DeploymentBackupActionIdV1, input: DeploymentBackupActionInputV1,
): DeploymentBackupActionInputV1 {
  return DeploymentBackupActionInputSchemasV1[actionId].parse(input);
}
