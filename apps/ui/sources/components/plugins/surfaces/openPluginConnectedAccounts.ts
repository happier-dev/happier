import {
    PluginUiOpenConnectedAccountsRequestV1Schema,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiOpenConnectedAccountsRequestV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiMethodHandler,
} from './createPluginSurfaceHostApi';

export type PluginOpenConnectedAccountsHandler = (
    request: PluginUiOpenConnectedAccountsRequestV1,
) => void | Promise<void>;

/**
 * Strict mounted adapter for Happier-owned Connected Accounts navigation.
 * Route construction stays in the app's Connected Accounts domain owner; this
 * adapter only validates the semantic public request and fences stale mounts.
 */
export function createPluginOpenConnectedAccountsHostApiHandler(
    open: PluginOpenConnectedAccountsHandler,
    isCurrent?: () => boolean,
): PluginSurfaceHostApiMethodHandler {
    return async (request: PluginUiHostApiRequestEnvelopeV1): Promise<PluginUiJsonValueV1> => {
        if (isCurrent?.() === false) {
            return createPluginSurfaceHostApiError('stale_surface', ['plugin_surface_retired']);
        }
        const parsed = PluginUiOpenConnectedAccountsRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) {
            return createPluginSurfaceHostApiError(
                'invalid_payload',
                ['plugin_connected_accounts_open_payload_invalid'],
            );
        }
        await open(parsed.data);
        return null;
    };
}
