import {
    PluginUiHostApiWireIdentityV1Schema,
    type PluginUiHostApiWireIdentityV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginUiHostApiClientTransport } from './clientTransport.js';

/** Host-private bootstrap seam installed inside an isolated hosted-web realm. */
export const PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY = '__HAPPIER_PLUGIN_UI_HOST_API_CLIENT_V1__';

export interface PluginUiHostApiClientBootstrap {
    readonly identity: PluginUiHostApiWireIdentityV1;
    readonly transport: PluginUiHostApiClientTransport;
    readonly apiRange?: string;
}

export function readPluginUiHostApiClientBootstrap(): PluginUiHostApiClientBootstrap | undefined {
    const value: unknown = Reflect.get(globalThis, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY);
    if (typeof value !== 'object' || value === null) return undefined;
    const identity = PluginUiHostApiWireIdentityV1Schema.safeParse(Reflect.get(value, 'identity'));
    const transportValue: unknown = Reflect.get(value, 'transport');
    if (!identity.success || typeof transportValue !== 'object' || transportValue === null) return undefined;
    const send: unknown = Reflect.get(transportValue, 'send');
    const subscribe: unknown = Reflect.get(transportValue, 'subscribe');
    const apiRange: unknown = Reflect.get(value, 'apiRange');
    if (typeof send !== 'function' || typeof subscribe !== 'function' || (apiRange !== undefined && typeof apiRange !== 'string')) return undefined;
    return {
        identity: identity.data,
        transport: {
            send: async (message) => { await Reflect.apply(send, transportValue, [message]); },
            subscribe: (listener) => {
                const subscription: unknown = Reflect.apply(subscribe, transportValue, [listener]);
                if (typeof subscription !== 'object' || subscription === null) throw new TypeError('Invalid plugin UI host bootstrap subscription.');
                const dispose: unknown = Reflect.get(subscription, 'dispose');
                if (typeof dispose !== 'function') throw new TypeError('Invalid plugin UI host bootstrap subscription.');
                return { dispose: () => Reflect.apply(dispose, subscription, []) };
            },
        },
        ...(apiRange === undefined ? {} : { apiRange }),
    };
}
