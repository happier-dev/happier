/**
 * Canonical specifier list for modules supplied by the app while evaluating a
 * universal plugin UI CommonJS artifact. The SDK
 * compiler externalizes exactly this list and the app evaluator resolves each
 * `require()` from its same-realm host module map.
 */

export const PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS = Object.freeze([
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-native',
    'react-native-web',
    '@react-navigation/native',
    '@react-navigation/native-stack',
    'react-native-reanimated',
    '@happier-dev/plugin-ui',
    '@happier-dev/plugin-ui/components',
    '@happier-dev/plugin-ui/hostApi',
    '@happier-dev/plugin-ui/data',
    '@happier-dev/plugin-ui/presentation',
    '@happier-dev/plugin-ui/declarative',
    '@happier-dev/plugin-ui/environment',
    '@happier-dev/plugin-ui/advanced',
    '@happier-dev/plugin-sdk/ui/client',
] as const);

export type PluginUiHostRuntimeExternalSpecifierV1 =
    typeof PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS[number];

/**
 * The direct evaluator map. Keys are derived from the exhaustive Protocol
 * specifier list so the host map cannot omit an externalized module.
 */
export type PluginUiHostRuntimeExternalModulesV1 = Readonly<
    Record<PluginUiHostRuntimeExternalSpecifierV1, unknown>
>;
