/**
 * RN-WEB-LOADER item 1 (shared externals-resolution fix): the canonical
 * well-known global key + specifier list a web-target plugin UI bundle's
 * `react` / `react-native-web` / host-API-client imports are aliased to at
 * build time, and read back from at host-runtime install time.
 *
 * Both `packages/plugin-sdk` (build-time: aliases these bare specifiers to a
 * virtual module that reads off this global) and `apps/ui` (host-runtime:
 * installs the real `react`/`react-native-web`/hostApiClient module
 * namespaces onto this global before `import()`-ing any web-target plugin
 * bundle) depend on `@happier-dev/protocol`, so this constant lives here as
 * the single owner both sides import — never duplicated/hand-rolled at
 * either end (AGENTS.md split-brain avoidance).
 *
 * This closes the latent gap the RNWEB-SPIKE found: `external:['react',
 * 'react-native-web', hostApiClient]` on its own only tells a bundler not to
 * bundle those specifiers — it does not make them resolvable by a real
 * browser's native `import()`, which cannot resolve bare specifiers. The
 * fix is a virtual-module alias reading off this global, not an import map.
 */

export const PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY = '__happierPluginHostRuntime__' as const;

export const PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS = Object.freeze([
    'react',
    'react-native-web',
    '@happier-dev/plugin-sdk/ui/hostApiClient',
] as const);

export type PluginUiHostRuntimeExternalSpecifierV1 =
    typeof PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS[number];

/**
 * The shape installed on `globalThis[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY]` by
 * the host before `import()`-ing a web-target plugin UI bundle. Keys mirror
 * `PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS` (specifier -> host-provided
 * module namespace), so every externalized specifier has a value to read.
 */
export type PluginUiHostRuntimeExternalGlobalV1 = Readonly<{
    react: unknown;
    'react-native-web': unknown;
    '@happier-dev/plugin-sdk/ui/hostApiClient': unknown;
}>;

export function isPluginUiHostRuntimeExternalGlobalInstalled(
    globalScope: Readonly<Record<string, unknown>> = globalThis as unknown as Readonly<Record<string, unknown>>,
): boolean {
    const value = globalScope[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY];
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Readonly<Record<string, unknown>>;
    return PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS.every((specifier) => record[specifier] !== undefined);
}
