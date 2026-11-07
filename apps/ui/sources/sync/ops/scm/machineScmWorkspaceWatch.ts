import { isRpcMethodNotFoundResult, RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { ScmWorkspaceWatchResponseSchema, type ScmWorkspaceWatchRequest, type ScmWorkspaceWatchResponse,
    type ScmWorkspaceWatchUnavailable } from '@happier-dev/protocol/scm';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type MachineScmWorkspaceWatch = Readonly<{ dispose(): void }>;

/** Presentation owns demand; the daemon owns native observation and revision facts. */
export function watchMachineScmWorkspaceChanges(machineId: string, options: Readonly<{
    serverId: string;
    directory: string;
    onChange(): void;
    onReady?(): void;
    onUnavailable(reason: ScmWorkspaceWatchUnavailable): void;
}>): MachineScmWorkspaceWatch {
    const controller = new AbortController();
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        controller.abort();
    };
    const unavailable = (reason: ScmWorkspaceWatchUnavailable) => {
        if (disposed) return;
        dispose();
        options.onUnavailable(reason);
    };
    async function request(input: ScmWorkspaceWatchRequest): Promise<ScmWorkspaceWatchResponse> {
        try {
            const raw = await machineRpcWithServerScope<unknown, ScmWorkspaceWatchRequest>({ machineId, serverId: options.serverId,
                method: RPC_METHODS.SCM_WORKSPACE_WATCH, payload: input, signal: controller.signal, operationTimeoutMs: null });
            if (isRpcMethodNotFoundResult(raw)) return { status: 'unavailable', reason: {
                code: RPC_ERROR_CODES.METHOD_NOT_FOUND, message: 'Workspace watching is unavailable on this Machine' } };
            const parsed = ScmWorkspaceWatchResponseSchema.safeParse(raw);
            return parsed.success ? parsed.data : { status: 'unavailable', reason: {
                code: 'invalid_response', message: 'Invalid workspace watch response' } };
        } catch (error) {
            return { status: 'unavailable', reason: {
                code: readRpcErrorCode(error) ?? (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                    ? error.code : 'watch_request_failed'),
                message: error instanceof Error ? error.message : 'Workspace watch request failed',
            } };
        }
    }
    // Retaining this parked request prevents a native detach/re-attach gap while
    // changed revision replies are consumed and the next read is armed.
    void request({ directory: options.directory, observationOnly: true }).then(result => {
        if (disposed) return;
        unavailable(result.status === 'unavailable' ? result.reason : {
            code: result.status === 'cancelled' ? 'cancelled' : 'invalid_response', message: 'Workspace observation ended' });
    });
    const pump = async () => {
        let sinceRevision: number | undefined;
        while (!disposed) {
            const result = await request({ directory: options.directory, ...(sinceRevision === undefined ? {} : { sinceRevision }) });
            if (disposed) return;
            if (result.status === 'unavailable') { unavailable(result.reason); return; }
            if (result.status === 'cancelled') { unavailable({ code: 'cancelled', message: 'Workspace watch cancelled' }); return; }
            const previous = sinceRevision;
            sinceRevision = result.revision;
            try {
                if (previous === undefined) options.onReady?.();
                if (result.status === 'changed' && result.revision !== previous) options.onChange();
            } catch {
                // The consuming sync owner owns callback errors and recovery.
                dispose();
            }
        }
    };
    void pump();
    return Object.freeze({ dispose });
}
