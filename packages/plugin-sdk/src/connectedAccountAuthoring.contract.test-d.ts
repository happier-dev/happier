import { definePlugin, type PluginConnectedAccountDefinition } from './definePlugin.js';
import type { ConnectedAccountRuntime } from './connectedAccounts.js';

// Reusable immutable declarations are author input; parsed manifest DTOs keep
// their canonical Protocol type and validation contract.
const declaration = {
    title: 'Native connection',
    authentication: {
        defaultModeId: 'native',
        modes: [{
            id: 'native', kind: 'manual', title: 'Existing setup',
            outcomeReconciliation: 'none', fields: [],
            configuration: {
                scope: 'account', changeBehavior: 'reconnect',
                fields: [{
                    id: 'nativeHome', title: 'Native home', required: true,
                    secret: false, schema: { type: 'string', minLength: 1 },
                }],
            },
        }],
    },
} as const;

export function authorImmutableConnectedAccount(runtime: ConnectedAccountRuntime) {
    const account = { declaration, runtime } satisfies PluginConnectedAccountDefinition;
    return definePlugin({
        id: 'example.immutable-account', version: '1.0.0',
        connectedAccountDescriptors: { native: account },
    });
}

type Field = NonNullable<PluginConnectedAccountDefinition['declaration']['authentication']>['modes'][number]['configuration'];
export function authorInputRetainsRequiredPublicMetadata(field: NonNullable<Field>['fields'][number]) {
    const secret: boolean = field.secret;
    return secret;
}
