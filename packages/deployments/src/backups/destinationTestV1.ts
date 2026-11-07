import type { DeploymentBackupTestResultV1 } from '@happier-dev/deployment-protocol';
import { readResticRepositoryConfigV1 } from './manifestV1.js';
import { buildResticRequestV1 } from './resticExecutor.js';
import type { DeploymentBackupReadInputV1 } from './verificationV1.js';

/** Read the selected repository through the already-admitted P42/native owner. No writes or retries. */
export async function testDeploymentBackupDestinationV1(input: DeploymentBackupReadInputV1): Promise<DeploymentBackupTestResultV1> {
    const uncertain = (): DeploymentBackupTestResultV1 => ({ kind: 'failed', step: 'repository',
        reason: input.signal.aborted ? 'cancelled' : 'outcome_unknown', remedy: 'retry' });
    if (input.signal.aborted) return uncertain();
    try {
        const result = await input.execute(buildResticRequestV1({ environmentId: input.environmentId,
            access: input.access, command: { kind: 'config' } }));
        if (input.signal.aborted || result.kind === 'outcome_unknown') return uncertain();
        if (result.exitCode === 11) return { kind: 'failed', reason: 'repository_locked', step: 'repository',
            nativeExitCode: result.exitCode, remedy: 'retry_after_operation' };
        if (result.exitCode === 12) return { kind: 'failed', reason: 'repository_password_incorrect', step: 'repository',
            nativeExitCode: result.exitCode, remedy: 'review_credentials' };
        if (result.exitCode !== 0) return { kind: 'failed', reason: result.exitCode === 10 ? 'repository_missing' : 'native_failed',
            step: 'repository', nativeExitCode: result.exitCode, remedy: 'review_destination' };
        const config = readResticRepositoryConfigV1(result.stdout, result.exitCode, result.stdoutTruncated);
        return { kind: 'reachable', repositoryId: config.repositoryId };
    } catch { return uncertain(); }
}
