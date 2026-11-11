import { DeploymentBackupSnapshotV1Schema, readDeploymentBackupMaintenanceFailureEvidenceV1,
    type DeploymentBackupConfigurationV1, type DeploymentBackupSourceV1, type DeploymentEnvironmentContentV1,
    type DeploymentPreMigrationBackupV1, type DeploymentBackupRestoreCaptureV1 } from '@happier-dev/deployment-protocol';

import { buildResticRequestV1, RESTIC_VOLUME_SOURCE_PATH_V1, type ResticAccessV1, type ResticCommandV1, type ResticRequestV1 } from '../backups/resticExecutor.js';
import { readResticBackupManifestV1, readResticBackupSummaryV1,
    readResticRepositoryConfigV1, readResticRepositoryInitializationV1, readResticSnapshotsV1, type BackupManifestV1 } from '../backups/manifestV1.js';
import { backupOperationStepV1, readBackDeploymentBackupManifestV1 } from '../backups/verificationV1.js';

/** Facts supplied by the canonical native execution adapter; dump bytes never cross this result. */
export type DeploymentBackupNativeResultV1 = Readonly<{ kind: 'outcome_unknown' }> | Readonly<{
    kind: 'completed'; exitCode: number; stdout: string; stdoutTruncated: boolean;
    /** Captured stderr has already crossed the admitted native owner's credential redactor. */
    stderr?: string; stderrTruncated?: boolean;
    producer?: Readonly<{ exitCode: number; checksumSha256: string }>;
    stdoutChecksumSha256?: string; stdoutBytes?: number;
}>;
export type DeploymentBackupRunResultV1 = Readonly<{ kind: 'verified'; manifests: readonly BackupManifestV1[];
    restoreCaptures?: readonly DeploymentBackupRestoreCaptureV1[] }>;
type CapturedData = NonNullable<NonNullable<DeploymentEnvironmentContentV1['template']>['data']>[number];
export type DeploymentBackupRunInputV1 = Readonly<{
    environmentId: string; configuration: DeploymentBackupConfigurationV1; data?: readonly CapturedData[];
    access: ResticAccessV1; signal: AbortSignal;
    /** The admitted host publishes this run's outcome, including safety/pre-migration runs. */
    onSettled?(outcome: 'succeeded' | 'failed' | 'outcome_unknown' | 'cancelled', configRevision: number): Promise<void>;
    /** Exact database resolved by the admitted native producer, never a binding key. */
    restoreTargets?: readonly DeploymentBackupRestoreCaptureV1['target'][];
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
function refuse(code: FailureCode, step?: string): never { throw Object.assign(new Error(code), { code, ...(step ? { step } : {}) }); }
function failureCode(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error) {
        const code = error.code;
        if (typeof code === 'string') return code;
    }
    return 'outcome_unknown';
}

/** Canonical producer filenames also identify the supported legacy dump format. */
export function deploymentBackupDumpFilenameV1(adapter: NonNullable<CapturedData['logicalBackup']>['adapter'], service: string): string {
    return `${service}.${{ 'postgres-v1': 'dump', 'mysql-v1': 'sql', 'mongo-v1': 'archive.gz', 'sqlite-v1': 'sqlite' }[adapter]}`;
}

/** Current config/data have already crossed admission/storage decoding. This owner trusts that capture, not caller revisions/subsets.
 * Native JSON and raw-stream checksum facts are normalized here; verified is returned only after exact payload read-back.
 * Public Action activation additionally requires the real P30/P42 adapter. This function is not a second process runner. */
export async function runDeploymentBackupV1(input: DeploymentBackupRunInputV1): Promise<DeploymentBackupRunResultV1> {
    let result: DeploymentBackupRunResultV1;
    try { result = await executeDeploymentBackup(input); }
    catch (error) {
        const code = failureCode(error);
        await input.onSettled?.(code === 'outcome_unknown' || code === 'cancelled' ? code : 'failed', input.configuration.configRevision);
        throw error;
    }
    await input.onSettled?.('succeeded', input.configuration.configRevision);
    return result;
}

async function executeDeploymentBackup(input: DeploymentBackupRunInputV1): Promise<DeploymentBackupRunResultV1> {
    const manifests: BackupManifestV1[] = [], snapshots: SnapshotEvidence[] = [];
    const restoreCaptures: DeploymentBackupRestoreCaptureV1[] = [];
    const repository = { repository: input.access.repository, ...(input.access.s3 ? { s3: input.access.s3 } : {}) };
    const checkCancelled = () => { if (input.signal.aborted) refuse('cancelled', 'backup'); };
    const execute = async (command: ResticCommandV1, source?: DeploymentBackupSourceV1) => {
        return backupOperationStepV1(command.kind, async () => {
            checkCancelled();
            const result = await input.execute(buildResticRequestV1({ environmentId: input.environmentId, access: input.access, command }), source);
            if (result.kind === 'outcome_unknown') return refuse('outcome_unknown');
            return result;
        });
    };
    try {
        checkCancelled();
        const recording = input.preMigrationBackup;
        const recordingData = recording && input.data?.find(row => row.service === recording.target.service);
        if (recording && (recordingData?.logicalBackup?.adapter !== 'postgres-v1'
            || input.configuration.sources.filter(source => source.kind === 'dump' && source.service === recording.target.service).length !== 1)) {
            return refuse('unsupported_action');
        }
        const recipes = input.configuration.sources.map(source => {
            if (source.kind === 'volume') return { source, filename: undefined, data: undefined };
            const data = input.data?.find(row => row.service === source.service);
            if (source.kind !== 'dump' || !data?.logicalBackup || source.service !== data.service) return refuse('unsupported_action');
            const adapter = data.logicalBackup.adapter;
            if (adapter === 'sqlite-v1' && !data.logicalBackup.path) return refuse('unsupported_action');
            return { source, data, filename: deploymentBackupDumpFilenameV1(adapter, source.service) };
        });
        const configResult = await execute({ kind: 'config' });
        // The pinned restic's exit 10 positively classifies an absent repository
        // (S3 NoSuchKey). Authentication, transport and all other failures stay failures.
        // Only this writing lifecycle initializes; read-only maintenance never does.
        const initialized = configResult.exitCode === 10 ? await execute({ kind: 'init' }) : undefined;
        const { repositoryId } = initialized
            ? await backupOperationStepV1('init', () => readResticRepositoryInitializationV1(
                initialized.stdout, initialized.exitCode, initialized.stdoutTruncated), initialized)
            : await backupOperationStepV1('repository', () =>
                readResticRepositoryConfigV1(configResult.stdout, configResult.exitCode, configResult.stdoutTruncated), configResult);
        for (const { source, filename, data } of recipes) {
            const backup = await execute(source.kind === 'volume'
                ? { kind: 'backupPaths', sourceId: source.sourceId, paths: [RESTIC_VOLUME_SOURCE_PATH_V1] }
                : { kind: 'backupStdin', sourceId: source.sourceId, filename: filename! }, source);
            if (source.kind === 'dump' && (!backup.producer || backup.producer.exitCode !== 0)) {
                return backupOperationStepV1('producer', () => refuse('backup_failed', 'producer'), backup);
            }
            const summary = await backupOperationStepV1('backup', () => readResticBackupSummaryV1(backup.stdout, backup.exitCode, backup.stdoutTruncated), backup);
            snapshots.push({ environmentId: input.environmentId, sourceId: source.sourceId,
                configRevision: input.configuration.configRevision, repositoryId, snapshotId: summary.snapshotId });
            const producerChecksumSha256 = source.kind === 'dump' ? await backupOperationStepV1('producer', () =>
                DeploymentBackupSnapshotV1Schema.shape.snapshotId.parse(backup.producer!.checksumSha256)) : undefined;
            const inventory = await execute({ kind: 'snapshots', snapshotId: summary.snapshotId });
            const manifest = await backupOperationStepV1('snapshot', () => readResticBackupManifestV1({ summary,
                snapshots: readResticSnapshotsV1(inventory.stdout, inventory.exitCode, inventory.stdoutTruncated),
                environmentId: input.environmentId, sourceId: source.sourceId,
                configRevision: input.configuration.configRevision, repositoryId,
                ...(source.kind === 'dump' ? { kind: 'dump', producerChecksumSha256: producerChecksumSha256! } : { kind: 'volume' }) }), inventory);
            manifests.push(manifest);
            await readBackDeploymentBackupManifestV1({ ...input, manifest });
            if (source.kind === 'volume') {
                restoreCaptures.push({ source: manifest, sourceFormat: 'volume',
                    target: { service: source.service, adapter: 'volume-v1', volume: source.volume },
                    configuration: input.configuration, repository });
            } else if (data?.logicalBackup?.adapter === 'sqlite-v1') {
                restoreCaptures.push({ source: manifest, sourceFormat: 'sqlite',
                    target: { service: source.service, adapter: 'sqlite-v1', path: data.logicalBackup.path! },
                    configuration: input.configuration, repository });
            } else {
                const target = recording?.target.service === source.service ? recording.target
                    : input.restoreTargets?.find(target => target.service === source.service);
                if (target) {
                    if (data?.logicalBackup?.adapter !== 'postgres-v1' || target.adapter !== 'postgres-v1') return refuse('unsupported_action');
                    restoreCaptures.push({ source: manifest, sourceFormat: 'postgresCustom',
                        target: { service: target.service, adapter: target.adapter, database: target.database },
                        configuration: input.configuration, repository });
                }
            }
        }
        checkCancelled();
    } catch (error) {
        const code = failureCode(error);
        const step = error && typeof error === 'object' && 'step' in error ? error.step : 'source';
        throw Object.assign(new Error(code), { code, step,
            details: { snapshots, manifests, ...readDeploymentBackupMaintenanceFailureEvidenceV1(error) } });
    }
    const recording = input.preMigrationBackup;
    if (recording) {
        const capture = restoreCaptures.find((item): item is DeploymentPreMigrationBackupV1 => item.sourceFormat === 'postgresCustom' && input.configuration.sources.some(source =>
            source.sourceId === item.source.sourceId && source.kind === 'dump' && source.service === recording.target.service))!;
        await recording.writeCapture(capture);
    }
    return { kind: 'verified', manifests, ...(restoreCaptures.length ? { restoreCaptures } : {}) };
}
