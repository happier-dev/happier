import { DaemonPluginStoredImageReadRequestSchema, DaemonPluginStoredImageReadResponseSchema,
    type DaemonPluginStoredImageReadRequest, type DaemonPluginStoredImageReadResponse } from '@happier-dev/protocol';
import { PluginUiReadStoredImageRequestV1Schema } from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';

export type PluginStoredImageReadTransport = (machineId: string, request: DaemonPluginStoredImageReadRequest,
    options: Readonly<{ serverId: string | null; signal?: AbortSignal }>) => Promise<DaemonPluginStoredImageReadResponse>;
const readStoredImage: PluginStoredImageReadTransport = async (machineId, request, options) => {
    const result = await machineRpcWithServerScope<unknown, unknown>({
        machineId, serverId: options.serverId, method: RPC_METHODS.DAEMON_PLUGIN_STORED_IMAGE_READ,
        payload: DaemonPluginStoredImageReadRequestSchema.parse(request), ...(options.signal ? { signal: options.signal } : {}),
    });
    return DaemonPluginStoredImageReadResponseSchema.parse(result);
};

/** The daemon owns Session read authorization; this mount owns disclosure lifetime. */
export function createPluginSurfaceStoredImageOwner(input: Readonly<{
    pluginId: string; occurrenceId: string; machineId: string; serverId: string | null;
    isCurrent(): boolean; lifetimeSignal: AbortSignal; read?: PluginStoredImageReadTransport;
}>): Readonly<{
    readStoredImage: PluginSurfaceHostApiMethodHandler;
    dispose(): void;
}> {
    let disposed = false;
    const current = () => !disposed && !input.lifetimeSignal.aborted && input.isCurrent();
    return {
        async readStoredImage(request, options) {
            if (!current()) return createPluginSurfaceHostApiError('stale_surface', ['plugin_surface_retired']);
            const parsed = PluginUiReadStoredImageRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload', ['stored_image_reference_invalid']);
            const merged = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
            const signal = merged.signal;
            try {
                if (signal?.aborted) return createPluginSurfaceHostApiError('unavailable', ['aborted']);
                const result = await (input.read ?? readStoredImage)(input.machineId, {
                    callerPluginId: input.pluginId, expectedCallerOccurrenceId: input.occurrenceId, media: parsed.data.image,
                }, { serverId: input.serverId, ...(signal ? { signal } : {}) });
                if (!current()) return createPluginSurfaceHostApiError('stale_surface', ['plugin_surface_retired']);
                if (signal?.aborted) return createPluginSurfaceHostApiError('unavailable', ['aborted']);
                return result.ok ? result.image : createPluginSurfaceHostApiError('unavailable', [result.code]);
            } catch {
                return createPluginSurfaceHostApiError('unavailable', ['plugin_session_media_unavailable']);
            } finally {
                merged.dispose();
            }
        },
        dispose() { disposed = true; },
    };
}
