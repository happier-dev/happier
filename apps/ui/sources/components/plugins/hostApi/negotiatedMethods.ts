import {
    PLUGIN_UI_HOST_METHODS_V1,
    type PluginUiHostMethodV1,
} from '@happier-dev/protocol/plugins/ui';

/**
 * The ONE rule that turns a mount's installed handlers into the set a transport
 * may advertise (UI-D02/UI-D03).
 *
 * `context` is mount-owned rather than handler-owned, and `watchContext` is
 * answered from the SAME mount-owned fact through a push producer — so a
 * transport that can serve `context` and can push serves `watchContext` too,
 * without anyone registering a handler for it. Everything else needs its own
 * installed handler.
 *
 * `canPushToSurface` is the part that genuinely differs between transports and
 * is why this is one function with an input rather than two: the React Native
 * mount is in-process and can always push, while the hosted-web bridge can push
 * only once a frame sink is attached. A transport that advertised
 * `watchContext` without a push producer would hand the author an establishment
 * that observes nothing forever.
 *
 * This is a projection of `PLUGIN_UI_HOST_METHODS_V1`, not a second
 * vocabulary: the Protocol tuple stays the only place a method name is written.
 */
export function resolveNegotiatedPluginSurfaceHostApiMethods(input: Readonly<{
    installedMethods: readonly PluginUiHostMethodV1[];
    canPushToSurface: boolean;
}>): readonly PluginUiHostMethodV1[] {
    const installed = new Set<PluginUiHostMethodV1>(input.installedMethods);
    return Object.freeze(PLUGIN_UI_HOST_METHODS_V1.filter((method) => (
        method === 'watchContext'
            ? input.canPushToSurface && installed.has('context')
            : installed.has(method)
    )));
}
