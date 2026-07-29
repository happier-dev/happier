import {
    ExternalSessionTakeoverInputV1Schema,
    type ExternalSessionTakeoverResultV1,
} from '@happier-dev/protocol/sessions';

import type { ExternalSessionActionContext } from './externalSessionActionContext';

/**
 * Released clients may still call the predecessor direct-takeover route.
 *
 * That route cannot manufacture the public source identity or idempotency
 * intent required by the durable operation owner, so it fails closed before
 * any source read, exclusion claim, follow suspension, or spawn. Current
 * clients use `sessions.external.takeover.start`.
 */
export async function executeExternalSessionTakeoverAction(
    raw: unknown,
    _context: ExternalSessionActionContext,
): Promise<
    ExternalSessionTakeoverResultV1
    & Readonly<{ takeoverStatus?: 'attached' | 'takenOver' }>
> {
    const parsed = ExternalSessionTakeoverInputV1Schema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false,
            errorCode: 'takeover_not_available',
            error: 'invalid_request',
        };
    }
    return {
        ok: false,
        errorCode: 'upgrade_required',
        error: 'durable_external_session_takeover_required',
    };
}
