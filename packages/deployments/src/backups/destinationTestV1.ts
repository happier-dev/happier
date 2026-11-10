import { readDeploymentBackupMaintenanceFailureEvidenceV1, type DeploymentBackupTestResultV1 } from '@happier-dev/deployment-protocol';
import { readResticBackupSummaryV1, readResticRepositoryConfigV1, readResticRepositoryInitializationV1 } from './manifestV1.js';
import { buildResticRequestV1 } from './resticExecutor.js';
import { backupOperationFailureV1, executeBackupOperationStepV1, type DeploymentBackupReadInputV1 } from './verificationV1.js';

/** Prove write/read/delete through the admitted native owner. Probe snapshots never enter backup inventory. */
export async function testDeploymentBackupDestinationV1(input: DeploymentBackupReadInputV1 & Readonly<{
    operationId: string; initializeIfMissing?: boolean;
}>): Promise<DeploymentBackupTestResultV1> {
    const uncertain = (): DeploymentBackupTestResultV1 => ({ kind: 'failed', step: 'repository',
        reason: input.signal.aborted ? 'cancelled' : 'outcome_unknown', remedy: 'retry' });
    if (input.signal.aborted) return uncertain();
    try {
        let result = await input.execute(buildResticRequestV1({ environmentId: input.environmentId,
            access: input.access, command: { kind: 'config' } }));
        if (input.signal.aborted || result.kind === 'outcome_unknown') return uncertain();
        const initializing = result.exitCode === 10 && input.initializeIfMissing === true;
        if (initializing) {
            result = await input.execute(buildResticRequestV1({ environmentId: input.environmentId,
                access: input.access, command: { kind: 'init' } }));
            if (input.signal.aborted || result.kind === 'outcome_unknown') return uncertain();
        }
        if (result.exitCode === 11) return { kind: 'failed', reason: 'repository_locked', step: 'repository',
            nativeExitCode: result.exitCode, remedy: 'retry_after_operation' };
        if (result.exitCode === 12) return { kind: 'failed', reason: 'repository_password_incorrect', step: 'repository',
            nativeExitCode: result.exitCode, remedy: 'review_credentials' };
        if (result.exitCode !== 0) return { kind: 'failed', reason: result.exitCode === 10 ? 'repository_missing' : 'native_failed',
            step: 'repository', nativeExitCode: result.exitCode, remedy: 'review_destination' };
        const config = initializing
            ? readResticRepositoryInitializationV1(result.stdout, result.exitCode, result.stdoutTruncated)
            : readResticRepositoryConfigV1(result.stdout, result.exitCode, result.stdoutTruncated);
        return await probeDestination(input, config.repositoryId);
    } catch (error) {
        if (error && typeof error === 'object' && 'details' in error) throw error;
        return uncertain();
    }
}

async function probeDestination(input: DeploymentBackupReadInputV1 & Readonly<{ operationId: string }>, repositoryId: string)
    : Promise<DeploymentBackupTestResultV1> {
    const payload = new TextEncoder().encode('happier-backup-destination-probe-v1\n');
    const digest = await crypto.subtle.digest('SHA-256', payload);
    const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    let snapshotId: string | undefined;
    let failure: unknown;
    let cleanup: 'deleted' | 'failed' | 'unknown' = 'unknown';
    try {
        const written = await executeBackupOperationStepV1(input, { kind: 'probe', operationId: input.operationId, payload }, 'probe.write');
        snapshotId = readResticBackupSummaryV1(written.stdout, written.exitCode, written.stdoutTruncated).snapshotId;
        const read = await executeBackupOperationStepV1(input, { kind: 'dump', snapshotId, path: '/destination-probe' }, 'probe.read');
        if (read.stdoutBytes !== payload.length || read.stdoutChecksumSha256 !== checksum) {
            backupOperationFailureV1('backup_integrity_failed', 'probe.read');
        }
    } catch (error) { failure = error; }
    if (snapshotId && !input.signal.aborted) {
        try {
            await executeBackupOperationStepV1(input, { kind: 'forgetExact', snapshotIds: [snapshotId] }, 'probe.cleanup');
            cleanup = 'deleted';
        } catch (error) { failure ??= error; cleanup = 'failed'; }
    }
    if (failure || cleanup !== 'deleted') {
        const code = input.signal.aborted ? 'cancelled' : failure && typeof failure === 'object'
            && 'code' in failure && typeof failure.code === 'string' ? failure.code : 'outcome_unknown';
        const step = failure && typeof failure === 'object' && 'step' in failure && typeof failure.step === 'string'
            ? failure.step : 'probe.write';
        throw Object.assign(new Error(code), { code, step, details: { step, code, ...readDeploymentBackupMaintenanceFailureEvidenceV1(failure),
            probe: { key: snapshotId ?? `happier-probe-${input.operationId}`, cleanup } } });
    }
    return { kind: 'reachable', repositoryId };
}
