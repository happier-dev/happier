/**
 * RN-WEB-LOADER item 1 (shared externals-resolution fix): the canonical
 * well-known global key + specifier list a web-target plugin UI bundle's
 * exact React runtime / `react-native-web` / host-API-client imports are
 * aliased to at build time, and read back from at host-runtime install time.
 *
 * Both `packages/plugin-sdk` (build-time: aliases these bare specifiers to a
 * virtual module that reads off this global) and `apps/ui` (host-runtime:
 * installs the real React runtime/`react-native-web`/hostApiClient module
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

/**
 * The exact React namespace closure plugin UI artifacts may consume from the
 * host. JSX compilers import the two subpaths directly, so sharing only the
 * `react` package root does not preserve one React closure.
 */
export const PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS = Object.freeze([
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
] as const);

export type PluginUiHostReactRuntimeExternalSpecifierV1 =
    typeof PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS[number];

export const PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS = Object.freeze([
    ...PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS,
    'react-native-web',
    '@happier-dev/plugin-sdk/ui/client',
] as const);

export type PluginUiHostRuntimeExternalSpecifierV1 =
    typeof PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS[number];

/**
 * The shape installed on `globalThis[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY]` by
 * the host before `import()`-ing a web-target plugin UI bundle. Keys are
 * DERIVED from `PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS` (specifier ->
 * host-provided module namespace), so adding a specifier to the list alone
 * makes the host installer's `satisfies` fail to compile rather than shipping
 * an externalized specifier nothing provides.
 */
export type PluginUiHostRuntimeExternalGlobalV1 = Readonly<
    Record<PluginUiHostRuntimeExternalSpecifierV1, unknown>
>;

/**
 * EU-6: the NATIVE (React Native / Re.Pack Module Federation) counterpart of
 * `PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS`, and the single owner of the
 * host-provided singleton closure for native-target plugin UI artifacts.
 *
 * Both ends derive from THIS list — `packages/plugin-sdk`'s Re.Pack build
 * preset (`external` + the `shared` Module Federation map, every entry
 * `singleton:true, import:false`) and `apps/ui`'s Module Federation host share
 * scope (`moduleFederationHostSharedScope.ts`, which hands the host's own
 * module instances to a remote container's `container.init(shareScope)`).
 *
 * It exists because those two lists were hand-maintained and diverged
 * (UI-D14): the build externalized Reanimated and both React Navigation
 * packages with `import:false` — a promise that the plugin bundle contains NO
 * fallback copy — while the host share scope provided only the React runtimes
 * and `react-native`. A plugin importing navigation therefore built cleanly
 * and failed only on device.
 *
 * Membership rule (plan §3.8/§EU-6): a specifier belongs here only when
 * duplicate copies would break singleton identity AND the host genuinely
 * provides the module. Share-scope VERSIONS are deliberately NOT owned here —
 * they stay declared next to the host providers, in lockstep with the host
 * app's own `package.json` (see `moduleFederationHostSharedScope.ts`).
 *
 * Inventoried and deliberately NOT in the closure, so the next reader does not
 * re-litigate them:
 * - `react-native-screens`, `react-native-safe-area-context`,
 *   `react-native-gesture-handler`: `@react-navigation/native-stack` reaches
 *   screens/safe-area from the HOST copy it is itself loaded from, so a plugin
 *   never composes its own instance with the host navigator, and no public
 *   `@happier-dev/plugin-ui` component consumes them. Externalizing them today
 *   would add `import:false` promises with no consumer. They become closure
 *   members the moment a public component or the plugin-local stack needs a
 *   provider instance shared with the host (safe-area is the likeliest first).
 * - portal/overlay coordination, focus management and toast/dialog
 *   presentation: `apps/ui` carries **no** third-party package for these (no
 *   floating-ui, no portal, no toast dependency) — they are app-internal
 *   modules whose shared home is `@happier-dev/plugin-ui`, so their closure
 *   question is the `plugin-ui` one below, not a separate specifier.
 * - `@happier-dev/plugin-ui` itself: blocked on EU-0 item 12 (W-04); §3.10.1
 *   forbids externalizing it while its compatibility authority is unsettled.
 * - `react-native-web`: web-closure only, and never valid natively.
 */
export const PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS = Object.freeze([
    ...PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS,
    'react-native',
    'react-native-reanimated',
    '@react-navigation/native',
    '@react-navigation/native-stack',
] as const);

export type PluginUiHostNativeRuntimeExternalSpecifierV1 =
    typeof PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS[number];

/**
 * The native provided-namespace shape, mirroring the web
 * `PluginUiHostRuntimeExternalGlobalV1` invariant: specifier -> the host's own
 * module namespace. The native host does not install these on a global (the
 * Module Federation share scope is the transport), but the closure obligation
 * is identical, so the host's provider table is typed against this record and
 * a specifier added to the list alone breaks that host provider.
 */
export type PluginUiHostNativeRuntimeExternalModulesV1 = Readonly<
    Record<PluginUiHostNativeRuntimeExternalSpecifierV1, unknown>
>;

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
