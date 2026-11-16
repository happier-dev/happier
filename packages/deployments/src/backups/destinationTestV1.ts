import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentBackupMaintenanceFailureEvidenceV1, type DeploymentBackupTestResultV1 } from '@happier-dev/deployment-protocol';
import { readResticBackupSummaryV1, readResticRepositoryConfigV1, readResticRepositoryInitializationV1 } from './manifestV1.js';
import { buildResticRequestV1, type ResticAccessV1, type ResticCommandV1 } from './resticExecutor.js';
import type { DeploymentBackupNativeResultV1 } from '../actions/backups.js';
import { backupOperationFailureV1, executeBackupOperationStepV1, type DeploymentBackupReadInputV1 } from './verificationV1.js';

/** Prove write/read/delete through the admitted native owner. Probe snapshots never enter backup inventory. */
export async function testDeploymentBackupDestinationV1(input: DeploymentBackupReadInputV1 & Readonly<{
    operationId: string; initializeIfMissing?: boolean;
}>): Promise<DeploymentBackupTestResultV1> {
    const uncertain = () => repositoryUncertainV1(input.signal);
    try {
        let result = await executeRepositoryRequestV1(input, { kind: 'config' });
        const initializing = result.kind === 'failed' && result.reason === 'repository_missing' && input.initializeIfMissing === true;
        if (initializing) result = await executeRepositoryRequestV1(input, { kind: 'init' });
        if (result.kind === 'failed') return result;
        const config = initializing
            ? readResticRepositoryInitializationV1(result.stdout, result.exitCode, result.stdoutTruncated)
            : readResticRepositoryConfigV1(result.stdout, result.exitCode, result.stdoutTruncated);
        return await probeDestination(input, config.repositoryId);
    } catch (error) {
        if (error && typeof error === 'object' && 'details' in error) throw error;
        return uncertain();
    }
}

type RepositoryFailureV1 = Extract<DeploymentBackupTestResultV1, { kind: 'failed' }>;
function repositoryUncertainV1(signal: AbortSignal): RepositoryFailureV1 {
    return { kind: 'failed', step: 'repository', reason: signal.aborted ? 'cancelled' : 'outcome_unknown', remedy: 'retry' };
}
function repositoryNativeFailureV1(exitCode: number): RepositoryFailureV1 {
    if (exitCode === 11) return { kind: 'failed', reason: 'repository_locked', step: 'repository',
        nativeExitCode: exitCode, remedy: 'retry_after_operation' };
    if (exitCode === 12) return { kind: 'failed', reason: 'repository_password_incorrect', step: 'repository',
        nativeExitCode: exitCode, remedy: 'review_credentials' };
    return { kind: 'failed', reason: exitCode === 10 ? 'repository_missing' : 'native_failed',
        step: 'repository', nativeExitCode: exitCode, remedy: 'review_destination' };
}

/** Repository access returns closed outcomes; optional diagnostic capture never decides the native exit. */
async function executeRepositoryRequestV1(input: DeploymentBackupReadInputV1, command: ResticCommandV1)
    : Promise<Extract<DeploymentBackupNativeResultV1, { kind: 'completed' }> | RepositoryFailureV1> {
    if (input.signal.aborted) return repositoryUncertainV1(input.signal);
    const result = await input.execute(buildResticRequestV1({ environmentId: input.environmentId, access: input.access, command }));
    if (input.signal.aborted || result.kind === 'outcome_unknown') return repositoryUncertainV1(input.signal);
    return result.exitCode === 0 ? result : repositoryNativeFailureV1(result.exitCode);
}

/** Add and verify a successor password while retaining old repository access.
 * The admitted host retains both protected password files in access.credentialFiles;
 * successorAccess selects the new file in that same captured destination. No secret bytes cross this owner. */
export async function addDeploymentBackupRepositoryKeyV1(input: DeploymentBackupReadInputV1 & Readonly<{
    successorAccess: ResticAccessV1;
}>): Promise<DeploymentBackupTestResultV1> {
    try {
        const current = await executeRepositoryRequestV1(input, { kind: 'config' });
        if (current.kind === 'failed') return current;
        const { repositoryId } = readResticRepositoryConfigV1(current.stdout, current.exitCode, current.stdoutTruncated);
        const added = await executeRepositoryRequestV1(input, { kind: 'keyAdd', newPasswordFilePath: input.successorAccess.passwordFilePath });
        if (added.kind === 'failed') return added;
        const successor = await executeRepositoryRequestV1({ ...input, access: input.successorAccess }, { kind: 'config' });
        if (successor.kind === 'failed') return successor;
        if (input.signal.aborted) return repositoryUncertainV1(input.signal);
        if (readResticRepositoryConfigV1(successor.stdout, successor.exitCode, successor.stdoutTruncated).repositoryId !== repositoryId) {
            return backupOperationFailureV1('backup_integrity_failed', 'repository');
        }
        return { kind: 'reachable', repositoryId };
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'backup_integrity_failed') throw error;
        return repositoryUncertainV1(input.signal);
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
        throw Object.assign(createActionExecuteFailureError({ ok: false, errorCode: code, error: code }), { step, details: { step, code, ...readDeploymentBackupMaintenanceFailureEvidenceV1(failure),
            probe: { key: snapshotId ?? `happier-probe-${input.operationId}`, cleanup } } });
    }
    return { kind: 'reachable', repositoryId };
}
