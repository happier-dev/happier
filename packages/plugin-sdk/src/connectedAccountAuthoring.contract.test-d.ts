import { definePlugin, type PluginConnectedAccountDefinition } from './definePlugin.js';
import type { ConnectedAccountRuntime, ConnectedAccountAuthenticationRuntime, ConnectedAccountPortableAuthenticationContext, ConnectedAccountPortableReadContext } from './connectedAccounts.js';
import type { PluginAccountApi } from './activation.js';
import type { LoggerService } from './services/core.js';

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

export function authorPortableAuthentication(api: PluginAccountApi, runtime: ConnectedAccountAuthenticationRuntime,
    context: ConnectedAccountPortableAuthenticationContext) {
    api.connectedAccounts.register('portable', runtime);
    runtime.materialize;
    context.services.logger?.warn('Authentication needs attention');
    // @ts-expect-error Portable authentication receives HTTP, never a native process service.
    context.services.exec;
    return context.services.http;
}

export function authorAuthenticationHostDiagnostics(context: ConnectedAccountPortableAuthenticationContext, logger: LoggerService) {
    const appContext: ConnectedAccountPortableAuthenticationContext = {
        ...context, services: { http: context.services.http },
    };
    const daemonContext: ConnectedAccountPortableAuthenticationContext = {
        ...context, services: { http: context.services.http, logger },
    };
    daemonContext.services.logger?.warn('Authentication needs attention');
    return { appContext, daemonContext };
}

export function authorPortableRead(context: ConnectedAccountPortableReadContext) {
    // @ts-expect-error Portable established reads never receive native process authority.
    context.services.exec;
    // @ts-expect-error Established reads cannot stage credential mutations.
    context.stagedCredentials;
    return context.credentials.get('token', { signal: context.signal });
}
