import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
    PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY,
    type PluginUiHostRuntimeExternalSpecifierV1,
} from '@happier-dev/protocol/plugins/ui';

/**
 * RN-WEB-LOADER item 1 — the shared externals-resolution fix.
 *
 * `external:['react','react-native-web',hostApiClient]` on its own only
 * tells the bundler not to bundle those specifiers; it leaves them as
 * literal bare ESM specifiers in the built output, which a real browser's
 * native `import()` cannot resolve (RNWEB-SPIKE §Q1(c) — this was a latent,
 * never-exercised gap in the earlier web build preset too,
 * not just the new reactNative-web one). Rather than an import map (patchy
 * engine support, one-per-document constraints), this plugin ALIASES each
 * externalized specifier to a small generated virtual module that reads the
 * real module namespace off `globalThis[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY]`
 * — the host installs the real `react`/`react-native-web`/hostApiClient
 * namespaces there once, before `import()`-ing any plugin bundle, so every
 * plugin shares the SAME React instance (hooks/context correctness) with
 * zero browser feature beyond dynamic `import()` (already required) and no
 * per-plugin author burden.
 *
 * Named exports are enumerated from the REAL package at build time (this
 * hook runs in Node during the build, where `react`/`react-native-web`/the
 * hostApiClient module are real, resolvable dependencies of the plugin
 * project being built) so the generated shim never drifts from the actual
 * package's export surface.
 *
 * Intentionally duck-typed (no `vite` import/dependency): the returned
 * object satisfies Vite's `Plugin` shape structurally (`name`, `enforce`,
 * `resolveId`, `load` are all valid optional Plugin hook fields) without
 * plugin-sdk taking a hard dependency on the `vite` package. Authors spread
 * it into their own `vite.config.ts`'s `plugins` array.
 */

const VIRTUAL_MODULE_PREFIX = 'happier-plugin-host-runtime:';
const RESOLVED_VIRTUAL_MODULE_PREFIX = `\0${VIRTUAL_MODULE_PREFIX}`;

export type PluginUiHostRuntimeExternalsRealModuleLoader = (
    specifier: PluginUiHostRuntimeExternalSpecifierV1,
) => Promise<Readonly<Record<string, unknown>>>;

export type PluginUiHostRuntimeExternalsVitePlugin = Readonly<{
    name: 'happier-plugin-ui-host-runtime-externals';
    enforce: 'pre';
    // FIX-RNWEB-SERVING: real Vite plugin hook, invoked once with the
    // resolved build config (`config.root` is the consuming PLUGIN AUTHOR's
    // project directory, e.g. `packages/plugins/<name>`) before any `load`
    // call. Used to switch the default real-module resolution from
    // plugin-sdk's own install location (wrong — see `defaultImportRealModule`
    // doc comment) to the author project's, with zero required author config.
    configResolved: (config: Readonly<{ root: string }>) => void;
    resolveId: (source: string) => string | null;
    load: (id: string) => Promise<string | null>;
}>;

/**
 * FIX-RNWEB-SERVING: a bare, un-rooted dynamic `import()` resolves relative
 * to the FILE issuing it — here, plugin-sdk's own compiled
 * `dist/ui/hostRuntimeExternalsBuildPlugin.js`. That is never where a
 * plugin's real `react`/`react-native-web` dependency actually lives (it is
 * a dependency of the AUTHOR's package being built, e.g.
 * `packages/plugins/inspector`, not of plugin-sdk itself) — a real,
 * previously-unexercised defect (RN-WEB-LOADER's own self-attack flagged
 * this exact `import()`/browser round-trip as "genuinely unexercised in ANY
 * test environment"; the first real `vite build()` of a real plugin source
 * in this lane reproduced it directly: `Cannot find package 'react' imported
 * from .../plugin-sdk/dist/ui/hostRuntimeExternalsBuildPlugin.js`). This
 * project-relative fallback resolves each specifier's REAL installed
 * location the same way Vite itself resolves the author's other bare
 * imports (`resolve.alias`'s `react-native` -> `react-native-web`,
 * `node_modules` walk from the project root) — `configResolved`'s
 * `config.root` — rather than plugin-sdk's own package location. Kept as
 * the DEFAULT only; `options.importRealModule` (tests, `RNWEB-SPIKE`'s
 * injected-module pattern) always takes precedence and is never overridden.
 */
function createProjectRelativeImportRealModule(
    root: string,
): (specifier: PluginUiHostRuntimeExternalSpecifierV1) => Promise<Readonly<Record<string, unknown>>> {
    const resolveFrom = createRequire(pathToFileURL(join(root, 'package.json')).href);
    return async (specifier) => {
        const resolvedPath = resolveFrom.resolve(specifier);
        return import(/* @vite-ignore */ pathToFileURL(resolvedPath).href) as Promise<Readonly<Record<string, unknown>>>;
    };
}

function defaultImportRealModule(
    specifier: PluginUiHostRuntimeExternalSpecifierV1,
): Promise<Readonly<Record<string, unknown>>> {
    return import(/* @vite-ignore */ specifier) as Promise<Readonly<Record<string, unknown>>>;
}

function isSafeExportBindingName(name: string): boolean {
    return name !== 'default' && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);
}

/**
 * Generate the virtual module source for one externalized specifier. Real,
 * unit-testable independently of Vite: given a real (or injected-for-test)
 * module namespace, produces the exact ESM text the plugin's `load` hook
 * returns.
 */
export async function generatePluginUiHostRuntimeExternalModuleSource(
    specifier: PluginUiHostRuntimeExternalSpecifierV1,
    importRealModule: PluginUiHostRuntimeExternalsRealModuleLoader = defaultImportRealModule,
): Promise<string> {
    const real = await importRealModule(specifier);
    const namedExports = Object.keys(real).filter(isSafeExportBindingName);

    const globalKeyLiteral = JSON.stringify(PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY);
    const specifierLiteral = JSON.stringify(specifier);
    const lines: string[] = [
        `const __rt = globalThis[${globalKeyLiteral}];`,
        `if (!__rt || !(${specifierLiteral} in __rt)) {`,
        `  throw new Error(${JSON.stringify(
            `happier plugin host runtime "${specifier}" is not installed; the host must set `
                + `globalThis[${PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY}] before loading this plugin surface.`,
        )});`,
        '}',
        `const __mod = __rt[${specifierLiteral}];`,
        "export default (__mod && typeof __mod === 'object' && 'default' in __mod) ? __mod.default : __mod;",
    ];
    for (const name of namedExports) {
        lines.push(`export const ${name} = __mod[${JSON.stringify(name)}];`);
    }
    return lines.join('\n');
}

export function createPluginUiHostRuntimeExternalsVitePlugin(options?: Readonly<{
    specifiers?: readonly PluginUiHostRuntimeExternalSpecifierV1[];
    importRealModule?: PluginUiHostRuntimeExternalsRealModuleLoader;
}>): PluginUiHostRuntimeExternalsVitePlugin {
    const specifiers = new Set<string>(options?.specifiers ?? PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS);
    // FIX-RNWEB-SERVING: an explicitly injected loader (tests, or an author
    // opting out) always wins and is never replaced by `configResolved`.
    // Absent one, `importRealModule` starts as the (wrong-for-real-builds)
    // module-relative default and is upgraded to the project-relative
    // resolver once Vite reports the real build root — `load` always reads
    // the current value of this `let`, not a snapshot taken before
    // `configResolved` ran.
    let importRealModule = options?.importRealModule ?? defaultImportRealModule;

    return Object.freeze({
        name: 'happier-plugin-ui-host-runtime-externals',
        enforce: 'pre',
        configResolved: (config: Readonly<{ root: string }>) => {
            if (!options?.importRealModule && config.root) {
                importRealModule = createProjectRelativeImportRealModule(config.root);
            }
        },
        resolveId: (source: string) => (
            specifiers.has(source) ? `${RESOLVED_VIRTUAL_MODULE_PREFIX}${source}` : null
        ),
        load: async (id: string) => {
            if (!id.startsWith(RESOLVED_VIRTUAL_MODULE_PREFIX)) {
                return null;
            }
            const specifier = id.slice(RESOLVED_VIRTUAL_MODULE_PREFIX.length) as PluginUiHostRuntimeExternalSpecifierV1;
            return generatePluginUiHostRuntimeExternalModuleSource(specifier, importRealModule);
        },
    });
}
