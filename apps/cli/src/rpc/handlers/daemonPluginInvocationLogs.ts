import {
    DaemonPluginInvocationLogReadRequestV1Schema,
    DaemonPluginInvocationLogReadResponseV1Schema,
    type DaemonPluginInvocationLogReadResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    logger,
    type PluginInvocationLogQuery,
    type PluginInvocationLogReadResult,
} from '@/ui/logger';

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
    /**
     * Kept at the logger-owner boundary for focused handler tests.  Production
     * uses the singleton structured logger and never creates another log store.
     */
    readLogs?: (query: PluginInvocationLogQuery) => PluginInvocationLogReadResult | Promise<PluginInvocationLogReadResult>;
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
    const readLogs = options.readLogs ?? ((query: PluginInvocationLogQuery) => logger.readPluginInvocationLogRecords(query));

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

        const result = await readLogs(request.data.query);
        throwIfAborted(context?.signal);
        if (result.kind !== 'available') {
            return unavailable('plugin_log_reader_unavailable');
        }

        return DaemonPluginInvocationLogReadResponseV1Schema.parse({
            version: 1,
            kind: 'available',
            records: result.records,
            cursor: result.cursor,
            hasMore: result.hasMore,
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
