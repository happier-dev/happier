import { z } from 'zod/mini';
import { BackupDestinationContributionV1Schema, DeploymentBackupDestinationBindingIdentityV1Schema,
    DeploymentEnvironmentUpdateInputV1Schema, StrictJsonValueSchema, environmentSecretBindingIdentityV1,
    compilePluginJsonSchema, isValidPluginJsonSchemaValue, type BackupDestinationContributionV1 } from '@happier-dev/protocol';

import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision, DeploymentTextV1Schema as text } from './ids.js';

/** Deployment V1 persisted metadata is closed, including each source and policy arm. */
export const DeploymentBackupSourceV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dump'), sourceId: text, service: text, consistency: z.literal('logical') }),
    z.strictObject({ kind: z.literal('volume'), sourceId: text, service: text, volume: text, consistency: z.literal('stopDuringCopy') }),
]);
export type DeploymentBackupSourceV1 = z.infer<typeof DeploymentBackupSourceV1Schema>;

const keepCount = z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER));
export const DeploymentBackupRetentionV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('keepEverything') }),
    z.strictObject({ kind: z.literal('keep'), last: z.optional(keepCount), daily: z.optional(keepCount),
        weekly: z.optional(keepCount), monthly: z.optional(keepCount) }).check(z.refine(policy =>
        policy.last !== undefined || policy.daily !== undefined || policy.weekly !== undefined || policy.monthly !== undefined,
    { message: 'A keep policy requires at least one person-selected count.' })),
]);
export type DeploymentBackupRetentionV1 = z.infer<typeof DeploymentBackupRetentionV1Schema>;

/** Opaque configuration is preserved JSON; the selected descriptor admits its closed fields before use. */
export const DeploymentBackupConfigurationV1Schema = z.strictObject({
    configRevision: revision,
    destinationRef: BackupDestinationContributionV1Schema.shape.actions.shape.open,
    occurrenceId: text,
    config: z.pipe(
        // Preserve root normalization; widen only the static handoff to the record parser.
        z.pipe(StrictJsonValueSchema, z.transform((value: z.output<typeof StrictJsonValueSchema>): unknown => value)),
        z.record(z.string(), StrictJsonValueSchema),
    ),
    credentialBindings: z.array(DeploymentBackupDestinationBindingIdentityV1Schema).check(z.refine(bindings =>
        new Set(bindings.map(environmentSecretBindingIdentityV1)).size === bindings.length,
    { message: 'Backup binding identities must be unique.' })),
    sources: z.array(DeploymentBackupSourceV1Schema).check(z.minLength(1), z.refine(sources =>
        new Set(sources.map(source => source.sourceId)).size === sources.length,
    { message: 'Backup source identities must be unique.' })),
    ownership: z.strictObject({ environmentId: id, prefix: z.string() }),
    retention: DeploymentBackupRetentionV1Schema,
});
export type DeploymentBackupConfigurationV1 = z.infer<typeof DeploymentBackupConfigurationV1Schema>;
export const DeploymentEnvironmentBackupV1Schema = z.union([
    DeploymentBackupConfigurationV1Schema, z.strictObject({ notNeeded: z.literal(true) }),
]);
export type DeploymentEnvironmentBackupV1 = z.infer<typeof DeploymentEnvironmentBackupV1Schema>;

/** Configure's private metadata write retains the existing Artifact CAS, without a generic patch. */
export const DeploymentEnvironmentBackupSetInputV1Schema = z.omit(DeploymentEnvironmentUpdateInputV1Schema, { patch: true });
export type DeploymentEnvironmentBackupSetInputV1 = z.infer<typeof DeploymentEnvironmentBackupSetInputV1Schema>;

/** Restic 0.19.1 native repository, snapshot and tree identities are full SHA-256 hex strings. */
const nativeDigest = z.string().check(z.regex(/^[0-9a-f]{64}$/u));
export const DeploymentBackupSnapshotV1Schema = z.strictObject({
    snapshotId: nativeDigest, treeId: nativeDigest, hostname: text,
    time: z.iso.datetime({ offset: true }), paths: z.array(text), tags: z.array(text),
});
export type DeploymentBackupSnapshotV1 = z.infer<typeof DeploymentBackupSnapshotV1Schema>;

const processedCount = z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER));
export const DeploymentBackupManifestV1Schema = z.strictObject({
    schemaVersion: z.literal(1), environmentId: id, sourceId: text, kind: z.enum(['dump', 'volume']),
    configRevision: revision, repositoryId: nativeDigest, snapshot: DeploymentBackupSnapshotV1Schema,
    totalBytesProcessed: processedCount, totalFilesProcessed: processedCount,
    producerChecksumSha256: z.optional(nativeDigest),
}).check(z.refine(manifest => manifest.kind !== 'dump' || manifest.producerChecksumSha256 !== undefined,
{ message: 'A dump manifest requires the successful producer checksum.' }));
export type DeploymentBackupManifestV1 = z.infer<typeof DeploymentBackupManifestV1Schema>;

/** Nonsecret recovery operands retained in the existing pre-migration receipt.
 * Credentials are acquired afresh through P42; restore names belong to admission. */
export const DeploymentPreMigrationBackupV1Schema = z.strictObject({
    source: DeploymentBackupManifestV1Schema,
    sourceFormat: z.literal('postgresCustom'),
    target: z.strictObject({ service: text, adapter: z.literal('postgres-v1'), database: text }),
    configuration: DeploymentBackupConfigurationV1Schema,
    repository: z.strictObject({ repository: text, s3: z.optional(z.strictObject({
        region: z.optional(text), addressing: z.optional(z.enum(['auto', 'dns', 'path'])),
    })) }),
});
export type DeploymentPreMigrationBackupV1 = z.infer<typeof DeploymentPreMigrationBackupV1Schema>;

/** The catalog has admitted the descriptor; its schema alone decides the nonsecret user fields. */
export function validateDeploymentBackupDestinationConfigurationV1(input: Readonly<{
    descriptor: BackupDestinationContributionV1; config: unknown;
}>): boolean {
    return isValidPluginJsonSchemaValue(compilePluginJsonSchema(input.descriptor.configSchema), input.config);
}
