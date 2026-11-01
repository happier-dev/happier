import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

/** Technical facts and privacy-projected command stderr for the existing Details disclosure. */
export function describeManagedNativeCause(cause: MachineProvisionerNativeCauseV1): string {
    if ('localCause' in cause && cause.localCause === 'native_command_failed') {
        return [cause.command, cause.exitCode === null ? 'interrupted' : `exit ${cause.exitCode}`, cause.stderr,
            cause.stderrTruncated ? 'stderr truncated' : null].filter(Boolean).join(' · ');
    }
    if ('localCause' in cause) return ['httpStatus' in cause ? `HTTP ${cause.httpStatus}` : null, cause.localCause].filter(Boolean).join(' · ');
    if ('httpStatusClass' in cause) return [`HTTP ${cause.httpStatusClass}`, cause.code, cause.fields?.join(', ')].filter(Boolean).join(' · ');
    if ('grpcStatusCode' in cause) return `gRPC ${cause.grpcStatusCode}`;
    return cause.sdkError;
}

export function describeManagedNativeFailureDiagnostic(code: string, cause?: MachineProvisionerNativeCauseV1): string {
    return cause ? `${code} · ${describeManagedNativeCause(cause)}` : code;
}

export function describeManagedOperationDiagnostic(error: NonNullable<ActionOperationSnapshotV1['error']>): string {
    const details = error.details;
    if (details && 'kind' in details && details.kind === 'managedNative') {
        return describeManagedNativeFailureDiagnostic(error.errorCode, details.nativeCause);
    }
    return [error.errorCode, error.error].filter((part, index, parts) => part && parts.indexOf(part) === index).join(' · ');
}
