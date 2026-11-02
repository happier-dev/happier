import { DeploymentBackupManifestV1Schema, DeploymentBackupSnapshotV1Schema,
    type DeploymentBackupConfigurationV1, type DeploymentBackupSourceV1, type DeploymentEnvironmentContentV1,
    type DeploymentPreMigrationBackupV1 } from '@happier-dev/deployment-protocol';

import { buildResticRequestV1, type ResticAccessV1, type ResticCommandV1, type ResticRequestV1 } from '../backups/resticExecutor.js';
import { readResticBackupManifestV1, readResticBackupSummaryV1, readResticNativeJsonV1, readResticNativeRecordV1,
    readResticRepositoryConfigV1, readResticSnapshotsV1, type BackupManifestV1 } from '../backups/manifestV1.js';

/** Facts supplied by the canonical native execution adapter; dump bytes never cross this result. */
export type DeploymentBackupNativeResultV1 = Readonly<{ kind: 'outcome_unknown' }> | Readonly<{
    kind: 'completed'; exitCode: number; stdout: string; stdoutTruncated: boolean;
    producer?: Readonly<{ exitCode: number; checksumSha256: string }>;
    stdoutChecksumSha256?: string; stdoutBytes?: number;
}>;
export type DeploymentBackupRunResultV1 = Readonly<{ kind: 'verified'; manifests: readonly BackupManifestV1[] }>;
type CapturedData = NonNullable<NonNullable<DeploymentEnvironmentContentV1['template']>['data']>;
export type DeploymentBackupRunInputV1 = Readonly<{
    environmentId: string; configuration: DeploymentBackupConfigurationV1; data?: CapturedData;
    access: ResticAccessV1; signal: AbortSignal;
    /** The pre-migration caller binds this completion to its existing receipt CAS.
     * A verified backup is not returned until its recovery capture is retained. */
    preMigrationBackup?: Readonly<Pick<DeploymentPreMigrationBackupV1, 'sourceFormat' | 'target'> & {
        writeCapture(capture: DeploymentPreMigrationBackupV1): Promise<void>;
    }>;
    /** ONE retained native capture of ONE prepared phase. The host releases it only after this whole call settles.
     * It retains template/binding facts privately, resolves declaration keys at their owner, and owns producer argv,
     * stream/checksum/terminal custody. Never rematerialize secrets or consume a single-use attachment per step. */
    execute: (request: ResticRequestV1, source?: DeploymentBackupSourceV1) => Promise<DeploymentBackupNativeResultV1>;
}>;
type FailureCode = 'backup_failed' | 'backup_integrity_failed' | 'outcome_unknown' | 'cancelled' | 'unsupported_action';
type SnapshotEvidence = Readonly<{ environmentId: string; sourceId: string; configRevision: number; repositoryId: string; snapshotId: string }>;
function refuse(code: FailureCode): never { throw Object.assign(new Error(code), { code }); }
function failureCode(error: unknown): FailureCode {
    if (error && typeof error === 'object' && 'code' in error) {
        const code = error.code;
        if (code === 'backup_failed' || code === 'backup_integrity_failed' || code === 'cancelled' || code === 'unsupported_action') return code;
    }
    return 'outcome_unknown';
}

/** Current config/data have already crossed admission/storage decoding. This owner trusts that capture, not caller revisions/subsets.
 * Native JSON and raw-stream checksum facts are normalized here; verified is returned only after exact payload read-back.
 * Public Action activation additionally requires the real P30/P42 adapter. This function is not a second process runner. */
export async function runDeploymentBackupV1(input: DeploymentBackupRunInputV1): Promise<DeploymentBackupRunResultV1> {
    const manifests: BackupManifestV1[] = [], snapshots: SnapshotEvidence[] = [];
    const checkCancelled = () => { if (input.signal.aborted) refuse('cancelled'); };
    const execute = async (command: ResticCommandV1, source?: DeploymentBackupSourceV1) => {
        checkCancelled();
        const result = await input.execute(buildResticRequestV1({ environmentId: input.environmentId, access: input.access, command }), source);
        if (result.kind === 'outcome_unknown') return refuse('outcome_unknown');
        return result;
    };
    try {
        checkCancelled();
        const recording = input.preMigrationBackup;
        if (recording && (input.data?.logicalBackup?.adapter !== 'postgres-v1'
            || input.data.service !== recording.target.service
            || input.configuration.sources.filter(source => source.kind === 'dump' && source.service === recording.target.service).length !== 1)) {
            return refuse('unsupported_action');
        }
        const recipes = input.configuration.sources.map(source => {
            const data = input.data;
            if (source.kind !== 'dump' || !data?.logicalBackup || source.service !== data.service) return refuse('unsupported_action');
            const adapter = data.logicalBackup.adapter;
            // SQLite VACUUM produces an owned file, not stdout. Volume stop-copy also needs its real native producer.
            if (adapter === 'sqlite-v1') return refuse('unsupported_action');
            const extension = { 'postgres-v1': 'dump', 'mysql-v1': 'sql', 'mongo-v1': 'archive.gz' }[adapter];
            return { source, filename: `${source.service}.${extension}` };
        });
        const configResult = await execute({ kind: 'config' });
        const { repositoryId } = readResticRepositoryConfigV1(configResult.stdout, configResult.exitCode, configResult.stdoutTruncated);
        for (const { source, filename } of recipes) {
            const backup = await execute({ kind: 'backupStdin', sourceId: source.sourceId, filename }, source);
            if (!backup.producer || backup.producer.exitCode !== 0) return refuse('backup_failed');
            const summary = readResticBackupSummaryV1(backup.stdout, backup.exitCode, backup.stdoutTruncated);
            snapshots.push({ environmentId: input.environmentId, sourceId: source.sourceId,
                configRevision: input.configuration.configRevision, repositoryId, snapshotId: summary.snapshotId });
            const producerChecksumSha256 = DeploymentBackupSnapshotV1Schema.shape.snapshotId.parse(backup.producer.checksumSha256);
            const inventory = await execute({ kind: 'snapshots', snapshotId: summary.snapshotId });
            const manifest = readResticBackupManifestV1({ summary, snapshots: readResticSnapshotsV1(inventory.stdout, inventory.exitCode, inventory.stdoutTruncated),
                environmentId: input.environmentId, sourceId: source.sourceId, kind: 'dump',
                configRevision: input.configuration.configRevision, repositoryId, producerChecksumSha256 });
            manifests.push(manifest);
            const tree = await execute({ kind: 'tree', treeId: manifest.snapshot.treeId });
            if (tree.exitCode !== 0) return refuse('backup_failed');
            if (tree.stdoutTruncated) return refuse('outcome_unknown');
            const nativeTree = readResticNativeRecordV1(readResticNativeJsonV1(tree.stdout));
            if (!Array.isArray(nativeTree.nodes)) return refuse('outcome_unknown');
            const nodes = nativeTree.nodes.map(readResticNativeRecordV1);
            const file = nodes.find(node => node.name === filename && node.type === 'file');
            if (!file) return refuse('backup_integrity_failed');
            const size = DeploymentBackupManifestV1Schema.shape.totalBytesProcessed.parse(file.size);
            if (size !== manifest.totalBytesProcessed) return refuse('backup_integrity_failed');
            const payload = await execute({ kind: 'dump', snapshotId: summary.snapshotId, path: `/${filename}` });
            if (payload.exitCode !== 0) return refuse('backup_failed');
            // Payload capture may be bounded/omitted; only the same native byte stream's digest/count are evidence.
            const checksum = DeploymentBackupSnapshotV1Schema.shape.snapshotId.parse(payload.stdoutChecksumSha256);
            const bytes = DeploymentBackupManifestV1Schema.shape.totalBytesProcessed.parse(payload.stdoutBytes);
            if (checksum !== manifest.producerChecksumSha256 || bytes !== size) return refuse('backup_integrity_failed');
        }
        checkCancelled();
    } catch (error) {
        const code = failureCode(error);
        throw Object.assign(new Error(code), { code, details: { snapshots, manifests } });
    }
    const recording = input.preMigrationBackup;
    if (recording) {
        const selected = input.configuration.sources.find(source => source.kind === 'dump' && source.service === recording.target.service)!;
        const source = manifests.find(manifest => manifest.sourceId === selected.sourceId)!;
        await recording.writeCapture({ source, sourceFormat: recording.sourceFormat, target: recording.target,
            configuration: input.configuration, repository: { repository: input.access.repository,
                ...(input.access.s3 ? { s3: input.access.s3 } : {}) } });
    }
    return { kind: 'verified', manifests };
}
