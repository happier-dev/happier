import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution.ts';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [createWorkspacePackageSourcesPlugin([
        {
            packageName: '@happier-dev/protocol',
            packageSourceRoot: resolve(here, '../../packages/protocol/src'),
        },
    ], 'happier-ui-artifact-cache-workspace-package-sources')],
    define: {
        __DEV__: true,
    },
    test: {
        environment: 'node',
        server: {
            deps: {
                inline: [/@react-navigation\/native/, /@react-navigation\/elements/],
            },
        },
        include: [
            'sources/components/plugins/reactNative/bundleCache.test.ts',
            'sources/components/plugins/reactNative/artifactFileMaterializer.test.ts',
            'sources/sync/domains/plugins/ui/artifactByteCache.browser.test.ts',
        ],
        pool: 'forks',
        setupFiles: ['sources/dev/artifactCacheVitestSetup.ts'],
    },
    resolve: {
        alias: [
            { find: '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', replacement: resolve('./sources/dev/artifactCacheGuardedMachineRpcStub.ts') },
            { find: /^react-native-reanimated(?:\/.*)?$/, replacement: resolve('./sources/dev/reactNativeReanimatedStub.ts') },
            { find: /(?:^|[\\/])node_modules[\\/]react-native-reanimated[\\/].*$/, replacement: resolve('./sources/dev/reactNativeReanimatedStub.ts') },
            { find: /^react-native-keyboard-controller(?:\/.*)?$/, replacement: resolve('./sources/dev/reactNativeKeyboardControllerStub.ts') },
            { find: /(?:^|[\\/])node_modules[\\/]react-native-keyboard-controller[\\/].*$/, replacement: resolve('./sources/dev/reactNativeKeyboardControllerStub.ts') },
            { find: /^@react-native\/virtualized-lists(\/.*)?$/, replacement: resolve('./sources/dev/reactNativeVirtualizedListsStub.ts') },
            { find: 'react-native-safe-area-context', replacement: resolve('./sources/dev/reactNativeSafeAreaContextStub.ts') },
            { find: /^react-native$/, replacement: resolve('./sources/dev/reactNativeStub.ts') },
            { find: /^react-native\//, replacement: resolve('./sources/dev/reactNativeInternalStub.ts') },
            { find: /^expo-modules-core(?:\/.*)?$/, replacement: resolve('./sources/dev/expoModulesCoreStub.ts') },
            { find: '@', replacement: resolve('./sources') },
        ],
    },
});
