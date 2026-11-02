import { DeploymentBackupManifestV1Schema, DeploymentBackupSnapshotV1Schema,
    type DeploymentBackupManifestV1, type DeploymentBackupSnapshotV1 } from '@happier-dev/deployment-protocol';

export type ResticSnapshotV1 = DeploymentBackupSnapshotV1;
export type BackupManifestV1 = DeploymentBackupManifestV1;
export type ResticBackupSummaryV1 = Readonly<{ snapshotId: string; totalBytesProcessed: number; totalFilesProcessed: number }>;

export function resticEvidenceFailureV1(code: 'backup_failed' | 'outcome_unknown'): never {
    throw Object.assign(new Error(code), { code });
}
export function readResticNativeRecordV1(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return resticEvidenceFailureV1('outcome_unknown');
    return value as Record<string, unknown>;
}
export function readResticNativeJsonV1(stdout: string): unknown {
    try { return JSON.parse(stdout); } catch { return resticEvidenceFailureV1('outcome_unknown'); }
}
function nativeValue<T>(read: () => T): T {
    try { return read(); } catch { return resticEvidenceFailureV1('outcome_unknown'); }
}

/** Native backup output is JSON Lines (status records followed by one terminal summary), not one document. */
export function readResticBackupSummaryV1(stdout: string, exitCode: number, stdoutTruncated = false): ResticBackupSummaryV1 {
    if (exitCode !== 0) return resticEvidenceFailureV1('backup_failed');
    if (stdoutTruncated) return resticEvidenceFailureV1('outcome_unknown');
    const rows = stdout.split(/\r?\n/u).filter(line => line.trim()).map(line => readResticNativeRecordV1(readResticNativeJsonV1(line)));
    const summaries = rows.filter(row => row.message_type === 'summary');
    const summary = summaries[0];
    if (!summary || summaries.length !== 1 || summary !== rows.at(-1) || summary.dry_run === true) return resticEvidenceFailureV1('outcome_unknown');
    return nativeValue(() => ({ snapshotId: DeploymentBackupSnapshotV1Schema.shape.snapshotId.parse(summary.snapshot_id),
        totalBytesProcessed: DeploymentBackupManifestV1Schema.shape.totalBytesProcessed.parse(summary.total_bytes_processed),
        totalFilesProcessed: DeploymentBackupManifestV1Schema.shape.totalFilesProcessed.parse(summary.total_files_processed) }));
}

export function readResticRepositoryConfigV1(stdout: string, exitCode: number, stdoutTruncated = false): Readonly<{ repositoryId: string; repositoryVersion: 2 }> {
    if (exitCode !== 0) return resticEvidenceFailureV1('backup_failed');
    if (stdoutTruncated) return resticEvidenceFailureV1('outcome_unknown');
    const config = readResticNativeRecordV1(readResticNativeJsonV1(stdout));
    if (config.version !== 2) return resticEvidenceFailureV1('backup_failed');
    return { repositoryVersion: 2, repositoryId: nativeValue(() => DeploymentBackupManifestV1Schema.shape.repositoryId.parse(config.id)) };
}

export function readResticNativeSnapshotV1(value: unknown): ResticSnapshotV1 {
    const snapshot = readResticNativeRecordV1(value);
    return nativeValue(() => DeploymentBackupSnapshotV1Schema.parse({ snapshotId: snapshot.id, treeId: snapshot.tree,
        hostname: snapshot.hostname, time: snapshot.time, paths: snapshot.paths, tags: snapshot.tags }));
}
export function readResticSnapshotsV1(stdout: string, exitCode: number, stdoutTruncated = false): ResticSnapshotV1[] {
    if (exitCode !== 0) return resticEvidenceFailureV1('backup_failed');
    if (stdoutTruncated) return resticEvidenceFailureV1('outcome_unknown');
    const snapshots = readResticNativeJsonV1(stdout);
    if (!Array.isArray(snapshots)) return resticEvidenceFailureV1('outcome_unknown');
    return snapshots.map(readResticNativeSnapshotV1);
}
export function isResticSnapshotOwnedV1(snapshot: ResticSnapshotV1, environmentId: string): boolean {
    return snapshot.hostname === `happier-env-${environmentId}` && snapshot.tags.includes('happier')
        && snapshot.tags.includes(`env:${environmentId}`);
}

/** Bind already-normalized native evidence; do not parse a manifest we just constructed. */
export function readResticBackupManifestV1(input: Readonly<{ summary: ResticBackupSummaryV1; snapshots: readonly ResticSnapshotV1[];
    environmentId: string; sourceId: string; configRevision: number; repositoryId: string;
} & ({ kind: 'dump'; producerChecksumSha256: string } | { kind: 'volume' })>): BackupManifestV1 {
    const snapshot = input.snapshots.find(snapshot => snapshot.snapshotId === input.summary.snapshotId);
    if (!snapshot || input.snapshots.length !== 1 || !isResticSnapshotOwnedV1(snapshot, input.environmentId)
        || !snapshot.tags.includes(`kind:${input.kind}`) || !snapshot.tags.includes(`src:${input.sourceId}`)) return resticEvidenceFailureV1('outcome_unknown');
    return { schemaVersion: 1, environmentId: input.environmentId, sourceId: input.sourceId, kind: input.kind,
        configRevision: input.configRevision, repositoryId: input.repositoryId, snapshot,
        totalBytesProcessed: input.summary.totalBytesProcessed, totalFilesProcessed: input.summary.totalFilesProcessed,
        ...(input.kind === 'dump' ? { producerChecksumSha256: input.producerChecksumSha256 } : {}) };
}
