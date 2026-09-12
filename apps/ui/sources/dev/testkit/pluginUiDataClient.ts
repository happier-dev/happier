import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';

function unavailableAccountKv(): PluginUiDataClient['accountKv'] {
    return new Proxy(Object.create(null) as object, {
        get() {
            throw new Error('This test fixture does not provide mounted accountKv.');
        },
    }) as PluginUiDataClient['accountKv'];
}

/**
 * Completes a presentation-only Data client without pretending that its test
 * owns Account KV or Settings behavior. Any accidental use fails immediately.
 */
export function completePresentationPluginUiDataClient(
    client: Pick<PluginUiDataClient, 'collection' | 'openCollectionQuery'>,
): PluginUiDataClient {
    return Object.freeze({
        ...client,
        accountKv: unavailableAccountKv(),
    });
}
