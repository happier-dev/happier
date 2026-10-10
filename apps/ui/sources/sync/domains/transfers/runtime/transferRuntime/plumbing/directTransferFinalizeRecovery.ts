import {
    abortOwnedDirectImportSession,
    abortPreparedDirectImportSessionViaMachineRpc,
    DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE,
    DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE,
    finalizeDirectImportSession,
    resolveDirectImportCarrierRequest,
    TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE,
    type DirectTransferImportFinalizeResponse,
} from './directTransferImportClient';
import {
    MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
    type MachineCarrierHttpLease,
} from './machineCarrierHttpLease';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

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

export function retainTransferFinalizeRecovery<TResponse = never>(
    result: TransferFinalizeRecoveryActionResult<TResponse>,
): TransferFinalizeRecoveryOperationOutcome<TResponse> {
    return { result, settlesContinuation: false };
}

export function settleTransferFinalizeRecovery<TResponse = never>(
    result: TransferFinalizeRecoveryActionResult<TResponse>,
): TransferFinalizeRecoveryOperationOutcome<TResponse> {
    return { result, settlesContinuation: true };
}

/** One continuation lifecycle shared by direct-machine and Session-bound carriers. */
export function createTransferFinalizeRecovery<TResponse>(params: Readonly<{
    expiresAt: number;
    retryFinalize: () => Promise<TransferFinalizeRecoveryOperationOutcome<TResponse>>;
    discard: () => Promise<TransferFinalizeRecoveryOperationOutcome<TResponse>>;
    onSettled?: () => void;
}>): TransferFinalizeRecoveryContinuation<TResponse> {
    let inFlight: Promise<TransferFinalizeRecoveryActionResult<TResponse>> | null = null;
    let settled: TransferFinalizeRecoveryActionResult<TResponse> | null = null;
    const invoke = (action: TransferFinalizeRecoveryAction): Promise<TransferFinalizeRecoveryActionResult<TResponse>> => {
        if (action !== 'retry_finalize' && action !== 'discard_staged') {
            return Promise.resolve(createUnavailableResult({ reason: 'invalid_action', error: 'Unsupported transfer recovery action' }));
        }
        if (settled) return Promise.resolve(settled);
        if (inFlight) return inFlight;
        inFlight = (action === 'retry_finalize' ? params.retryFinalize() : params.discard()).then((outcome) => {
            if (outcome.settlesContinuation) { settled = outcome.result; params.onSettled?.(); }
            return outcome.result;
        }).finally(() => { inFlight = null; });
        return inFlight;
    };
    return Object.freeze({
        kind: 'transfer_finalize_recovery' as const,
        expiresAt: params.expiresAt,
        actions: Object.freeze(['retry_finalize', 'discard_staged'] as const),
        isActionable: () => settled === null,
        invoke,
    });
}

export function createDirectTransferFinalizeRecovery<TResponse>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    accountId?: string;
    accountLifetime?: ServerAccountScopeLifetime;
    onSettled?: () => void;
    uploadId: string;
    filesystemRootPath?: string;
    /**
     * The prepared transfer's endpoint. Its origin is not durable: the upload
     * hands carrier custody back before this continuation exists, so each retry
     * reacquires the pinned carrier and rebases this endpoint onto it.
     */
    baseUrl: string;
    /**
     * The upload's own carrier acquisition, pinned to the selected
     * machine/server. Every retry supplies its own cancellation scope, so the
     * completed upload's signal never reaches a reacquisition made here.
     */
    acquireCarrier?: ((prepared: Readonly<{ operationId: string; signal?: AbortSignal }>) => Promise<MachineCarrierHttpLease | null>) | null;
    expiresAt: number;
    timeoutMs?: number | null;
    parseFinalizeResponse: (
        response: Extract<DirectTransferImportFinalizeResponse, { success: true }>,
    ) => TResponse | null;
}>): TransferFinalizeRecoveryContinuation<TResponse> {
    const finalizeResponseOutcome = (
        response: DirectTransferImportFinalizeResponse,
    ): TransferFinalizeRecoveryOperationOutcome<TResponse> => {
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
    };

    const retryFinalize = async (): Promise<TransferFinalizeRecoveryOperationOutcome<TResponse>> => {
        if (params.accountLifetime && !params.accountLifetime.isCurrent()) return settleTransferFinalizeRecovery(createUnavailableResult({
            reason: 'session_unavailable', error: 'The original transfer Account is no longer current' }));
        const retirement = new AbortController();
        const subscription = params.accountLifetime?.onRetire(() => retirement.abort());
        let carrier: MachineCarrierHttpLease | null = null;
        try {
            let carrierRequest: ReturnType<typeof resolveDirectImportCarrierRequest>;
            try {
                carrier = params.acquireCarrier
                    ? await params.acquireCarrier({ operationId: params.uploadId, ...(params.accountLifetime ? { signal: retirement.signal } : {}) })
                    : null;
                carrierRequest = resolveDirectImportCarrierRequest({
                    endpointUrl: params.baseUrl,
                    carrier,
                });
            } catch {
                // Nothing was issued, so the staged session is untouched and the
                // user can retry once the machine is reachable again.
                return retainTransferFinalizeRecovery(createUnavailableResult({
                    reason: 'session_unavailable',
                    error: MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR,
                }));
            }

            let response: DirectTransferImportFinalizeResponse;
            try {
                retirement.signal.throwIfAborted();
                response = await finalizeDirectImportSession({
                    baseUrl: carrierRequest.url,
                    timeoutMs: params.timeoutMs ?? null,
                    ...(params.accountLifetime ? { signal: retirement.signal } : {}),
                    ...(carrierRequest.request ? { request: carrierRequest.request } : {}),
                });
            } catch {
                return settleTransferFinalizeRecovery(createUnavailableResult({
                    reason: 'session_unavailable',
                    error: 'The staged upload is no longer available',
                }));
            }

            return finalizeResponseOutcome(response);
        } finally {
            subscription?.dispose();
            // Custody returns to the lease owner exactly as the upload does; a
            // failed release stays retained and retryable there.
            await Promise.resolve(carrier?.release()).catch(() => undefined);
        }
    };

    const discard = async (): Promise<TransferFinalizeRecoveryOperationOutcome<TResponse>> => {
        if (params.accountLifetime && !params.accountLifetime.isCurrent()) return settleTransferFinalizeRecovery(createUnavailableResult({
            reason: 'session_unavailable', error: 'The original transfer Account is no longer current' }));
        let carrier: MachineCarrierHttpLease | null = null;
        const retirement = new AbortController();
        const subscription = params.accountLifetime?.onRetire(() => retirement.abort());
        try {
            if (params.filesystemRootPath) {
                carrier = params.acquireCarrier ? await params.acquireCarrier({ operationId: params.uploadId,
                    ...(params.accountLifetime ? { signal: retirement.signal } : {}) }) : null;
                retirement.signal.throwIfAborted();
                const endpoint = resolveDirectImportCarrierRequest({ endpointUrl: params.baseUrl, carrier });
                const failed = await abortOwnedDirectImportSession({ machineId: params.machineId, serverId: params.serverId,
                    accountId: params.accountId, uploadId: params.uploadId, filesystemRootPath: params.filesystemRootPath,
                    preparedSession: { baseUrls: [endpoint.url], ...(endpoint.request ? { request: endpoint.request } : {}) },
                    timeoutMs: params.timeoutMs });
                return failed ? retainTransferFinalizeRecovery(createUnavailableResult({ reason: 'session_unavailable', error: failed.error }))
                    : settleTransferFinalizeRecovery({ status: 'discarded' });
            }
            const result = await abortPreparedDirectImportSessionViaMachineRpc({
                machineId: params.machineId,
                ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
                ...(params.accountId ? { accountId: params.accountId } : {}),
                uploadId: params.uploadId,
                filesystemRootPath: params.filesystemRootPath,
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
        } finally { subscription?.dispose(); await Promise.resolve(carrier?.release()).catch(() => undefined); }
    };
    return createTransferFinalizeRecovery({ expiresAt: params.expiresAt, retryFinalize, discard, onSettled: params.onSettled });
}
