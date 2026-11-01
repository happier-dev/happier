import { defineConfig } from 'vitest/config'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createTestHomeEnvironment } from '../../scripts/testing/testHomeEnvironment.mjs'

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating'
import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers'
import {
    createWorkspacePackageSourcesPlugin,
    createWorkspaceHostSourceAlias,
    readHostWorkspacePackageSpecs,
} from '../../scripts/testing/vitestWorkspacePackageResolution'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const requireUiDependency = createRequire(new URL('./package.json', import.meta.url));
// Vitest's --root does not change process.cwd(); aliases and setup belong to this package.
const resolve = (...paths: string[]) => resolvePath(packageRoot, ...paths);

// Opt-in browser gates use Metro's two Voice mic source choices without
// async vi.mock factories that self-wait through the real UI import cycle.
function resolveBrowserVoiceMicSource(id: string, importer?: string): string | null {
    if (process.env.HAPPIER_UI_TEST_VOICE_MIC_PLATFORM !== 'web') return null;
    const sourceId = id.startsWith('@/')
        ? resolve('./sources', id.slice(2))
        : id.startsWith('.') && importer
            ? resolvePath(dirname(importer.split('?')[0]!), id)
            : id;
    const extensionlessId = sourceId.split('?')[0]!.replace(/\.(?:ts|js)$/, '');
    if (extensionlessId === resolve('./sources/voice/runtime/mic/createLiveMicSession')) {
        return resolve('./sources/voice/runtime/mic/createLiveMicSession.web.ts');
    }
    if (extensionlessId === resolve('./sources/voice/runtime/mic/createRealtimeMicSession')) {
        return resolve('./sources/voice/runtime/mic/createRealtimeMicSession.web.ts');
    }
    return null;
}

function resolveExpoNodeModuleStub(id: string, importer?: string): string | null {
    if (
        id === 'react-native-reanimated' ||
        id.startsWith('react-native-reanimated/') ||
        /(?:^|[\\/])node_modules[\\/]react-native-reanimated[\\/]/.test(id) ||
        (id === './publicGlobals' && /(?:^|[\\/])node_modules[\\/]react-native-reanimated[\\/]lib[\\/]module[\\/]index\.js$/.test(importer ?? ''))
    ) {
        return resolve('./sources/dev/reactNativeReanimatedStub.ts');
    }

    if (
        id === 'react-native-keyboard-controller' ||
        id.startsWith('react-native-keyboard-controller/') ||
        /(?:^|[\\/])node_modules[\\/]react-native-keyboard-controller[\\/]/.test(id)
    ) {
        return resolve('./sources/dev/reactNativeKeyboardControllerStub.ts');
    }

    if (id === 'expo-modules-core' || /(?:^|[\\/])node_modules[\\/](?:@[^\\/]+[\\/])?expo-modules-core[\\/]src[\\/]index\.ts$/.test(id) || /expo-modules-core[\\/]src[\\/]index\.ts$/.test(id)) {
        return resolve('./sources/dev/expoModulesCoreStub.ts');
    }

    if (id === 'expo-constants' || /(?:^|[\\/])node_modules[\\/](?:@[^\\/]+[\\/])?expo-constants[\\/]src[\\/]Constants\.ts$/.test(id) || /expo-constants[\\/]src[\\/]Constants\.ts$/.test(id)) {
        return resolve('./sources/dev/expoConstantsStub.ts');
    }

    return null;
}

const workspacePackages = readHostWorkspacePackageSpecs(repoRoot, packageRoot, [
    // Composed tests exercise SDK callers that are not shipped UI dependencies.
    {
        packageName: '@happier-dev/sdk',
        packageSourceRoot: resolve('../../packages/sdk/src'),
    },
]);

const workspaceSourcesPlugin = createWorkspacePackageSourcesPlugin(
    workspacePackages,
    'happier-vitest-expo-node-module-stubs',
);

const expoNodeModuleStubsPlugin = {
    name: 'happier-vitest-expo-node-module-stubs',
    enforce: 'pre' as const,
    resolveId(id: string, importer?: string) {
        // The XML parser and its middleware stay real; only its native drawing catalog is substituted.
        if (/^\.\/xmlTags(?:\.js)?$/.test(id)
            && /[\\/]react-native-svg[\\/]lib[\\/]module[\\/]xml\.js(?:\?.*)?$/.test(importer ?? '')) {
            return resolve('./sources/dev/testkit/mocks/reactNativeSvg.ts');
        }
        return resolveBrowserVoiceMicSource(id, importer)
            ?? workspaceSourcesPlugin.resolveId(id, importer)
            ?? resolveExpoNodeModuleStub(id, importer);
    },
};

export default defineConfig({
    // Published TSX icon leaves omit React imports and use the same automatic runtime as Expo.
    esbuild: { jsx: 'automatic' },
    define: {
        __DEV__: process.env.HAPPIER_UI_TEST_DEV_BUILD !== '0',
    },
    optimizeDeps: {
            // Workspace packages (like `@happier-dev/protocol`) can change frequently during development.
            // Excluding them ensures Vitest doesn't keep using stale optimized dependency caches.
            exclude: workspacePackages.map(({ packageName }) => packageName),
    },
    test: {
        // Ensure per-file module isolation so test-local `vi.mock(...)` does not leak
        // across unrelated test files (especially important for our React Native stubs).
        isolate: true,
        // Work around intermittent Node 25 + worker-thread resolution failures seen in large suites.
        // Forks are slower but much more stable for our UI runner locally.
        pool: 'forks',
        ...resolveVitestWorkers({ legacyUiOverride: true }),
        // Our UI test suite is occasionally CPU-bound on developer machines / CI runners.
        // Increase the default timeout so unrelated load doesn't cause spurious failures.
        testTimeout: 60_000,
        // Global setup/teardown can import and reset large module graphs. Ensure hooks have
        // enough time even when running a single focused test file in isolation.
        hookTimeout: 60_000,
        globals: false,
        environment: 'node',
        server: {
            deps: {
                // React Navigation carries a nested React Native peer in this Yarn v1 layout.
                // Inline it so Vite applies the node-safe React Native alias instead of asking
                // Node to parse the peer's untransformed Flow entrypoint.
                // `@react-navigation/elements` (reached from `native-stack`, which the Plugin UI
                // same-realm host module map provides) additionally imports a `.png`
                // Node's ESM loader cannot open; inlining lets Vite resolve it as an asset.
                // `@legendapp/list/section-list` imports `react-native` directly.
                // Externalized, Node resolves that to React Native's Flow
                // entrypoint (`import typeof`) and the canonical
                // `@/components/ui/lists/virtualized` barrel cannot be imported
                // at all — which forced surfaces to mock the whole list owner
                // instead of only the third-party recycler underneath it.
                // Inlining lets Vite apply the node-safe React Native alias.
                inline: [/@react-navigation\/native/, /@react-navigation\/elements/, /@react-navigation\/bottom-tabs/, /@legendapp\/list/, /react-native-svg/],
            },
        },
        env: {
            ...createTestHomeEnvironment().env,
            HAPPIER_FEATURE_POLICY_ENV: '',
            NODE_ENV: 'test',
            VITEST_UI_SOURCES_DIR: resolve('./sources'),
        },
        setupFiles: [resolve('../../scripts/testing/vitestHomeSetup.mjs'), resolve('./sources/dev/vitestSetup.ts')],
        sequence: { setupFiles: 'list' },
        include: [
            'sources/**/*.{spec,test}.{ts,tsx}',
            'tools/**/*.{spec,test}.{ts,tsx}',
        ],
        exclude: [
            'sources/**/*.integration.test.{ts,tsx}',
            'sources/**/*.real.integration.test.{ts,tsx}',
            'sources/**/*.integration.spec.{ts,tsx}',
            'sources/**/*.e2e.test.{ts,tsx}',
            ...resolveVitestFeatureTestExcludeGlobs(),
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/**',
                'dist/**',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mockData/**',
            ],
        },
    },
    resolve: {
        // Inlined React Navigation otherwise resolves its own Yarn v1 peer copy of React,
        // which produces an invalid-hook-call split brain with react-test-renderer.
        dedupe: ['react', 'react-dom'],
        // IMPORTANT: keep `@` after more specific `@/...` aliases (Vite resolves aliases in-order).
        alias: [
            // Unit tests exercise authored artifact logic without an app's published byte inventory.
            // The artifact-cache config retains the generated inventory and its preparation contract.
            {
                find: /^(?:\.\/|.*[\\/]sync[\\/]domains[\\/]plugins[\\/]availability[\\/])generatedBundledPluginUiArtifacts(?:\.js)?$/,
                replacement: resolve('./sources/dev/testkit/mocks/bundledPluginUiAssets.ts'),
            },
            // Reanimated's package exports can resolve to ESM internals with extensionless relative imports.
            // Route all Vitest imports to the node-safe stub before Vite/Node load those internals.
            { find: /^react-native-reanimated(?:\/.*)?$/, replacement: resolve('./sources/dev/reactNativeReanimatedStub.ts') },
            { find: /(?:^|[\\/])node_modules[\\/]react-native-reanimated[\\/].*$/, replacement: resolve('./sources/dev/reactNativeReanimatedStub.ts') },
            // Keyboard controller imports Reanimated internals from its implementation package.
            { find: /^react-native-keyboard-controller(?:\/.*)?$/, replacement: resolve('./sources/dev/reactNativeKeyboardControllerStub.ts') },
            { find: /(?:^|[\\/])node_modules[\\/]react-native-keyboard-controller[\\/].*$/, replacement: resolve('./sources/dev/reactNativeKeyboardControllerStub.ts') },
            // masked-view publishes Flow-typed JSX in a `.js` file, which Vite's import analysis
            // cannot parse — importing it anywhere fails the module graph before any assertion runs.
            { find: /^@react-native-masked-view\/masked-view(?:\/.*)?$/, replacement: resolve('./sources/dev/reactNativeMaskedViewStub.tsx') },
            { find: /(?:^|[\\/])node_modules[\\/]@react-native-masked-view[\\/]masked-view[\\/].*$/, replacement: resolve('./sources/dev/reactNativeMaskedViewStub.tsx') },
            // Some dependencies import React Native internals (Flow syntax) via subpaths like `react-native/Libraries/...`.
            { find: /^react-native\//, replacement: resolve('./sources/dev/reactNativeInternalStub.ts') },
            // Vitest runs in node; avoid parsing React Native's Flow entrypoint.
            { find: /^react-native$/, replacement: resolve('./sources/dev/reactNativeStub.ts') },
            { find: /^expo-file-system$/, replacement: resolve('./sources/dev/testkit/mocks/expoFileSystemModule.ts') },
            // Plugin UI's nested SVG peer must reach the same native drawing boundary as UI leaves.
            // Keep the XML parser real: safe native previews validate its AST before drawing.
            { find: /^react-native-svg\/lib\/commonjs\/xml$/, replacement: requireUiDependency.resolve('react-native-svg/lib/module/xml.js') },
            { find: /^react-native-svg$/, replacement: resolve('./sources/dev/testkit/mocks/reactNativeSvg.ts') },
            { find: /^(?:.*[\\/])?node_modules[\\/]react-native-svg[\\/](?!lib[\\/]module[\\/](?:xml\.js|utils[\\/]fetchData\.js)$).*$/, replacement: resolve('./sources/dev/testkit/mocks/reactNativeSvg.ts') },
            { find: '@livekit/react-native-webrtc', replacement: resolve('./sources/dev/reactNativeWebRtcStub.ts') },
            // `react-native-safe-area-context` imports native modules that don't exist in node/Vitest.
            { find: 'react-native-safe-area-context', replacement: resolve('./sources/dev/reactNativeSafeAreaContextStub.ts') },
            // Expo packages commonly depend on `expo-modules-core`, whose exports point to TS sources that import `react-native`.
            // In node/Vitest we stub the minimal surface needed by our tests.
            { find: /expo-modules-core\/src\/index\.ts$/, replacement: resolve('./sources/dev/expoModulesCoreStub.ts') },
            { find: /^expo-modules-core(?:\/.*)?$/, replacement: resolve('./sources/dev/expoModulesCoreStub.ts') },
            // `expo-constants` uses conditional exports that Vite/Vitest can't always resolve cleanly under node.
            { find: 'expo-constants', replacement: resolve('./sources/dev/expoConstantsStub.ts') },
            // `expo-localization` depends on Expo modules that don't exist in Vitest's node env.
            { find: 'expo-localization', replacement: resolve('./sources/dev/expoLocalizationStub.ts') },
            // `expo-video` uses native/web view modules that Vitest cannot parse under Node.
            { find: 'expo-video', replacement: resolve('./sources/dev/expoVideoStub.ts') },
            { find: 'expo-router/drawer', replacement: resolve('./sources/dev/expoRouterDrawerStub.ts') },
            // Expo's Route-node SDK publishes JSX in .js; mounted native scenes
            // supply their local module identity through this platform boundary.
            { find: /^expo-router\/build\/Route(?:\.js)?$/, replacement: resolve('./sources/dev/expoRouterRouteStub.ts') },
            // `expo-router` pulls in RN internals via its native dev-server helpers.
            { find: /^expo-router$/, replacement: resolve('./sources/dev/expoRouterStub.ts') },
            // `react-native-gesture-handler` imports React Native internals (Flow syntax) in node.
            { find: 'react-native-gesture-handler', replacement: resolve('./sources/dev/reactNativeGestureHandlerStub.ts') },
            // `react-native-webview` depends on RN native modules and internals.
            { find: /^react-native-webview$/, replacement: resolve('./sources/dev/reactNativeWebviewStub.ts') },
            // Some dependencies accidentally pull in `expo` (which expects bundler-only runtime modules).
            { find: /^expo$/, replacement: resolve('./sources/dev/expoStub.ts') },
            // `expo-notifications` executes side-effectful native registration at import time.
            { find: /^expo-notifications$/, replacement: resolve('./sources/dev/expoNotificationsStub.ts') },
            // `expo-task-manager` is native runtime plumbing for background notification tasks.
            { find: /^expo-task-manager$/, replacement: resolve('./sources/dev/expoTaskManagerStub.ts') },
            // `expo-audio` is native and throws in node/Vitest.
            { find: 'expo-audio', replacement: resolve('./sources/dev/expoAudioStub.ts') },
            // `expo-speech` and `expo-speech-recognition` are not reliably node-safe (and are hard to mock
            // via dynamic import paths). Route them to lightweight test stubs.
            { find: 'expo-speech', replacement: resolve('./sources/dev/expoSpeechStub.ts') },
            { find: 'expo-speech-recognition', replacement: resolve('./sources/dev/expoSpeechRecognitionStub.ts') },
            // `expo-clipboard` expects native modules in node/Vitest.
            { find: 'expo-clipboard', replacement: resolve('./sources/dev/expoClipboardStub.ts') },
            // `expo-linear-gradient` ships JSX in its build output; stub it in node/Vitest.
            { find: 'expo-linear-gradient', replacement: resolve('./sources/dev/expoLinearGradientStub.ts') },
            // `expo-camera` ships code that Vitest's node runtime can fail to parse; stub it for deterministic route tests.
            { find: 'expo-camera', replacement: resolve('./sources/dev/expoCameraStub.ts') },
            // `react-native-device-info` is native and pulls in RN internals.
            { find: 'react-native-device-info', replacement: resolve('./sources/dev/reactNativeDeviceInfoStub.ts') },
            // Sentry's React Native SDK depends on native modules; stub it in node/Vitest.
            { find: '@sentry/react-native', replacement: resolve('./sources/dev/sentryReactNativeStub.ts') },
            // `@react-native/virtualized-lists` ships Flow sources (`import typeof`) that Node can't parse.
            { find: /^@react-native\/virtualized-lists(\/.*)?$/, replacement: resolve('./sources/dev/reactNativeVirtualizedListsStub.ts') },
            // Some deps import the abort-controller polyfill, which uses extensionless ESM imports that Node can't resolve.
            { find: /^abort-controller\/polyfill$/, replacement: resolve('./sources/dev/abortControllerPolyfillStub.ts') },
            { find: /^abort-controller\/polyfill\.mjs$/, replacement: resolve('./sources/dev/abortControllerPolyfillStub.ts') },
            // `@expo/vector-icons` and icon-set subpaths can resolve through React Native Flow/JSX sources in node.
            { find: /^@expo\/vector-icons(?:\/.*)?$/, replacement: resolve('./sources/dev/expoVectorIconsStub.ts') },
            // `rn-encryption` selects a native implementation in node tests and can pull in React Native's Flow sources.
            { find: 'rn-encryption', replacement: resolve('./sources/dev/rnEncryptionStub.ts') },
            // RevenueCat native SDKs depend on RN native modules.
            { find: 'react-native-purchases', replacement: resolve('./sources/dev/reactNativePurchasesStub.ts') },
            { find: 'react-native-purchases-ui', replacement: resolve('./sources/dev/reactNativePurchasesUiStub.ts') },
            { find: 'react-native-mmkv', replacement: resolve('./sources/dev/reactNativeMmkvStub.ts') },
            // Mock the public native view only; package subpaths exercise real patched logic.
            { find: /^react-native-enriched-markdown$/, replacement: resolve('./sources/dev/reactNativeEnrichedMarkdownStub.tsx') },
            // PostHog React Native eagerly loads optional Expo native packages in node. Keep route/unit tests node-safe.
            { find: 'posthog-react-native', replacement: resolve('./sources/dev/posthogReactNativeStub.tsx') },
            // Use libsodium-wrappers in tests instead of the RN native binding.
            { find: '@more-tech/react-native-libsodium', replacement: 'libsodium-wrappers' },
            // Use node-safe platform adapters in tests (avoid static expo-crypto imports).
            { find: '@/platform/cryptoRandom', replacement: resolve('./sources/platform/cryptoRandom.node.ts') },
            { find: '@/platform/hmacSha512', replacement: resolve('./sources/platform/hmacSha512.node.ts') },
            { find: '@/platform/randomUUID', replacement: resolve('./sources/platform/randomUUID.node.ts') },
            { find: '@/platform/digest', replacement: resolve('./sources/platform/digest.node.ts') },
            // `CodeEditor.tsx` picks its platform surface with a runtime `Platform.OS`
            // `require('./CodeEditor.native')`. Vite-node injects `createRequire`, so that
            // call is Node's CJS loader: it cannot resolve a `.tsx` file, and even when it
            // can it loads the target outside the Vitest module graph — which is exactly what
            // `sources/dev/vitestRnShim.ts` refuses. Every consumer graph that merely reaches
            // the editor therefore failed to collect, and surfaces worked around it with a
            // local `vi.mock` of an internal owner. Resolve the real web surface for the base
            // specifier instead: the unsupported require never runs, and the implementation
            // loads through the module graph with this run's aliases and stubs applied.
            // `MonacoEditorSurface.web.tsx` guards on `window`/`document`, so it is node-safe.
            // The concrete surfaces keep their own coverage in
            // `sources/components/ui/code/editor/surfaces/*.test.tsx`, which import them directly.
            {
                find: /^@\/components\/ui\/code\/editor\/CodeEditor$/,
                replacement: resolve('./sources/components/ui/code/editor/CodeEditor.web.tsx'),
            },
            createWorkspaceHostSourceAlias(repoRoot, resolve('./sources')),
        ],
    },
    plugins: [expoNodeModuleStubsPlugin],
})
