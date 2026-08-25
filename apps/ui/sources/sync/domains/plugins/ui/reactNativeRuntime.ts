import type {
    DaemonPluginReactNativeBundleCacheIdentityV1,
    PluginReactNativeCompatibilityDecisionV1,
} from '@happier-dev/protocol';

export type PluginReactNativeCompatibilityDecision = Readonly<
    Omit<PluginReactNativeCompatibilityDecisionV1, 'diagnostics'>
    & { diagnostics: readonly string[] }
>;

/**
 * The daemon's canonical React Native cache identity, not a second local
 * shape. The producer validates `runtime.cacheIdentity` with the same Protocol
 * schema, so a structural copy here would drift from the wire contract.
 */
export type PluginReactNativeBundleCacheIdentity =
    Readonly<DaemonPluginReactNativeBundleCacheIdentityV1>;
