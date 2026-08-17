import {
    abortPreparedDirectImportSessionViaMachineRpc,
    DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE,
    DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE,
    finalizeDirectImportSession,
    TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE,
    type DirectTransferImportFinalizeResponse,
} from './directTransferImportClient';

export type TransferFinalizeRecoveryActionResult<TResponse> =
    | Readonly<{ status: 'finalized'; response: TResponse }>
    | Readonly<{ status: 'discarded' }>
    | Readonly<{ status: 'recovery_required'; error: string }>
    | Readonly<{
        status: 'unavailable';
        reason: 'expired' | 'session_unavailable' | 'outcome_indeterminate' | 'result_unusable' | 'invalid_action';
        error: string;
      }>;

export type TransferFinalizeRecoveryAction =
    | 'retry_finalize'
    | 'discard_staged';

export type TransferFinalizeRecoveryContinuation<TResponse> = Readonly<{
    kind: 'transfer_finalize_recovery';
    // Destination-daemon wall clock metadata; never authoritative on the client.
    expiresAt: number;
    actions: readonly ['retry_finalize', 'discard_staged'];
    isActionable: () => boolean;
    invoke: (
        action: TransferFinalizeRecoveryAction,
    ) => Promise<TransferFinalizeRecoveryActionResult<TResponse>>;
}>;

export type TransferFinalizeRecoveryFailure<TResponse> = Readonly<{
    success: false;
    error: string;
    errorCode: typeof TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE;
    recovery: TransferFinalizeRecoveryContinuation<TResponse>;
}>;

export function isTransferFinalizeRecoveryFailure<TResponse>(
    value: unknown,
): value is TransferFinalizeRecoveryFailure<TResponse> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (
        record.success !== false
        || record.errorCode !== TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE
        || typeof record.error !== 'string'
        || !record.recovery
        || typeof record.recovery !== 'object'
        || Array.isArray(record.recovery)
    ) {
        return false;
    }
    const recovery = record.recovery as Record<string, unknown>;
    return (
        recovery.kind === 'transfer_finalize_recovery'
        && typeof recovery.expiresAt === 'number'
        && typeof recovery.isActionable === 'function'
        && typeof recovery.invoke === 'function'
        && Array.isArray(recovery.actions)
        && recovery.actions.length === 2
        && recovery.actions[0] === 'retry_finalize'
        && recovery.actions[1] === 'discard_staged'
    );
}

function createUnavailableResult<TResponse>(input: Readonly<{
    reason: Extract<TransferFinalizeRecoveryActionResult<TResponse>, { status: 'unavailable' }>['reason'];
    error: string;
}>): TransferFinalizeRecoveryActionResult<TResponse> {
    return {
        status: 'unavailable',
        reason: input.reason,
        error: input.error,
    };
}

// Settlement certainty is owner-local: a transient discard RPC failure and an
// authoritative missing session share the public session_unavailable result.
type TransferFinalizeRecoveryOperationOutcome<TResponse> = Readonly<{
    result: TransferFinalizeRecoveryActionResult<TResponse>;
    settlesContinuation: boolean;
}>;

function retainTransferFinalizeRecovery<TResponse>(
    result: TransferFinalizeRecoveryActionResult<TResponse>,
): TransferFinalizeRecoveryOperationOutcome<TResponse> {
    return { result, settlesContinuation: false };
}

function settleTransferFinalizeRecovery<TResponse>(
    result: TransferFinalizeRecoveryActionResult<TResponse>,
): TransferFinalizeRecoveryOperationOutcome<TResponse> {
    return { result, settlesContinuation: true };
}

export function createDirectTransferFinalizeRecovery<TResponse>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    uploadId: string;
    baseUrl: string;
    expiresAt: number;
    timeoutMs?: number | null;
    parseFinalizeResponse: (
        response: Extract<DirectTransferImportFinalizeResponse, { success: true }>,
    ) => TResponse | null;
}>): TransferFinalizeRecoveryContinuation<TResponse> {
    let inFlight: Promise<TransferFinalizeRecoveryActionResult<TResponse>> | null = null;
    let settled: TransferFinalizeRecoveryActionResult<TResponse> | null = null;

    const runOnce = (
        operation: () => Promise<TransferFinalizeRecoveryOperationOutcome<TResponse>>,
    ): Promise<TransferFinalizeRecoveryActionResult<TResponse>> => {
        if (settled) {
            return Promise.resolve(settled);
        }
        if (inFlight) {
            return inFlight;
        }

        inFlight = operation().then((outcome) => {
            if (outcome.settlesContinuation) {
                settled = outcome.result;
            }
            return outcome.result;
        }).finally(() => {
            inFlight = null;
        });
        return inFlight;
    };

    const retryFinalize = (): Promise<TransferFinalizeRecoveryActionResult<TResponse>> => runOnce(async () => {
        let response: DirectTransferImportFinalizeResponse;
        try {
            response = await finalizeDirectImportSession({
                baseUrl: params.baseUrl,
                timeoutMs: params.timeoutMs ?? null,
            });
        } catch {
            return settleTransferFinalizeRecovery(createUnavailableResult({
                reason: 'session_unavailable',
                error: 'The staged upload is no longer available',
            }));
        }

        if (response.success !== true) {
            if (response.errorCode === TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE) {
                return retainTransferFinalizeRecovery({
                    status: 'recovery_required',
                    error: response.error,
                });
            }
            if (response.errorCode === DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE) {
                return settleTransferFinalizeRecovery(createUnavailableResult({
                    reason: 'result_unusable',
                    error: response.error,
                }));
            }
            if (response.errorCode === DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE) {
                return retainTransferFinalizeRecovery(createUnavailableResult({
                    reason: 'outcome_indeterminate',
                    error: response.error,
                }));
            }
            return settleTransferFinalizeRecovery(createUnavailableResult({
                reason: 'session_unavailable',
                error: response.error,
            }));
        }

        let parsed: TResponse | null;
        try {
            parsed = params.parseFinalizeResponse(response);
        } catch {
            parsed = null;
        }
        if (parsed === null) {
            return settleTransferFinalizeRecovery(createUnavailableResult({
                reason: 'result_unusable',
                error: 'Direct import finalize committed but returned an unusable result',
            }));
        }
        return settleTransferFinalizeRecovery({
            status: 'finalized',
            response: parsed,
        });
    });

    const discard = (): Promise<TransferFinalizeRecoveryActionResult<TResponse>> => runOnce(async () => {
        try {
            const result = await abortPreparedDirectImportSessionViaMachineRpc({
                machineId: params.machineId,
                ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
                uploadId: params.uploadId,
                timeoutMs: params.timeoutMs ?? null,
            });
            if (result.aborted !== true) {
                return settleTransferFinalizeRecovery(createUnavailableResult({
                    reason: 'session_unavailable',
                    error: 'The staged upload could not be discarded because its session is unavailable',
                }));
            }
            return settleTransferFinalizeRecovery({ status: 'discarded' });
        } catch {
            return retainTransferFinalizeRecovery(createUnavailableResult({
                reason: 'session_unavailable',
                error: 'The staged upload could not be discarded because its session is unavailable',
            }));
        }
    });

    const invoke = (
        action: TransferFinalizeRecoveryAction,
    ): Promise<TransferFinalizeRecoveryActionResult<TResponse>> => {
        if (action === 'retry_finalize') return retryFinalize();
        if (action === 'discard_staged') return discard();
        return Promise.resolve(createUnavailableResult({
            reason: 'invalid_action',
            error: 'Unsupported transfer recovery action',
        }));
    };

    return Object.freeze({
        kind: 'transfer_finalize_recovery' as const,
        expiresAt: params.expiresAt,
        actions: Object.freeze(['retry_finalize', 'discard_staged'] as const),
        isActionable: () => settled === null,
        invoke,
    });
}
