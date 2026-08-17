import {
    ComposerRefV1Schema,
    PluginUiHostApiWireIdentityV1Schema,
    PluginUiLaunchInputV1Schema,
    PluginUiSubPathV1Schema,
    type ComposerRefV1,
    type PluginUiHostApiWireIdentityV1,
} from '@happier-dev/protocol/plugins/ui/client';

import type { JsonValue } from '../identity.js';
import type { PluginUiHostApiClientTransport } from './clientTransport.js';

/** Host-private bootstrap seam installed inside an isolated hosted-web realm. */
export const PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY = '__HAPPIER_PLUGIN_UI_HOST_API_CLIENT_V1__';

export interface PluginUiHostApiClientBootstrap {
    readonly identity: PluginUiHostApiWireIdentityV1;
    readonly transport: PluginUiHostApiClientTransport;
    readonly apiRange?: string;
    /**
     * The launch facts the host bound to THIS mount (EU-8), parsed through the
     * same Protocol bounds the React Native mount's `RenderContext` uses. Both
     * are absent — not `undefined`-valued — when the surface was opened without
     * them, so an author reading the key still learns the difference.
     */
    readonly launchInput?: JsonValue;
    readonly subPath?: string;
    /** Exact host-stamped Composer mount identity, never an author launch fact. */
    readonly composerRef?: ComposerRefV1;
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
    // Bounded at the Protocol owner, exactly as the mounted host parses them.
    // An out-of-bounds or illegal value is DROPPED rather than passed through:
    // the surface still mounts, and the author sees "no launch fact" instead of
    // one the host would never have produced.
    const rawLaunchInput: unknown = Reflect.get(value, 'launchInput');
    const launchInput = rawLaunchInput === undefined
        ? undefined
        : PluginUiLaunchInputV1Schema.safeParse(rawLaunchInput);
    const rawSubPath: unknown = Reflect.get(value, 'subPath');
    const subPath = rawSubPath === undefined
        ? undefined
        : PluginUiSubPathV1Schema.safeParse(rawSubPath);
    const rawComposerRef: unknown = Reflect.get(value, 'composerRef');
    const composerRef = rawComposerRef === undefined
        ? undefined
        : ComposerRefV1Schema.safeParse(rawComposerRef);
    return {
        identity: identity.data,
        ...(launchInput?.success ? { launchInput: launchInput.data as JsonValue } : {}),
        ...(subPath?.success ? { subPath: subPath.data } : {}),
        ...(composerRef?.success ? { composerRef: composerRef.data } : {}),
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
