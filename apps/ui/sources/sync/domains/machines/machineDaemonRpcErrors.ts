import { isRpcMethodNotFoundError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectMachineActionRpcFailure as projectPublicMachineFailure, readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
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
    recovery?: MachineEnrollmentRecovery;
}> & Partial<Omit<ActionExecuteFailure, 'ok' | 'error'>>;

/** Decode both returned Machine refusals and the RPC transport's thrown carrier. */
export function readMachineDaemonRpcFailureEnvelope(value: unknown): ActionExecuteFailure | null {
    if (!value || typeof value !== 'object' || ('ok' in value && value.ok === true)) return null;
    const returnedFailure = readActionFailureEnvelope(value, { treatReturnedErrorEnvelopeAsFailure: true });
    if (returnedFailure) return returnedFailure;
    const errorCode = readRpcErrorCode(value);
    return errorCode ? readActionFailureEnvelope({
        ...value, ok: false, errorCode, ...(value instanceof Error ? { message: value.message } : {}),
    }) : null;
}

/** One public Machine-to-Action projection; private read surfaces keep their own result. */
export function projectMachineActionRpcFailure(value: unknown): ActionExecuteFailure | null {
    const failure = readMachineDaemonRpcFailureEnvelope(value);
    if (!failure) return null;
    return projectPublicMachineFailure(failure);
}

/** Preserve the protocol's safe diagnostics once, for every Machine read surface. */
export function projectMachineDaemonRpcFailure(error: unknown): MachineDaemonRpcFailure {
    const failure = readMachineDaemonRpcFailureEnvelope(error);
    // Machine read projections carry diagnostics; transport messages can contain private paths.
    const { error: _transportMessage, ...diagnostics } = failure ?? { error: undefined };
    return { ...diagnostics, ok: false, reason: isMachineDaemonRpcUnsupportedError(error) ? 'older_happier'
        : failure?.errorCode === 'invalid_action_output' ? 'invalid_response' : 'request_failed',
        ...(failure?.errorCode === ACCOUNT_MODE_DOWNGRADE_UNVERIFIED ? { recovery: accountModeRecovery } : {}) };
}

/** Home or daemon must affirm method absence; routing/discovery unavailability is temporary. */
export function isMachineDaemonRpcUnsupportedError(error: unknown): boolean {
    return isRpcMethodNotFoundError(error);
}
