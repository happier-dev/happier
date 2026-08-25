/** @moduleRealm browser */
import { createPluginUiHostApiClientFromTransport } from './clientTransport.js';
import {
    awaitHostedWebPluginUiHostApiClientBootstrapFromCurrentRealm,
    isHostedWebCollectionUiQueryCapabilityKnown,
    readHostedWebCollectionUiQueryTransport,
} from './hostedWebClientBootstrap.js';
import type { PluginUiHostApi, RenderContext } from './hostApi.js';

type CreatePluginUiHostApiClientOptions = Readonly<{ signal?: AbortSignal }>;

// Deliberately not exported through the public UI client entrypoint. The
// artifact wrapper is the sole consumer and copies the public RenderContext
// before author code runs, so hosted Data capability cannot become a second
// author-visible bootstrap contract.
const PLUGIN_UI_PRIVATE_HOSTED_WEB_COLLECTION_UI_QUERY_TRANSPORT_KEY = Symbol.for(
    'happier.pluginUi.privateHostedWebCollectionUiQueryTransport.v1',
);
const PLUGIN_UI_PRIVATE_MOUNTED_COMPOSER_REF_KEY = Symbol.for(
    'happier.pluginUi.privateMountedComposerRef.v1',
);

async function requireBootstrap(options: CreatePluginUiHostApiClientOptions) {
    return awaitHostedWebPluginUiHostApiClientBootstrapFromCurrentRealm(options);
}

export const createPluginUiHostApiClient = async (
    options: CreatePluginUiHostApiClientOptions = {},
): Promise<PluginUiHostApi> => {
    const bootstrap = await requireBootstrap(options);
    return createPluginUiHostApiClientFromTransport({
        identity: bootstrap.identity,
        transport: bootstrap.transport,
        ...(bootstrap.apiRange === undefined ? {} : { apiRange: bootstrap.apiRange }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
};

/**
 * Everything a hosted-web surface is mounted WITH, not just the host API.
 *
 * A React Native surface receives a `RenderContext`; a hosted-web surface used
 * to receive a bare `PluginUiHostApi`, so the two halves of the same product
 * disagreed about what a mounted surface knows. `openSurface(view, input)` could
 * not reach a hosted-web destination, an `appPage` could not read its own
 * `subPath`, and a retired surface had no signal to abort in-flight author work.
 *
 * This returns the SAME public `RenderContext` — no hosted-web-only type — built
 * from the host-issued surface binding:
 *
 * - `plugin` comes from the binding identity; `surface.mount` is the one
 *   host-stamped destination-or-embedded mount fact;
 * - `surface` is the negotiated snapshot; use `hostApi.watchContext` for changes;
 * - `launchInput` / `subPath` are the host's bounded launch facts, absent when
 *   the surface was opened without them;
 * - `signal` aborts when the host retires the surface or the client goes
 *   terminally offline, so an author can cancel work that no longer has a home.
 */
export const createPluginUiRenderContext = async (
    options: CreatePluginUiHostApiClientOptions = {},
): Promise<RenderContext> => {
    const bootstrap = await requireBootstrap(options);
    const retirement = new AbortController();
    let active = false;
    const activity = Object.freeze({
        get active(): boolean { return active; },
    });
    const hostApi = await createPluginUiHostApiClientFromTransport({
        identity: bootstrap.identity,
        transport: bootstrap.transport,
        ...(bootstrap.apiRange === undefined ? {} : { apiRange: bootstrap.apiRange }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onDisconnected: (reason) => { retirement.abort(reason); },
        onContextActivity: (next) => { active = next.active; },
    });
    const surface = await hostApi.context();
    const context = {
        plugin: Object.freeze({
            id: bootstrap.identity.pluginId,
            version: bootstrap.identity.pluginVersion,
        }),
        surface,
        hostApi,
        signal: retirement.signal,
        activity,
        // Absent stays absent: spreading an `undefined` key would make "opened
        // without input" indistinguishable from "opened with an explicit
        // undefined" for an author reading the key.
        ...(bootstrap.launchInput === undefined ? {} : { launchInput: bootstrap.launchInput }),
        ...(bootstrap.subPath === undefined ? {} : { subPath: bootstrap.subPath }),
    };
    const collectionUiQueryTransport = readHostedWebCollectionUiQueryTransport(bootstrap);
    if (isHostedWebCollectionUiQueryCapabilityKnown(bootstrap)) {
        Object.defineProperty(context, PLUGIN_UI_PRIVATE_HOSTED_WEB_COLLECTION_UI_QUERY_TRANSPORT_KEY, {
            configurable: false,
            enumerable: false,
            writable: false,
            value: collectionUiQueryTransport
                ? Object.freeze({
                    kind: 'available' as const,
                    acquireTransport: async () => collectionUiQueryTransport,
                })
                : Object.freeze({ kind: 'unavailable' as const }),
        });
    }
    if (bootstrap.composerRef !== undefined) {
        Object.defineProperty(context, PLUGIN_UI_PRIVATE_MOUNTED_COMPOSER_REF_KEY, {
            configurable: false,
            enumerable: false,
            writable: false,
            value: bootstrap.composerRef,
        });
    }
    return Object.freeze(context);
};
