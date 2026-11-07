import { z } from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentTextV1Schema as text } from './storedAppInputV1.js';
import type { DeploymentBackupActionIdV1 } from './deploymentActionIdsV1.js';

/** Shared backup evidence and policy: deployment-protocol consumes this same closed wire owner. */
export const DeploymentBackupSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dump'), sourceId: text, service: text, consistency: z.literal('logical') }),
  z.strictObject({ kind: z.literal('volume'), sourceId: text, service: text, volume: text, consistency: z.literal('stopDuringCopy') }),
]));
export type DeploymentBackupSourceV1 = z.infer<typeof DeploymentBackupSourceV1Schema>;
const keepCount = lazyZodSchema(() => z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)));
export const DeploymentBackupRetentionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('keepEverything') }),
  z.strictObject({ kind: z.literal('keep'), last: z.optional(keepCount), daily: z.optional(keepCount),
    weekly: z.optional(keepCount), monthly: z.optional(keepCount) }).check(z.refine(policy =>
    policy.last !== undefined || policy.daily !== undefined || policy.weekly !== undefined || policy.monthly !== undefined,
  { message: 'A keep policy requires at least one person-selected count.' })),
]));
export type DeploymentBackupRetentionV1 = z.infer<typeof DeploymentBackupRetentionV1Schema>;
/** Restic 0.19.1 repository, snapshot and tree identities are full SHA-256 hex strings. */
const nativeDigest = lazyZodSchema(() => z.string().check(z.regex(/^[0-9a-f]{64}$/u)));
const processedCount = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
export const DeploymentBackupSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  snapshotId: nativeDigest, treeId: nativeDigest, hostname: text,
  time: z.iso.datetime({ offset: true }), paths: z.array(text), tags: z.array(text),
}));
export type DeploymentBackupSnapshotV1 = z.infer<typeof DeploymentBackupSnapshotV1Schema>;
export const DeploymentBackupManifestV1Schema = lazyZodSchema(() => z.strictObject({
  schemaVersion: z.literal(1), environmentId: id, sourceId: text, kind: z.enum(['dump', 'volume']),
  configRevision: revision, repositoryId: nativeDigest, snapshot: DeploymentBackupSnapshotV1Schema,
  totalBytesProcessed: processedCount, totalFilesProcessed: processedCount, producerChecksumSha256: z.optional(nativeDigest),
}).check(z.refine(manifest => manifest.kind !== 'dump' || manifest.producerChecksumSha256 !== undefined,
  { message: 'A dump manifest requires the successful producer checksum.' })));
export type DeploymentBackupManifestV1 = z.infer<typeof DeploymentBackupManifestV1Schema>;

/** Exact configured capture target; the installed host resolves configuration and credentials. */
export const DeploymentBackupTargetV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, environmentId: id, machineId: id, installationId: id, targetLinkId: id, deploymentId: id,
}));
export type DeploymentBackupTargetV1 = z.infer<typeof DeploymentBackupTargetV1Schema>;
const target = () => ({ ...DeploymentBackupTargetV1Schema.shape, expectedRevision: revision, configRevision: revision });
export const DeploymentBackupInventoryInputV1Schema = lazyZodSchema(() => z.strictObject(target()));
export const DeploymentBackupRunInputV1Schema = DeploymentBackupInventoryInputV1Schema;
export const DeploymentBackupVerifyInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), backupOperationId: id, snapshotId: nativeDigest, level: z.enum(['manifestReadBack', 'repositoryCheck']),
}));
/** Verification is resolved from existing terminal operations, never a changing approval operand. */
export const DeploymentBackupPruneInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), retention: DeploymentBackupRetentionV1Schema,
}));
export type DeploymentBackupInventoryInputV1 = z.infer<typeof DeploymentBackupInventoryInputV1Schema>;
export type DeploymentBackupRunInputV1 = z.infer<typeof DeploymentBackupRunInputV1Schema>;
export type DeploymentBackupVerifyInputV1 = z.infer<typeof DeploymentBackupVerifyInputV1Schema>;
export type DeploymentBackupPruneInputV1 = z.infer<typeof DeploymentBackupPruneInputV1Schema>;

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
  'deployments.backups.inventory': DeploymentBackupInventoryInputV1Schema,
  'deployments.backups.run': DeploymentBackupRunInputV1Schema,
  'deployments.backups.verify': DeploymentBackupVerifyInputV1Schema,
  'deployments.backups.prune': DeploymentBackupPruneInputV1Schema,
}));
export const DeploymentBackupActionResultSchemasV1 = lazyDefinition(() => ({
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
