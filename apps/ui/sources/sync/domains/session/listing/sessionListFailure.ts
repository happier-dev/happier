import { HappyError } from '@/utils/errors/errors';

export type SessionListQueryFailureReason =
    | 'unsupported'
    | 'invalid_query'
    | 'access_denied'
    | 'cursor_not_advancing'
    | 'response'
    | 'network';

export type SessionListFailure = Readonly<{ reason: SessionListQueryFailureReason; code: string | null }>;

function readFailureCode(error: unknown): string | null {
    if (error instanceof HappyError) return error.code?.trim() || null;
    if (!error || typeof error !== 'object' || !('code' in error)) return null;
    return typeof error.code === 'string' && error.code.trim() ? error.code.trim() : null;
}

function readFailureStatus(error: unknown): number | null {
    if (error instanceof HappyError) return error.status ?? null;
    if (!error || typeof error !== 'object' || !('status' in error)) return null;
    return typeof error.status === 'number' && Number.isFinite(error.status) ? error.status : null;
}

/** One admission vocabulary for strict-query and ordinary Session-list attempts. */
export function classifySessionListFailure(error: unknown): SessionListFailure {
    const code = readFailureCode(error);
    const status = readFailureStatus(error);
    if (code === 'cursor_not_advancing') return { reason: 'cursor_not_advancing', code };
    if (code === 'operation_not_supported' || code === 'feature_not_supported' || code === 'filtered_session_listing_unavailable') {
        return { reason: 'unsupported', code };
    }
    if (code === 'invalid_query' || code === 'invalid_request' || status === 400 || status === 422) {
        return { reason: 'invalid_query', code };
    }
    if (code === 'access_denied' || code === 'not_authenticated' || status === 401 || status === 403) {
        return { reason: 'access_denied', code };
    }
    // An HTTP response or rejected decode settled the attempt independently of realtime.
    if (code === 'invalid_response' || (status !== null && status > 0)) {
        return { reason: 'response', code };
    }
    return { reason: 'network', code };
}
