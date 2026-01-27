import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    define: {
        __DEV__: false,
    },
    test: {
        // Ensure per-file module isolation so test-local `vi.mock(...)` does not leak
        // across unrelated test files (especially important for our React Native stubs).
        isolate: true,
        globals: false,
        environment: 'node',
        setupFiles: [resolve('./sources/dev/vitestSetup.ts')],
        include: ['sources/**/*.{spec,test}.{ts,tsx}'],
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
        // IMPORTANT: keep `@` after more specific `@/...` aliases (Vite resolves aliases in-order).
        alias: [
            // Some dependencies import React Native internals (Flow syntax) via subpaths like `react-native/Libraries/...`.
            { find: /^react-native\//, replacement: resolve('./sources/dev/reactNativeInternalStub.ts') },
            // Vitest runs in node; avoid parsing React Native's Flow entrypoint.
            { find: /^react-native$/, replacement: resolve('./sources/dev/reactNativeStub.ts') },
            // Expo packages commonly depend on `expo-modules-core`, whose exports point to TS sources that import `react-native`.
            // In node/Vitest we stub the minimal surface needed by our tests.
            { find: 'expo-modules-core', replacement: resolve('./sources/dev/expoModulesCoreStub.ts') },
            // `expo-localization` depends on Expo modules that don't exist in Vitest's node env.
            { find: 'expo-localization', replacement: resolve('./sources/dev/expoLocalizationStub.ts') },
            // `expo-router` pulls in RN internals via its native dev-server helpers.
            { find: 'expo-router', replacement: resolve('./sources/dev/expoRouterStub.ts') },
            // `react-native-gesture-handler` imports React Native internals (Flow syntax) in node.
            { find: 'react-native-gesture-handler', replacement: resolve('./sources/dev/reactNativeGestureHandlerStub.ts') },
            // `react-native-webview` depends on RN native modules and internals.
            { find: 'react-native-webview', replacement: resolve('./sources/dev/reactNativeWebviewStub.ts') },
            // `expo-clipboard` expects native modules in node/Vitest.
            { find: 'expo-clipboard', replacement: resolve('./sources/dev/expoClipboardStub.ts') },
            // `react-native-device-info` is native and pulls in RN internals.
            { find: 'react-native-device-info', replacement: resolve('./sources/dev/reactNativeDeviceInfoStub.ts') },
            // `@react-native/virtualized-lists` ships Flow sources (`import typeof`) that Node can't parse.
            { find: '@react-native/virtualized-lists', replacement: resolve('./sources/dev/reactNativeVirtualizedListsStub.ts') },
            // Use libsodium-wrappers in tests instead of the RN native binding.
            { find: '@more-tech/react-native-libsodium', replacement: 'libsodium-wrappers' },
            // Use node-safe platform adapters in tests (avoid static expo-crypto imports).
            { find: '@/platform/cryptoRandom', replacement: resolve('./sources/platform/cryptoRandom.node.ts') },
            { find: '@/platform/hmacSha512', replacement: resolve('./sources/platform/hmacSha512.node.ts') },
            { find: '@/platform/randomUUID', replacement: resolve('./sources/platform/randomUUID.node.ts') },
            { find: '@/platform/digest', replacement: resolve('./sources/platform/digest.node.ts') },
            { find: '@', replacement: resolve('./sources') },
        ],
    },
})
