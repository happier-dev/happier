import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { UsageHistoryReadState } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { SessionPartsHttpError, SessionPartsInvalidResponseError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

/** These settled input facts need changed access/content/client support, rather than another attempt. */
function isLastingCoverageReason(code: string): boolean {
    switch (code) {
        case 'forbidden':
        case 'not_found':
        case 'invalid_response':
        case 'update_required':
        case 'session_key_unavailable':
        case 'session_key_invalid':
        case 'session_encryption_not_found':
        case 'scoped_session_encryption_unavailable':
        case 'metadata_unavailable':
        case 'agent_state_unavailable':
        case 'encrypted_content_unavailable':
        case 'encrypted_access_pending':
        case 'encrypted_access_needs_repair':
        case 'recipient_encryption_setup_required':
        case 'encryption_material_unavailable':
        case 'usage_work_facts_locked':
        case 'usage_work_facts_mode_mismatch':
        case 'usage_work_facts_corrupt_or_unopenable':
        case 'usage_work_facts_malformed':
            return true;
        default:
            return false;
    }
}

/** Preserve the Session reader's content-free cause; never expose its body or message. */
export function readUsageHistoryFailure(error: unknown): Readonly<{
    errorCode: string; retryable: boolean; errorName?: string; httpStatus?: number;
}> {
    const httpStatus = error && typeof error === 'object' && 'httpStatus' in error && typeof error.httpStatus === 'number'
        ? error.httpStatus : error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
    const code = error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string' ? error.errorCode
        : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    const bodyCode = error instanceof SessionPartsHttpError && error.body && typeof error.body === 'object'
        && 'code' in error.body && typeof error.body.code === 'string' ? error.body.code : undefined;
    const bodyError = error instanceof SessionPartsHttpError && error.body && typeof error.body === 'object'
        && 'error' in error.body && typeof error.body.error === 'string'
        && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(error.body.error) ? error.body.error : undefined;
    const errorCode = error instanceof SessionPartsHttpError && error.updateRequired ? 'update_required'
        : code ?? bodyCode ?? bodyError ?? (httpStatus === 403 ? 'forbidden' : httpStatus === 404 ? 'not_found'
            : httpStatus !== undefined ? 'http_error' : isTransientConnectivityError(error) ? 'network_error' : 'usage_session_evidence_read_failed');
    return { errorCode, retryable: httpStatus !== 403 && httpStatus !== 404 && !isLastingCoverageReason(errorCode),
        ...(error instanceof Error ? { errorName: error instanceof SessionPartsInvalidResponseError ? 'SessionPartsInvalidResponseError' : error.name } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}) };
}

/** One recovery decision for the visible history control and its mounted command. */
export function getUsageHistoryReadOperation(state: UsageHistoryReadState | null): 'read' | 'retry' | 'cancel' | null {
    if (!state) return null;
    if (state.status === 'reading') return 'cancel';
    if (state.progress.failed > 0 || state.status === 'partial' && state.errorCode
        && readUsageHistoryFailure({ errorCode: state.errorCode }).retryable) return 'retry';
    return state.progress.notRead > 0 ? 'read' : null;
}

/** The Account resource's history projection; request failures never invent failed Sessions. */
export class UsageHistoryEntry {
    state: UsageHistoryReadState = { status: 'idle', progress: { selected: 0, notRead: 0, completed: 0, failed: 0 } };
    readonly listeners: Set<() => void> = new Set();
    controller?: AbortController;
    pending?: Promise<UsageHistoryReadState>;
    private readonly failures = new Map<string, string>();
    private readonly coverageGaps = new Map<string, string>();
    private operationFailure?: string;

    /** A new physical read replaces the prior request outcome, retaining Session coverage facts. */
    beginRead(): void {
        this.operationFailure = undefined;
        this.update(this.state.progress);
    }

    publish(state: UsageHistoryReadState): void {
        if (sameStrictJsonValue(this.state, state)) return;
        this.state = state;
        for (const listener of this.listeners) listener();
    }

    private update(progress: UsageHistoryReadState['progress']): void {
        const errorCode = this.operationFailure ?? this.failures.values().next().value ?? this.coverageGaps.values().next().value;
        this.publish({ progress: { ...progress, failed: this.failures.size },
            status: this.state.status === 'reading' ? 'reading' : errorCode ? 'partial' : progress.notRead ? 'idle' : 'complete',
            ...(errorCode ? { errorCode } : {}) });
    }

    coverage(selected: ReadonlySet<string>, notRead: number): void {
        for (const id of this.failures.keys()) if (!selected.has(id)) this.failures.delete(id);
        for (const id of this.coverageGaps.keys()) if (!selected.has(id)) this.coverageGaps.delete(id);
        this.update({ ...this.state.progress, selected: selected.size, notRead });
    }

    converted(sessionId: string): void {
        this.failures.delete(sessionId);
        this.coverageGaps.delete(sessionId);
        const progress = this.state.progress;
        this.update(this.state.status === 'reading' ? { ...progress,
            completed: progress.completed + 1, notRead: Math.max(0, progress.notRead - 1) } : progress);
    }

    succeeded(sessionId: string): void {
        const failed = this.failures.delete(sessionId);
        if (this.coverageGaps.delete(sessionId) || failed) this.update(this.state.progress);
    }

    failed(errorCode: string, sessionId?: string, retryable = !isLastingCoverageReason(errorCode)): void {
        if (sessionId !== undefined) {
            const lasting = !retryable;
            (lasting ? this.failures : this.coverageGaps).delete(sessionId);
            (lasting ? this.coverageGaps : this.failures).set(sessionId, errorCode);
        } else this.operationFailure = errorCode;
        // Keep the request outcome through later coverage publications, without counting Sessions it did not identify.
        this.update(this.state.progress);
    }
}
