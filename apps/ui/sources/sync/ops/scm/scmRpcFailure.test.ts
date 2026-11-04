import { describe, expect, it } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { assertScmResponse, scmFallbackError } from './scmRpcFailure';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

import { RpcError } from '@happier-dev/protocol/rpcErrors';

describe('SCM RPC failure normalization', () => {
    it('keeps read transport codes and classifies caller cancellation without failure diagnostics', () => {
        expect(scmFallbackError(new RpcError('Connection closed.', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE), {
            method: RPC_METHODS.SCM_DIFF_FILE, request: {},
        })).toMatchObject({ success: false, actionErrorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE });
        const cancelled = scmFallbackError(Object.assign(new RpcError('Read retired.', 'SOCKET_RPC_ABORTED'), { name: 'AbortError' }), {
            method: RPC_METHODS.SCM_DIFF_FILE, request: {},
        });
        expect(cancelled).toMatchObject({ success: false, errorCode: 'COMMAND_CANCELLED' });
        expect(cancelled.diagnosticDetail).toBeUndefined();
    });
    it('preserves known read transport failures without treating refusals as retryable native reads', () => {
        for (const [error, errorCode] of [
            [new RetryableServerResponseError(503, 'unavailable'), 'REMOTE_NETWORK_FAILED'],
            [new TypeError('Failed to fetch'), 'REMOTE_NETWORK_FAILED'],
            [Object.assign(new Error('timeout'), { code: 'MACHINE_RPC_TIMEOUT' }), 'COMMAND_TIMEOUT'],
        ] as const) expect(scmFallbackError(error, { method: RPC_METHODS.SCM_PULL_REQUEST_LIST, request: {} })).toMatchObject({ errorCode });
        expect(scmFallbackError(Object.assign(new Error('Denied'), { code: 'denied' }),
            { method: RPC_METHODS.SCM_PULL_REQUEST_LIST, request: {} }).errorCode).toBe('REPOSITORY_REFRESH_FAILED');
    });
    it('does not grant mutation retry authority after a lost result', () => {
        const error = new Error('transport timeout with private diagnostics');
        const cases = [
            { method: RPC_METHODS.SCM_COMMIT_CREATE, request: { cwd: '/repo' }, reconciliation: { kind: 'repository_status', cwd: '/repo' } },
            { method: RPC_METHODS.SCM_REMOTE_PUSH, request: { cwd: '/repo', remote: 'upstream', branch: 'feature' }, reconciliation: { kind: 'remote_ref', remote: 'upstream', branch: 'feature' } },
            { method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE, request: { head: 'feature', base: 'main' }, reconciliation: { kind: 'pull_request', head: 'feature', base: 'main' } },
            { method: RPC_METHODS.SCM_STASH_CREATE, request: { message: 'recovery' }, reconciliation: { kind: 'stash', message: 'recovery' } },
            { method: RPC_METHODS.SCM_STASH_POP, request: { cwd: '/repo', stashRef: 'stash@{0}' }, reconciliation: { kind: 'stash' } },
        ];
        for (const { method, request, reconciliation } of cases) {
            const result = scmFallbackError(error, { method, request });
            expect(result).toMatchObject({ success: false, errorCode: 'COMMAND_OUTCOME_UNKNOWN', outcome: { kind: 'outcome_unknown', reconciliation, nextActions: [{ kind: 'refresh' }] } });
            expect(JSON.stringify(result)).not.toContain('private diagnostics');
        }
    });

    it('keeps explicit no-dispatch errors and failed queries as known failures', () => {
        for (const rpcErrorCode of [RPC_ERROR_CODES.METHOD_NOT_FOUND, RPC_ERROR_CODES.METHOD_NOT_AVAILABLE]) {
            const response = scmFallbackError({ rpcErrorCode }, { method: RPC_METHODS.SCM_REMOTE_PUSH, request: {} });
            expect(response.outcome?.kind).not.toBe('outcome_unknown');
        }
        const query = scmFallbackError(new Error('timeout'), { method: RPC_METHODS.SCM_STATUS_SNAPSHOT, request: {} });
        expect(query.errorCode).toBe('REPOSITORY_REFRESH_FAILED');
    });

    it('retains local read exception identity separately from display copy', () => {
        const failure = scmFallbackError(new TypeError('Snapshot normalization failed\nprivate second line'), {
            method: RPC_METHODS.SCM_STATUS_SNAPSHOT, request: {},
        });
        expect(failure).toMatchObject({
            errorCode: 'REPOSITORY_REFRESH_FAILED',
            diagnosticDetail: 'TypeError: Snapshot normalization failed',
        });
        expect(failure.error).not.toContain('RPC method not available');
        expect(failure.error).not.toContain('normalization');
        expect(JSON.stringify(failure)).not.toContain('private second line');
    });

    it('does not claim a malformed mutation response proves no effect', () => {
        let error: unknown;
        try { assertScmResponse(undefined); } catch (caught) { error = caught; }
        expect(scmFallbackError(error, { method: RPC_METHODS.SCM_COMMIT_CREATE, request: { cwd: '/repo' } }).outcome?.kind).toBe('outcome_unknown');
    });

    it('rejects malformed canonical outcomes before treating their authority as fact', () => {
        for (const outcome of [{ kind: 'unrecognized' }, { kind: 'succeeded', effect: { kind: 'commit' } }, { kind: 'succeeded', hiddenAuthority: true }]) {
            expect(() => assertScmResponse({ success: true, outcome })).toThrow();
        }
        expect(assertScmResponse({ success: true })).toEqual({ success: true });
    });
    it('rejects malformed commit publication before granting effect or retry authority', () => {
        expect(() => assertScmResponse({ success: false, publication: { state: 'not_published', candidateOid: 'unknown' } })).toThrow();
        expect(() => assertScmResponse({ success: true, publication: { state: 'published', expectedHeadOid: null, expectedRef: null, candidateOid: 'a'.repeat(40), indexReconciliation: 'reconciled', hiddenAuthority: true } })).toThrow();
    });
});
