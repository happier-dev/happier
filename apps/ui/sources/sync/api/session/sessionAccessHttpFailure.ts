import {
    SessionAccessErrorCodeV1Schema,
    type SessionAccessErrorCodeV1,
} from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { readTransientAvailabilityFailure, type TransientAvailabilityCode } from '@/utils/errors/transientAvailability';

export class SessionAccessApiError extends Error {
    constructor(readonly code: string, readonly status?: number) {
        super(code);
        this.name = 'SessionAccessApiError';
    }
}

export type SessionAccessHttpFailureCode =
    | SessionAccessErrorCodeV1
    | TransientAvailabilityCode
    | 'credential_scope_denied'
    | 'public_share_isolation_unavailable'
    | 'session_access_request_failed';

/**
 * Classifies only the shared Session-access HTTP envelope.
 *
 * A disabled canonical feature gate deliberately returns the exact legacy
 * `{ error: "not_found" }` 404: this Home's sharing decision withholds the
 * route, which is `session_access_sharing_unavailable`, not an update
 * requirement. Current domain routes instead name their missing-Session
 * result in the strict Session-access error union. Keeping this distinction
 * here prevents individual grant/responsibility consumers from turning every
 * 404 into either a stale-component premise or a missing row.
 */
export function readSessionAccessHttpFailureCode(
    payload: unknown,
    status: number,
): SessionAccessHttpFailureCode {
    const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(status, payload);
    if (scopeDenial) return scopeDenial.errorCode;
    const rollback = readHomeDomainConfirmedRollbackV1(status, payload);
    if (rollback) return rollback.code;
    const record = typeof payload === 'object' && payload !== null
        ? payload as Readonly<Record<string, unknown>>
        : {};
    if (status === 404 && record.error === 'not_found') return 'session_access_sharing_unavailable';
    if (record.error === 'public_share_isolation_unavailable') return 'public_share_isolation_unavailable';
    const transient = status === 503 ? readTransientAvailabilityFailure(record.error) : null;
    if (transient && transient.code !== 'database_transaction_conflict_exhausted') return transient.code;
    const code = SessionAccessErrorCodeV1Schema.safeParse(record.error);
    return code.success ? code.data : 'session_access_request_failed';
}
