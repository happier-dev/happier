import { isRpcMethodNotFoundError, isRpcError, readRpcErrorCode, type RpcError } from '@happier-dev/protocol/rpcErrors';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ACCOUNT_MODE_DOWNGRADE_UNVERIFIED } from '@happier-dev/protocol/account/encryptionMode';
import type { MachineOperationProtocolCapabilitiesV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';

const accountModeRecovery = {
    kind: 'needs_recovery',
    reason: ACCOUNT_MODE_DOWNGRADE_UNVERIFIED,
    step: 'keep_encryption_keys_and_reconnect',
} as const;

export type MachineEnrollmentRecovery = typeof accountModeRecovery;

/** Absent means the daemon has not published an observation; null supersedes held RPC failures. */
export function readMachineEnrollmentRecovery(capabilities: MachineOperationProtocolCapabilitiesV1 | null | undefined): MachineEnrollmentRecovery | null | undefined {
    const recovery = capabilities?.enrollmentRecovery;
    return recovery === ACCOUNT_MODE_DOWNGRADE_UNVERIFIED ? accountModeRecovery : recovery;
}

export type MachineDaemonRpcFailure = Readonly<{
    ok: false;
    reason: 'older_happier' | 'request_failed' | 'invalid_response';
    errorCode?: string;
    failureCause?: ActionFailureCauseV1;
    details?: RpcError['details'];
    recovery?: MachineEnrollmentRecovery;
}>;

/** Preserve the protocol's safe diagnostics once, for every Machine read surface. */
export function projectMachineDaemonRpcFailure(error: unknown): MachineDaemonRpcFailure {
    const errorCode = readRpcErrorCode(error);
    const failureCause = isRpcError(error) ? error.failureCause : undefined;
    const details = isRpcError(error) ? error.details : undefined;
    return { ok: false, reason: isMachineDaemonRpcUnsupportedError(error) ? 'older_happier'
        : errorCode === 'invalid_action_output' ? 'invalid_response' : 'request_failed',
        ...(errorCode ? { errorCode } : {}), ...(failureCause ? { failureCause } : {}), ...(details ? { details } : {}),
        ...(errorCode === ACCOUNT_MODE_DOWNGRADE_UNVERIFIED ? { recovery: accountModeRecovery } : {}) };
}

/** Home or daemon must affirm method absence; routing/discovery unavailability is temporary. */
export function isMachineDaemonRpcUnsupportedError(error: unknown): boolean {
    return isRpcMethodNotFoundError(error);
}
