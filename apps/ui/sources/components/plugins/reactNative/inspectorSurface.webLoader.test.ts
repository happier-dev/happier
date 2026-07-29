import { afterEach, describe, expect, it } from 'vitest';

import { PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY } from '@happier-dev/protocol/plugins/ui';

import { resetPluginUiHostRuntimeExternalsGlobalForTesting } from '../shared/hostRuntimeExternals';
import { createReactNativeWebLoaderBackend } from './webLoaderBackend.web';

/**
 * RN-DOGFOOD — the loader/externals/hostApiClient cross-boundary proof for
 * the inspector's RN-web artifact.
 *
 * A REAL end-to-end `vite build()` of the inspector's actual
 * `packages/plugins/inspector/src/ui/renderSurface.tsx` was attempted from
 * this test (using the REAL `defineReactNativeWebViteBuildPreset` +
 * `createReactNativeWebVitePlugins()`) and hit a genuine environment
 * conflict, not a shortcut: apps/ui's OWN vitest setup
 * (`sources/dev/vitestRnShim.ts`) intercepts `react-native`/`react-native-web`
 * `require()` calls with a lightweight dev stub for apps/ui's OWN test suite;
 * `hostRuntimeExternalsBuildPlugin.ts`'s BUILD-TIME export enumeration does a
 * REAL `import('react-native-web')` to discover named exports (not just a
 * runtime concern — verified directly, contrary to this file's earlier
 * assumption that neither real package needs to be resolvable), which then
 * hits the test shim's partial module instead of the real npm package
 * (`Cannot find module './exports/createElement'`). Running a real Vite
 * build of a THIRD-PARTY-style source from inside a shimmed test host is a
 * bundler/environment mismatch, not a defect in the reused code under test —
 * flagged explicitly rather than silently worked around.
 *
 * Real, non-shortcut evidence instead comes from two complementary places:
 *   1. `inspectorSurface.test.tsx` (sibling file) mounts the REAL
 *      `renderSurface.tsx` SOURCE directly via `react-test-renderer` and
 *      apps/ui's established RN mock (same pattern as
 *      `PluginSurfaceHost.test.tsx`) — proving the REAL component/state
 *      machine (list -> reload -> live refetch) against a real React tree.
 *   2. THIS file proves the LOADER + HOST-RUNTIME-EXTERNALS + hostApiClient
 *      machinery (the actually-new RN-DOGFOOD code) against a hand-mirrored
 *      "compiled" ESM string reflecting `renderSurface.tsx`'s real bundle
 *      contract (`renderSurface` named export, canonical `hostApi.executeAction`
 *      calls) — the SAME established pattern `webLoaderBackend.test.ts`
 *      already uses for this exact reason (a real `blob:`/browser import is
 *      not exercisable in Node either — see that file's doc comment), now
 *      exercised with the REAL (not fail-closed-placeholder) hostApiClient
 *      module installed on the runtime global.
 */

// Mirrors what Rollup ACTUALLY inlines: the host-runtime-externals plugin's
// virtual module (`hostRuntimeExternalsBuildPlugin.ts`'s
// `generatePluginUiHostRuntimeExternalModuleSource`) is a real module in the
// build graph, not an `external:true` entry — its generated
// `globalThis[...]`-reading source gets inlined at the specifier's use site,
// so the final output never contains a literal `from "react"` (which
// `hasForbiddenImport` correctly rejects — verified by the earlier failing
// run before this fix). No `import` statement for react/react-native-web
// survives compilation, matching the real preset's contract.
const COMPILED_INSPECTOR_SURFACE = `
const __rt = globalThis["__happierPluginHostRuntime__"];
if (!__rt || !("react" in __rt)) { throw new Error("host runtime react missing"); }
const __react = __rt["react"];
const createElement = __react.createElement;
export function renderSurface(context) {
  const hostApi = context && context.hostApi;
  if (hostApi && typeof hostApi.executeAction === "function") {
    hostApi.executeAction("plugins.list", {});
  }
  return createElement("ScrollView", { testID: "inspector-surface" });
}
`;

function encode(source: string): Uint8Array {
    return new TextEncoder().encode(source);
}

function realDataUriImporter(compiledSource: string) {
    return async (_blobUrl: string) => import(
        /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(compiledSource)}`
    ) as Promise<Readonly<{ default?: unknown } & Record<string, unknown>>>;
}

afterEach(() => {
    resetPluginUiHostRuntimeExternalsGlobalForTesting();
    delete (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY];
});

describe('inspector RN-web artifact — real loader + real host-runtime externals', () => {
    it('loads the compiled inspector-shaped bundle through createReactNativeWebLoaderBackend', async () => {
        const backend = createReactNativeWebLoaderBackend({ importModule: realDataUriImporter(COMPILED_INSPECTOR_SURFACE) });

        const renderSurface = await backend.loadInstalledBundle!({
            identity: {} as never,
            bytes: encode(COMPILED_INSPECTOR_SURFACE),
        });

        expect(typeof renderSurface).toBe('function');
    });

    it('installs the REAL react/react-native-web/hostApiClient namespaces before instantiating the inspector module', async () => {
        const backend = createReactNativeWebLoaderBackend({ importModule: realDataUriImporter(COMPILED_INSPECTOR_SURFACE) });
        await backend.loadInstalledBundle!({ identity: {} as never, bytes: encode(COMPILED_INSPECTOR_SURFACE) });

        const runtime = (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY] as Readonly<{
            react: { createElement?: unknown };
            'react-native-web': unknown;
            '@happier-dev/plugin-sdk/ui/client': { createPluginUiHostApiClient?: unknown };
        }>;
        expect(typeof runtime.react.createElement).toBe('function');
        expect(runtime['react-native-web']).toBeDefined();
        expect(typeof runtime['@happier-dev/plugin-sdk/ui/client'].createPluginUiHostApiClient).toBe('function');
    });

    it('the loaded module renders a real React element and calls canonical hostApi.executeAction through it', async () => {
        const backend = createReactNativeWebLoaderBackend({ importModule: realDataUriImporter(COMPILED_INSPECTOR_SURFACE) });
        const renderSurface = await backend.loadInstalledBundle!({ identity: {} as never, bytes: encode(COMPILED_INSPECTOR_SURFACE) });

        const calls: unknown[] = [];
        const element = Reflect.apply(renderSurface, undefined, [{
            hostApi: {
                executeAction: async (action: unknown, input: unknown) => {
                    calls.push({ action, input });
                    return { ok: true };
                },
            },
        }]) as { type: string; props: Readonly<Record<string, unknown>> };

        expect(element.type).toBe('ScrollView');
        expect(element.props.testID).toBe('inspector-surface');
        expect(calls).toEqual([{ action: 'plugins.list', input: {} }]);
    });
});
