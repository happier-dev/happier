import {
    DaemonPluginUiCaptureSourceReadResponseSchema,
    type DaemonPluginUiCaptureSourceDescriptorV1,
} from '@happier-dev/protocol';
import {
    PluginUiWatchLiveStreamRequestV1Schema,
    PluginUiDisposeHostResourceRequestV1Schema,
    type PluginUiHostApiRequestEnvelopeV1,
} from '@happier-dev/protocol/plugins/ui';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';

/** Per-viewing custody is private to one mount; no reusable consent/grant is retained. */
export function createPluginSurfaceLiveStreamOwner(input: Readonly<{
    pluginId: string; occurrenceId: string; machineId: string; serverId: string;
    lifetimeSignal: AbortSignal; isCurrent(): boolean;
    executeAction: PluginSurfaceHostApiMethodHandler;
}>) {
    const viewings = new Map<string, Readonly<{ source: DaemonPluginUiCaptureSourceDescriptorV1; dispose(): void }>>();
    const pending = new Map<string, Readonly<{ controller: AbortController; dispose(): void }>>();
    const dispose = () => {
        for (const viewing of pending.values()) viewing.dispose();
        pending.clear();
        for (const viewing of viewings.values()) viewing.dispose();
        viewings.clear();
    };
    input.lifetimeSignal.addEventListener('abort', dispose, { once: true });
    const watchLiveStream: PluginSurfaceHostApiMethodHandler = async (request, options) => {
        const parsed = PluginUiWatchLiveStreamRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload', ['capture_reference_invalid']);
        const { reference, subscriptionId } = parsed.data;
        if (reference.kind === 'plugin' && reference.source.pluginId !== input.pluginId) {
            return createPluginSurfaceHostApiError('unavailable', ['capture_source_denied']);
        }
        if (!input.isCurrent() || input.lifetimeSignal.aborted || options?.signal?.aborted) {
            return createPluginSurfaceHostApiError('unavailable', ['capture_viewing_cancelled']);
        }
        viewings.get(subscriptionId)?.dispose();
        viewings.delete(subscriptionId);
        pending.get(subscriptionId)?.dispose();
        const controller = new AbortController();
        const abort = () => controller.abort();
        options?.signal?.addEventListener('abort', abort, { once: true });
        const finish = () => {
            controller.abort();
            if (pending.get(subscriptionId)?.controller === controller) pending.delete(subscriptionId);
            if (viewings.get(subscriptionId)?.dispose === finish) viewings.delete(subscriptionId);
            options?.signal?.removeEventListener('abort', abort);
        };
        pending.set(subscriptionId, { controller, dispose: finish });
        try {
            const result = DaemonPluginUiCaptureSourceReadResponseSchema.safeParse(await machineRpcWithServerScope({
                machineId: input.machineId, serverId: input.serverId, method: RPC_METHODS.DAEMON_PLUGIN_UI_CAPTURE_SOURCE_READ,
                payload: { machineId: input.machineId, callerPluginId: input.pluginId,
                    expectedCallerOccurrenceId: input.occurrenceId, reference }, signal: controller.signal,
            }));
            if (!result.success || !result.data.ok) {
                finish();
                return createPluginSurfaceHostApiError('unavailable', [result.success && !result.data.ok ? result.data.code : 'capture_source_unavailable']);
            }
            const source = result.data.source;
            if (!input.isCurrent() || controller.signal.aborted || input.lifetimeSignal.aborted) {
                finish();
                return createPluginSurfaceHostApiError('unavailable', ['capture_viewing_cancelled']);
            }
            if (source.requiresApproval) {
                const approved = await input.executeAction({ ...request, requestId: `${request.requestId}:capture-view`, method: 'executeAction',
                    payload: { action: 'capture.view', input: { sourceId: source.sourceId, sourceOccurrenceId: source.sourceOccurrenceId } },
                }, { signal: controller.signal });
                if (!approved || typeof approved !== 'object' || Array.isArray(approved)
                    || !('admitted' in approved) || approved.admitted !== true
                    || !('sourceId' in approved) || approved.sourceId !== source.sourceId
                    || !('sourceOccurrenceId' in approved) || approved.sourceOccurrenceId !== source.sourceOccurrenceId) {
                    finish();
                    return createPluginSurfaceHostApiError('unavailable', ['capture_source_denied']);
                }
            }
            if (!input.isCurrent() || controller.signal.aborted || input.lifetimeSignal.aborted) {
                finish();
                return createPluginSurfaceHostApiError('unavailable', ['capture_viewing_cancelled']);
            }
            viewings.set(subscriptionId, { source, dispose: finish });
            pending.delete(subscriptionId);
            return { subscriptionId, kind: 'ready' };
        } catch {
            finish();
            return createPluginSurfaceHostApiError('unavailable', ['capture_source_unavailable']);
        }
    };
    return Object.freeze({
        watchLiveStream,
        readViewing: (subscriptionId: string) => input.isCurrent() ? viewings.get(subscriptionId)?.source ?? null : null,
        disposeHostResource(request: PluginUiHostApiRequestEnvelopeV1) {
            const parsed = PluginUiDisposeHostResourceRequestV1Schema.safeParse(request.payload);
            if (parsed.success) {
                pending.get(parsed.data.subscriptionId)?.dispose();
                viewings.get(parsed.data.subscriptionId)?.dispose();
                viewings.delete(parsed.data.subscriptionId);
            }
        },
        dispose: () => { input.lifetimeSignal.removeEventListener('abort', dispose); dispose(); },
    });
}
