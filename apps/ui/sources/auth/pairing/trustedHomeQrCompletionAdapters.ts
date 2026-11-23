import {
    AccountCompletionError,
    DirectHomeQrCompletionError,
    InvalidAccountCompletionTargetError,
    type DirectHomeQrCompletionAdapters,
} from '@happier-dev/cli-common/homeEnrollment';

import { completeTrustedHomeQrPairingRequest, InvalidTrustedHomeQrRequestError } from '@/auth/pairing/completeTrustedHomeQrPairingRequest';
import { pairingConsume, pairingStatus, type PairingCallTarget, type PairingStatus } from '@/sync/api/account/apiPairingAuth';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms);
        function done() { signal.removeEventListener('abort', abort); resolve(); }
        function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); }
        signal.addEventListener('abort', abort, { once: true });
    });
}

/**
 * The UI's transport for the shared approver completion loop
 * (`runDirectHomeQrCompletion`): the trusted device polls, consumes and completes
 * one exact pairing row on `target`. Both approver surfaces — the Home-displayed
 * QR (`usePairingSession`) and a scanned requester QR — use these adapters, so a
 * Home response maps to the same lifecycle classification everywhere.
 */
export function createTrustedHomeQrCompletionAdapters(params: Readonly<{
    target: PairingCallTarget;
    onStatus?: (status: PairingStatus) => void;
    /** The Home-authority commit is starting; the caller locks its surface. */
    onCompleting?: (requestedDeviceLabel: string | null) => void;
    onRetrying?: () => void;
}>): DirectHomeQrCompletionAdapters {
    const { target } = params;
    return {
        now: Date.now,
        poll: async ({ pairId, signal, timeoutMs }) => {
            if (!isRuntimeActive()) return { ok: false, reason: 'transient', status: 0 };
            const result = await pairingStatus({ pairId }, target, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
            if (result.ok) { params.onStatus?.(result.data); return { ok: true, status: result.data }; }
            if (result.reason === 'not_found') return { ok: false, reason: 'not_found', status: result.status };
            if (result.reason === 'http_error' && (result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500)) return { ok: false, reason: 'transient', status: result.status };
            return { ok: false, reason: 'invalid', status: result.status };
        },
        consume: async ({ pairId, intent, signal, timeoutMs }) => {
            const result = await pairingConsume(
                { pairId, intent },
                target,
                { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) },
            );
            if (result.ok) return { ok: true, outcome: 'cancelled' };
            return result.reason === 'already_decided'
                ? { ok: true, outcome: 'completion_won' }
                : { ok: false };
        },
        complete: async ({ context, requestedDeviceLabel, requesterPublicKey, signal }) => {
            params.onCompleting?.(requestedDeviceLabel);
            try {
                return await completeTrustedHomeQrPairingRequest({
                    context: { ...context, target },
                    requesterPublicKey,
                    signal,
                });
            } catch (error) {
                if (error instanceof InvalidTrustedHomeQrRequestError || error instanceof InvalidAccountCompletionTargetError) {
                    throw new DirectHomeQrCompletionError('invalid');
                }
                if (error instanceof AccountCompletionError && error.retryable) {
                    params.onRetrying?.();
                    throw new DirectHomeQrCompletionError('retryable');
                }
                throw new DirectHomeQrCompletionError('failed');
            }
        },
        sleep: abortableSleep,
        close: target.close,
    };
}
