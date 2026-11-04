import type { DeploymentBackupRetentionV1 } from '@happier-dev/deployment-protocol';
import { isResticSnapshotOwnedV1, readResticNativeJsonV1, readResticNativeRecordV1,
    readResticNativeSnapshotV1, resticEvidenceFailureV1 } from './manifestV1.js';

export type BackupRetentionV1 = DeploymentBackupRetentionV1;

/** Omission is not a policy. Keep everything has no native forget request. */
export function buildResticRetentionArgsV1(retention: BackupRetentionV1): string[] {
    if (retention.kind === 'keepEverything') return [];
    const args: string[] = [];
    for (const key of ['last', 'daily', 'weekly', 'monthly'] as const) {
        const count = retention[key];
        if (count === undefined) continue;
        args.push(`--keep-${key}`, String(count));
    }
    return args;
}

/** Restic decides retention policy; this owner narrows its dry-run removals to owned, unprotected exact snapshots. */
export function selectResticForgetCandidatesV1(input: Readonly<{ stdout: string; exitCode: number; environmentId: string;
    protectedSnapshotIds: readonly string[] }>): string[] {
    if (input.exitCode !== 0) return resticEvidenceFailureV1('backup_failed');
    if (!input.stdout.trim()) return [];
    const groups = readResticNativeJsonV1(input.stdout);
    if (!Array.isArray(groups)) return resticEvidenceFailureV1('outcome_unknown');
    const protectedIds = new Set(input.protectedSnapshotIds), seen = new Set<string>();
    const candidates: string[] = [];
    for (const raw of groups) {
        const group = readResticNativeRecordV1(raw);
        if (group.remove === null || group.remove === undefined) continue;
        if (!Array.isArray(group.remove)) return resticEvidenceFailureV1('outcome_unknown');
        for (const value of group.remove) {
            const snapshot = readResticNativeSnapshotV1(value);
            if (!isResticSnapshotOwnedV1(snapshot, input.environmentId)) {
                throw Object.assign(new Error('backup_integrity_failed'), { code: 'backup_integrity_failed' });
            }
            if (seen.has(snapshot.snapshotId)) continue;
            seen.add(snapshot.snapshotId);
            if (!protectedIds.has(snapshot.snapshotId)) candidates.push(snapshot.snapshotId);
        }
    }
    return candidates;
}
