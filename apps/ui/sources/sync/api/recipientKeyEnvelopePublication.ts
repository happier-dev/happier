import { HappyError } from '@/utils/errors/errors';
import { readTransientAvailabilityFailure } from '@/utils/errors/transientAvailability';
import { createBackoff } from '@/utils/timing/time';
import { isExplicitlyRetryableError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

const publishWithRetry = createBackoff({ shouldRetry: isExplicitlyRetryableError });

/** Replay only the prepared, idempotent envelope publication, under the existing
 * request retry budget. Grant mutations and recipient census/sealing stay outside.
 * Domain refusals return to their parser without retrying. */
export function publishRecipientKeyEnvelopes(
    request: () => Promise<Response>, signal?: AbortSignal,
): Promise<Response> {
    return publishWithRetry(async () => {
        const response = await request();
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
            const payload: unknown = await response.json().catch(() => null);
            const cause = readTransientAvailabilityFailure(payload && typeof payload === 'object'
                ? Reflect.get(payload, 'error') : undefined);
            throw new HappyError('Recipient key publication is unavailable', true, {
                status: response.status, ...(cause ? { code: cause.code } : {}),
            });
        }
        return response;
    }, { signal });
}
