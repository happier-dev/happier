import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as React from 'react';
// Deliberately the REAL npm package, not the `react-native` specifier apps/ui's
// own vitest setup mocks with a lightweight dev stub (`vitestSetup.ts`'s
// `vi.mock('react-native', ...)` -> `reactNativeStub.ts`) — see the
// `installRealHostRuntimeExternalsForTesting` doc comment below for why the
// production build needs the REAL package's full export surface here.
import * as RealReactNativeWeb from 'react-native-web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY } from '@happier-dev/protocol/plugins/ui';

import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';

import {
    installPluginUiHostRuntimeExternalsGlobal,
    resetPluginUiHostRuntimeExternalsGlobalForTesting,
} from '../shared/hostRuntimeExternals';
import { createReactNativeWebLoaderBackend } from './webLoaderBackend.web';

/**
 * FIX-RNWEB-SERVING — the real production-artifact proof this lane's
 * TEST requirement asks for: "first-party bundled plugin + production
 * artifact -> loadable on web (real-ESM import test pattern)".
 *
 * Unlike the sibling `inspectorSurface.webLoader.test.ts` (a hand-mirrored
 * "compiled" string standing in for a bundle, because running a real
 * `vite build()` FROM inside apps/ui's shimmed test host hits a genuine
 * bundler/environment conflict — see that file's doc comment), this file
 * reads the ACTUAL bytes `FIX-RNWEB-SERVING.md`'s real `vite build` run
 * produced on disk
 * (`packages/plugins/inspector/dist/happier-plugin-ui/react-native-web/inspector-app-native/entry.mjs.bundle`,
 * the same file the Inspector manifest renderer and generated
 * `ui-artifacts.json` web entry register for real byte-serving) and runs it
 * through the SAME real loader
 * a connecting web client uses in production. The compiled output has ZERO
 * bare `react`/`react-native-web` imports (the host-runtime-externals
 * plugin inlines `globalThis[...]` reads at every use site instead — real
 * ESM, verified directly: `grep -c '^import ' entry.mjs.bundle` is 0), so a
 * `data:` URI `import()` (Node's `blob:`-unsupported substitute, same
 * established pattern `webLoaderBackend.test.ts` uses) can load it exactly
 * like a real browser's `import()` of a `blob:` URL would.
 *
 * One real environment gap, named not hidden: the REAL build's
 * host-runtime-externals shim (`hostRuntimeExternalsBuildPlugin.ts`) eagerly
 * re-exports EVERY named export the real `react-native-web` package has
 * (enumerated at build time), so evaluating it needs a COMPLETE
 * `react-native-web` surface at runtime — apps/ui's own vitest setup
 * globally mocks the `react-native` specifier with a deliberately partial
 * dev stub (`reactNativeStub.ts`, missing e.g. `AppRegistry`) for its OWN
 * test suite's sake, which throws on the first missing property access
 * (verified directly). `installRealHostRuntimeExternalsForTesting` below
 * installs the REAL `react-native-web` package instead (already a real
 * apps/ui dependency, imported directly — NOT through the mocked
 * `react-native` specifier), which is what a real browser's Metro-built
 * production bundle actually runs against; this is a more faithful
 * substitute than the app's own dev/test stub, not a shortcut around it.
 */

/**
 * Primes `installPluginUiHostRuntimeExternalsGlobal()` once (so its internal
 * `installed` idempotency flag is set — the real loader calls it
 * unconditionally on every load), then overwrites the installed global with
 * the REAL `react`/`react-native-web` packages plus the REAL hostApiClient it
 * already produced. Subsequent internal calls from the loader see
 * `installed === true` and skip, leaving this override intact.
 */
function installRealHostRuntimeExternalsForTesting(): void {
    installPluginUiHostRuntimeExternalsGlobal();
    const runtime = (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY] as Readonly<{
        'react/jsx-runtime': unknown;
        'react/jsx-dev-runtime': unknown;
        '@happier-dev/plugin-sdk/ui/client': unknown;
    }>;
    (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY] = Object.freeze({
        react: React,
        'react/jsx-runtime': runtime['react/jsx-runtime'],
        'react/jsx-dev-runtime': runtime['react/jsx-dev-runtime'],
        'react-native-web': RealReactNativeWeb,
        '@happier-dev/plugin-sdk/ui/client': runtime['@happier-dev/plugin-sdk/ui/client'],
    });
}

const PRODUCTION_ARTIFACT_PATH = fileURLToPath(
    new URL(
        '../../../../../../packages/plugins/inspector/dist/happier-plugin-ui/react-native-web/inspector-app-native/entry.mjs.bundle',
        import.meta.url,
    ),
);
const PRODUCTION_ARTIFACT_GRAPH_PATH = fileURLToPath(
    new URL(
        '../../../../../../packages/plugins/inspector/dist/happier-plugin-ui/ui-artifacts.json',
        import.meta.url,
    ),
);

// Node's ESM loader cannot `import()` a `blob:` URL (verified directly by
// `webLoaderBackend.test.ts`'s own doc comment: `ERR_UNSUPPORTED_ESM_URL_SCHEME`,
// only `file`/`data`/`node` supported) — the real production loader creates a
// real `blob:` URL from the bytes and hands it to `importModule(blobUrl)`;
// this test-only importer ignores that blob URL argument (a real browser
// would use it) and `data:`-imports the SAME real source text instead, the
// established Node-environment substitute this repo's other loader tests use.
function realDataUriImporter(sourceText: string) {
    return async (_blobUrl: string) => import(
        /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(sourceText)}`
    ) as Promise<Readonly<{ default?: unknown } & Record<string, unknown>>>;
}

afterEach(() => {
    resetPluginUiHostRuntimeExternalsGlobalForTesting();
    delete (globalThis as Record<string, unknown>)[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY];
    vi.restoreAllMocks();
});

describe('inspector RN-web PRODUCTION artifact — real built bytes through the real web loader', () => {
    it('the built entry.mjs.bundle on disk matches the generated artifact graph digest', () => {
        const bytes = readFileSync(PRODUCTION_ARTIFACT_PATH);
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

        const graph = JSON.parse(readFileSync(PRODUCTION_ARTIFACT_GRAPH_PATH, 'utf8')) as {
            entries: readonly Readonly<{
                platform?: string;
                entry: string;
                files: readonly Readonly<{ relativePath: string; digest: string }>[];
            }>[];
        };
        const webEntry = graph.entries.find((entry) => entry.platform === 'web');
        const entryFile = webEntry?.files.find((file) => file.relativePath === webEntry.entry);
        expect(entryFile).toBeDefined();
        expect(digest).toBe(entryFile?.digest);
    });

    it('loads the real production entry.mjs.bundle bytes through createReactNativeWebLoaderBackend', async () => {
        installRealHostRuntimeExternalsForTesting();
        const sourceText = readFileSync(PRODUCTION_ARTIFACT_PATH, 'utf8');
        // The real compiled output has no bare package imports left to resolve
        // (host-runtime-externals inlines `globalThis[...]` reads instead), so
        // a plain `data:` URI `import()` of the real text is a faithful
        // substitute for the browser's `blob:` URL this loader uses in
        // production — not a shortcut around the artifact's real content.
        const importModule = realDataUriImporter(sourceText);
        const backend = createReactNativeWebLoaderBackend({ importModule });

        const renderSurface = await backend.loadInstalledBundle!({
            identity: {} as never,
            bytes: new TextEncoder().encode(sourceText),
        });

        expect(typeof renderSurface).toBe('function');
    });

    it('the real production module renders the inspector surface and drives canonical hostApi.executeAction', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        installRealHostRuntimeExternalsForTesting();
        const sourceText = readFileSync(PRODUCTION_ARTIFACT_PATH, 'utf8');
        const importModule = realDataUriImporter(sourceText);
        const backend = createReactNativeWebLoaderBackend({ importModule });
        const renderSurface = await backend.loadInstalledBundle!({
            identity: {} as never,
            bytes: new TextEncoder().encode(sourceText),
        });

        const executed: unknown[] = [];
        const element = Reflect.apply(renderSurface, undefined, [{
            plugin: { id: 'happier.inspector', version: '0.0.0' },
            // §3.2/§3.3: the canonical snapshot the host actually projects
            // (`createPluginSurfaceContext` + `projectPluginUiTheme`), not a
            // hand-built envelope. The Inspector renders entirely from
            // `surface.theme` since its private palette was deleted (UI-D12),
            // so a partial surface here would prove nothing about the real
            // mount and would only crash the real production bytes.
            surface: createPluginSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'happier.inspector', localId: 'inspector-app' },
                    container: 'rightSidebarTab',
                },
                target: { kind: 'app' },
                platform: 'web',
            }),
            signal: new AbortController().signal,
            hostApi: {
                // `version()` is a REQUIRED member of the public host API and the
                // documented way a surface negotiates method availability
                // (UI-T04), so a mount that omits it is not the public contract.
                // The tab installs no `openSurface`, which is why the surface
                // renders no page-navigation control here.
                version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: ['executeAction'] }),
                executeAction: async (action: unknown, input: unknown) => {
                    executed.push({ action, input });
                    return { ok: true, plugins: [] };
                },
                readResource: async () => {
                    throw new Error('Inspector production artifact must not read plugin resources.');
                },
            },
        }]) as React.ReactElement;

        // `renderSurface` returns a React ELEMENT wrapping the real
        // `InspectorSurface` function component — its `useEffect`-driven
        // `plugins.list` fetch only runs once an actual React renderer
        // mounts it (not merely by calling `renderSurface()`), so mount it
        // for real via `react-test-renderer`, the SAME renderer
        // `inspectorSurface.test.tsx` uses to prove the sibling source-level
        // component/state machine.
        const { act, create } = await import('react-test-renderer');
        let renderer: import('react-test-renderer').ReactTestRenderer | null = null;
        await act(async () => {
            renderer = create(element);
            await Promise.resolve();
            await Promise.resolve();
        });
        try {
            expect(executed).toEqual([{ action: 'plugins.list', input: {} }]);
            expect(consoleError.mock.calls.flat().map(String)).not.toContain(
                'Invalid style property of "direction". Did you mean "writingDirection"?',
            );
        } finally {
            act(() => {
                renderer?.unmount();
            });
        }
    });
});
