import {
    PluginUiHostApiDiagnosticV1Schema,
    PluginUiHostApiOpenExternalLinkRequestV1Schema,
    PluginUiHostApiWriteClipboardRequestV1Schema,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import { logPluginSurfaceDiagnostic } from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';
import {
    getClipboardStringSafe,
    setClipboardStringSafe,
} from '@/utils/ui/clipboard';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiHandlers,
    type PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';

type LocalHostHandlerInput = Readonly<{
    surfaceContext: PluginUiSurfaceContextV1;
    /** The bound controller remains the only mount-currentness owner. */
    isCurrent?: () => boolean;
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
    'diagnostic' | 'readClipboard' | 'writeClipboard' | 'openExternalLink'
> {
    return Object.freeze({
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
            return await setClipboardStringSafe(parsed.data.value)
                ? null
                : unavailable('plugin_surface_clipboard_unavailable');
        },
        openExternalLink: async (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: PluginSurfaceHostApiRequestOptions,
        ): Promise<PluginUiJsonValueV1> => {
            const parsed = PluginUiHostApiOpenExternalLinkRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) return invalidPayload('plugin_surface_external_link_payload_invalid');
            const refusal = preflight(input, options, 'plugin_surface_external_link_cancelled');
            if (refusal) return refusal;
            // Opening an external URL is likewise authoritative once the host
            // platform acknowledges it; retirement cannot safely turn it into a
            // retryable non-effect.
            return await openExternalUrl(parsed.data.url)
                ? null
                : unavailable('plugin_surface_external_link_unavailable');
        },
    });
}
