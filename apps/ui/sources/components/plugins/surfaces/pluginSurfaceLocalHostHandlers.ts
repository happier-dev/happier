import { PluginUiDeviceStateRequestV1Schema } from '@happier-dev/protocol/plugins/ui';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { createPluginDeviceState } from './pluginDeviceState';
import {
    PluginUiHostApiDiagnosticV1Schema,
    PluginUiHostApiOpenExternalLinkRequestV1Schema,
    PluginUiHostApiWriteClipboardRequestV1Schema,
    PluginUiResourceIntentV1Schema,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import { logPluginSurfaceDiagnostic } from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';
import { requestOpenResource, type OpenResourceContext } from '@/utils/url/openResource';
import {
    getClipboardStringSafe,
    writeClipboardStringFromUi,
} from '@/utils/ui/clipboard';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiHandlers,
    type PluginSurfaceHostApiMethodHandler,
    type PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';

type LocalHostHandlerInput = Readonly<{
    surfaceContext: PluginUiSurfaceContextV1;
    deviceScope?: ServerAccountScope;
    /** The bound controller remains the only mount-currentness owner. */
    isCurrent?: () => boolean;
    /** Reuse this mount's Action admission and plugin caller, never host UI authority. */
    executeAction?: PluginSurfaceHostApiMethodHandler;
    resourceContext?: Pick<OpenResourceContext, 'navigation' | 'projection'>;
}>;

function unavailable(reason: string): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError('unavailable', [reason]);
}

function staleSurface(): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError('stale_surface', ['plugin_surface_retired']);
}

function invalidPayload(reason: string): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError('invalid_payload', [reason]);
}

function preflight(
    input: LocalHostHandlerInput,
    options: PluginSurfaceHostApiRequestOptions | undefined,
    cancellationReason: string,
): PluginUiJsonValueV1 | null {
    if (options?.signal?.aborted) return unavailable(cancellationReason);
    if (input.isCurrent?.() === false) return staleSurface();
    return null;
}

/**
 * Mounted local Host API producers that already belong to the UI process.
 *
 * This is deliberately only a handler bundle. `createPluginSurfaceHostApi`
 * remains the sole factual-method, currentness, and request facade owner; the
 * bound controller supplies its exact lifetime rather than this module making
 * another policy or host API factory.
 */
export function createPluginSurfaceLocalHostHandlers(
    input: LocalHostHandlerInput,
): Pick<
    PluginSurfaceHostApiHandlers,
    'deviceState' | 'diagnostic' | 'readClipboard' | 'writeClipboard' | 'openExternalLink' | 'openResource'
> {
    return Object.freeze({
        deviceState: (request: PluginUiHostApiRequestEnvelopeV1): PluginUiJsonValueV1 => {
            const parsed = PluginUiDeviceStateRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return invalidPayload('plugin_device_state_invalid');
            if (!input.deviceScope) return { status: 'unavailable', reason: 'scope_unavailable' };
            const namespace = [input.deviceScope.serverId, input.deviceScope.accountId, input.surfaceContext.pluginId, input.surfaceContext.contributionId];
            try { return createPluginDeviceState(getPersistenceStorage(), namespace)(parsed.data); }
            catch { return { status: 'unavailable', reason: 'storage_unavailable' }; }
        },
        openResource: async (request: PluginUiHostApiRequestEnvelopeV1, options?: PluginSurfaceHostApiRequestOptions): Promise<PluginUiJsonValueV1> => {
            const parsed = PluginUiResourceIntentV1Schema.safeParse(request.payload);
            if (!parsed.success) return invalidPayload('plugin_surface_resource_payload_invalid');
            const refusal = preflight(input, options, 'plugin_surface_resource_open_cancelled');
            if (refusal) return refusal;
            let failure: PluginUiJsonValueV1 = unavailable('plugin_surface_resource_open_unavailable');
            const opened = await requestOpenResource(parsed.data, {
                ...input.resourceContext,
                openExternal: async url => {
                    if (!input.executeAction) return false;
                    const result = await input.executeAction({ ...request, method: 'executeAction',
                        payload: { action: 'links.openExternal', input: { url } } }, options);
                    failure = result;
                    return result !== null && typeof result === 'object' && !Array.isArray(result)
                        && 'status' in result && result.status === 'opened';
                },
            });
            return opened ? null : failure;
        },
        diagnostic: (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): PluginUiJsonValueV1 => {
            const refusal = preflight(input, options, 'plugin_surface_diagnostic_cancelled');
            if (refusal) return refusal;
            const parsed = PluginUiHostApiDiagnosticV1Schema.safeParse(request.payload);
            if (!parsed.success) return invalidPayload('plugin_surface_diagnostic_payload_invalid');
            return logPluginSurfaceDiagnostic(input.surfaceContext, parsed.data)
                ? null
                : unavailable('plugin_surface_diagnostic_unavailable');
        },
        readClipboard: async (
            _request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): Promise<PluginUiJsonValueV1> => {
            const refusal = preflight(input, options, 'plugin_surface_clipboard_read_cancelled');
            if (refusal) return refusal;
            const value = await getClipboardStringSafe();
            const afterRead = preflight(input, options, 'plugin_surface_clipboard_read_cancelled');
            if (afterRead) return afterRead;
            return value === null
                ? unavailable('plugin_surface_clipboard_unavailable')
                : { value };
        },
        writeClipboard: async (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): Promise<PluginUiJsonValueV1> => {
            const parsed = PluginUiHostApiWriteClipboardRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return invalidPayload('plugin_surface_clipboard_write_payload_invalid');
            const refusal = preflight(input, options, 'plugin_surface_clipboard_write_cancelled');
            if (refusal) return refusal;
            // A successful platform write is already an outward effect; do not
            // rewrite it as stale/cancelled after settlement and invite a retry.
            let failure: PluginUiJsonValueV1 = unavailable('plugin_surface_clipboard_unavailable');
            const copied = await writeClipboardStringFromUi(parsed.data.value, async (action, actionInput) => {
                if (!input.executeAction) return { ok: false, errorCode: 'clipboard_unavailable', error: 'clipboard_unavailable' };
                const result = await input.executeAction({ ...request, method: 'executeAction',
                    payload: { action, input: actionInput } }, options);
                if (result !== null && typeof result === 'object' && !Array.isArray(result)
                    && 'status' in result && result.status === 'copied') return { ok: true, result };
                failure = result ?? unavailable('plugin_surface_clipboard_unavailable');
                return { ok: false, errorCode: 'clipboard_unavailable', error: 'clipboard_unavailable' };
            });
            return copied.ok ? null : failure;
        },
        openExternalLink: async (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): Promise<PluginUiJsonValueV1> => {
            const parsed = PluginUiHostApiOpenExternalLinkRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return invalidPayload('plugin_surface_external_link_payload_invalid');
            const refusal = preflight(input, options, 'plugin_surface_external_link_cancelled');
            if (refusal) return refusal;
            if (!input.executeAction) return unavailable('plugin_surface_external_link_unavailable');
            const result = await input.executeAction({ ...request, method: 'executeAction',
                payload: { action: 'links.openExternal', input: { url: parsed.data.url } } }, options);
            return result !== null && typeof result === 'object' && !Array.isArray(result)
                && 'status' in result && result.status === 'opened' ? null : result;
        },
    });
}
