import { DaemonPluginInvocationLogReadRequestV1Schema, DaemonPluginInvocationLogReadResponseV1Schema } from '@happier-dev/protocol/daemon/plugin-invocation-logs';
import type { DaemonPluginInvocationLogReadResponseV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';

export type DaemonPluginInvocationLogTarget = Readonly<{
    serverIdentityId: string;
    machineId: string;
}>;

export type DaemonPluginInvocationLogReadHandlerOptions = Readonly<{
    /**
     * Resolves the receiving daemon's live identity at request time.  The
     * requester provides the identity it selected, and this check prevents a
     * stale socket or a changed server profile from reading another target.
     */
    resolveCurrentTarget: (params: Readonly<{ signal?: AbortSignal }>) => Promise<DaemonPluginInvocationLogTarget | null>;
}>;

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw signal.reason ?? new Error('Plugin invocation log read aborted');
    }
}

function unavailable(code: 'plugin_log_request_invalid' | 'plugin_log_target_mismatch' | 'plugin_log_target_unavailable' | 'plugin_log_reader_unavailable') {
    return DaemonPluginInvocationLogReadResponseV1Schema.parse({
        version: 1,
        kind: 'unavailable',
        code,
    });
}

/**
 * Canonical daemon-side RPC adapter for bounded plugin invocation log reads.
 * It delegates querying to Logger; this handler owns only target-currentness
 * and the strict wire contract.
 */
export function createDaemonPluginInvocationLogReadHandler(options: DaemonPluginInvocationLogReadHandlerOptions) {
    return async (value: unknown, context?: RpcHandlerContext): Promise<DaemonPluginInvocationLogReadResponseV1> => {
        const request = DaemonPluginInvocationLogReadRequestV1Schema.safeParse(value);
        if (!request.success) {
            return unavailable('plugin_log_request_invalid');
        }

        throwIfAborted(context?.signal);
        const currentTarget = await options.resolveCurrentTarget({ signal: context?.signal });
        throwIfAborted(context?.signal);
        if (!currentTarget) {
            return unavailable('plugin_log_target_unavailable');
        }

        if (
            currentTarget.serverIdentityId !== request.data.target.serverIdentityId
            || currentTarget.machineId !== request.data.target.machineId
        ) {
            return unavailable('plugin_log_target_mismatch');
        }

        const result = request.data.waitForChanges
            ? await logger.waitForPluginInvocationLogRecords(request.data.query, context?.signal)
            : logger.readPluginInvocationLogRecords(request.data.query);
        throwIfAborted(context?.signal);
        if (request.data.waitForChanges) {
            const resumedTarget = await options.resolveCurrentTarget({ signal: context?.signal });
            throwIfAborted(context?.signal);
            if (!resumedTarget) return unavailable('plugin_log_target_unavailable');
            if (resumedTarget.serverIdentityId !== request.data.target.serverIdentityId
                || resumedTarget.machineId !== request.data.target.machineId) return unavailable('plugin_log_target_mismatch');
        }
        if (result.kind !== 'available') {
            return unavailable('plugin_log_reader_unavailable');
        }

        return DaemonPluginInvocationLogReadResponseV1Schema.parse({
            version: 1,
            kind: 'available',
            records: result.records,
            cursor: result.cursor,
            hasMore: result.hasMore,
            logId: result.logId,
            cursorReset: result.cursorReset,
        });
    };
}

export function registerDaemonPluginInvocationLogReadHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonPluginInvocationLogReadHandlerOptions,
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ,
        createDaemonPluginInvocationLogReadHandler(options),
    );
}
