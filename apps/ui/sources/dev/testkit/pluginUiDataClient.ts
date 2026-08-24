import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';

function unavailableMember<TMember extends 'accountKv' | 'accountSettings'>(
    member: TMember,
): PluginUiDataClient[TMember] {
    return new Proxy(Object.create(null) as object, {
        get() {
            throw new Error(`This test fixture does not provide mounted ${member}.`);
        },
    }) as PluginUiDataClient[TMember];
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
        accountKv: unavailableMember('accountKv'),
        accountSettings: unavailableMember('accountSettings'),
    });
}
