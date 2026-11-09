import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import {
    clearSpawnAttemptCustody,
    markSpawnAttemptCreated,
    markSpawnAttemptRefused,
    type AcquireSpawnAttemptCustodyResult,
    type PersistedSpawnAttempt,
} from '@/sync/domains/session/spawn/spawnAttemptNonceStore';
import type { SessionSpawnNewActionResult } from './sessionSpawnNewAction';

/** Settle only this dispatch's proven no-effect custody; earlier submissions remain retry authority. */
export async function settleManualSessionSpawnNewActionCustody(params: Readonly<{
    acquired: Extract<AcquireSpawnAttemptCustodyResult, { status: 'acquired' }>;
    action: SessionSpawnNewActionResult;
    committed: Extract<SessionSpawnNewResultV1, { type: 'success' }> | null;
    executionTarget: SessionSpawnNewInputV2['executionTarget'];
    sourceAdmissionRetired: boolean;
}>): Promise<PersistedSpawnAttempt> {
    const { acquired, action, committed, executionTarget, sourceAdmissionRetired } = params;
    const submitted = acquired.record;
    if (committed
        && committed.executionTarget.serverId === executionTarget.serverId
        && committed.executionTarget.machineId === executionTarget.machineId) {
        return await markSpawnAttemptCreated({
            scope: submitted.scope,
            machineId: submitted.machineId,
            targetFingerprint: submitted.targetFingerprint,
            userAttemptId: submitted.userAttemptId,
            nonce: submitted.nonce,
            createdSessionId: committed.sessionId,
        }) ?? submitted;
    }
    const noEffect = sourceAdmissionRetired || (
        !action.ok && (action.effectAttempted === false || action.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE)
    ) || (
        action.ok && action.result.type === 'error' && action.result.retryable === false
    );
    if (noEffect && !committed && submitted.createdSessionId === null && acquired.previousSubmissionState !== 'submitted') {
        if (!sourceAdmissionRetired && action.ok && action.result.type === 'error' && !action.result.retryable) {
            return await markSpawnAttemptRefused({ record: submitted, result: action.result }) ?? submitted;
        }
        // A later refusal says nothing about a previous submission's effect.
        // The store also checks for a concurrently committed receipt under its lock.
        await clearSpawnAttemptCustody({
            scope: submitted.scope,
            machineId: submitted.machineId,
            targetFingerprint: submitted.targetFingerprint,
            userAttemptId: submitted.userAttemptId,
            nonce: submitted.nonce,
            onlyIfUncommitted: true,
        });
    }
    return submitted;
}
