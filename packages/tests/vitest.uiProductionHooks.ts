import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import type { Plugin, UserConfig } from 'vitest/config';

import {
  createWorkspacePackageSourcesPlugin,
  readHostWorkspacePackageSpecs,
} from '../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
const uiRoot = resolve(repoRoot, 'apps/ui');
const requireUiDependency = createRequire(resolve(uiRoot, 'package.json'));
const uiSourcesRoot = resolve(uiRoot, 'sources');
const cliSourcesRoot = resolve(repoRoot, 'apps/cli/src');
const serverSourcesRoot = resolve(repoRoot, 'apps/server/sources');

function uiSource(path: string): string {
  return resolve(uiSourcesRoot, path);
}

function uiDev(path: string): string {
  return uiSource(`dev/${path}`);
}

function stripQueryAndHash(value: string): string {
  return value.replace(/[?#].*$/, '');
}

function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
  const normalizedFilePath = stripQueryAndHash(filePath);
  const relativePath = relative(directoryPath, normalizedFilePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function resolveSourceFile(root: string, subpath: string): string {
  const requested = resolve(root, subpath);
  const candidates = [
    requested,
    `${requested}.ts`,
    `${requested}.tsx`,
    `${requested}.js`,
    `${requested}.jsx`,
    resolve(requested, 'index.ts'),
    resolve(requested, 'index.tsx'),
    resolve(requested, 'index.js'),
    resolve(requested, 'index.jsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? requested;
}

function resolveAppSourceRoot(importer?: string): string {
  const cleanImporter = importer ? stripQueryAndHash(importer) : '';
  if (cleanImporter && isPathInsideDirectory(cleanImporter, cliSourcesRoot)) {
    return cliSourcesRoot;
  }
  if (cleanImporter && isPathInsideDirectory(cleanImporter, serverSourcesRoot)) {
    return serverSourcesRoot;
  }
  return uiSourcesRoot;
}

function resolveExpoNodeModuleStub(id: string, importer?: string): string | null {
  if (
    id === 'react-native-reanimated'
    || id.startsWith('react-native-reanimated/')
    || /(?:^|[\\/])node_modules[\\/]react-native-reanimated[\\/]/.test(id)
    || (id === './publicGlobals' && /(?:^|[\\/])node_modules[\\/]react-native-reanimated[\\/]lib[\\/]module[\\/]index\.js$/.test(importer ?? ''))
  ) {
    return uiDev('reactNativeReanimatedStub.ts');
  }

  if (
    id === 'react-native-keyboard-controller'
    || id.startsWith('react-native-keyboard-controller/')
    || /(?:^|[\\/])node_modules[\\/]react-native-keyboard-controller[\\/]/.test(id)
  ) {
    return uiDev('reactNativeKeyboardControllerStub.ts');
  }

  if (
    id === 'expo-modules-core'
    || /(?:^|[\\/])node_modules[\\/](?:@[^\\/]+[\\/])?expo-modules-core[\\/]src[\\/]index\.ts$/.test(id)
    || /expo-modules-core[\\/]src[\\/]index\.ts$/.test(id)
  ) {
    return uiDev('expoModulesCoreStub.ts');
  }

  if (
    id === 'expo-constants'
    || /(?:^|[\\/])node_modules[\\/](?:@[^\\/]+[\\/])?expo-constants[\\/]src[\\/]Constants\.ts$/.test(id)
    || /expo-constants[\\/]src[\\/]Constants\.ts$/.test(id)
  ) {
    return uiDev('expoConstantsStub.ts');
  }

  return null;
}

const workspacePackages = readHostWorkspacePackageSpecs(repoRoot, resolve(repoRoot, 'apps/cli'), [
  ...readHostWorkspacePackageSpecs(repoRoot, resolve(repoRoot, 'apps/server')),
  ...readHostWorkspacePackageSpecs(repoRoot, uiRoot),
  { packageName: 'privacy-kit', packageSourceRoot: resolve(repoRoot, 'packages/privacy-kit/src') },
]);

const workspaceSourcesPlugin = createWorkspacePackageSourcesPlugin(
  workspacePackages,
  'happier-tests-workspace-package-sources',
);

const appSourceAliasesPlugin: Plugin = {
  name: 'happier-tests-app-source-aliases',
  enforce: 'pre',
  resolveId(id, importer) {
    if (id === 'privacy-kit') return resolve(repoRoot, 'packages/privacy-kit/src/index.ts');
    // SDK source consumers use the same Node exchange as its package import map.
    if (id === '#http' && importer && isPathInsideDirectory(importer, resolve(repoRoot, 'packages/sdk/src'))) {
      return resolve(repoRoot, 'packages/sdk/src/http/undiciHttp.ts');
    }
    if (id === '@happier-tests/ui-machine-carrier') {
      return uiSource('dev/testkit/machineCarrierHttpIntegrationTestkit.ts');
    }
    if (id === '@happier-tests/server-machine-carrier-grant') {
      return resolve(serverSourcesRoot, 'app/api/testkit/machineCarrierGrantIntegrationTestkit.ts');
    }
    if (id === '@/platform/cryptoRandom') return uiSource('platform/cryptoRandom.node.ts');
    if (id === '@/platform/hmacSha512') return uiSource('platform/hmacSha512.node.ts');
    if (id === '@/platform/randomUUID') return uiSource('platform/randomUUID.node.ts');
    if (id === '@/platform/digest') return uiSource('platform/digest.node.ts');
    if (!id.startsWith('@/')) return null;

    return resolveSourceFile(resolveAppSourceRoot(importer), id.slice(2));
  },
};

const expoNodeModuleStubsPlugin: Plugin = {
  name: 'happier-tests-expo-node-module-stubs',
  enforce: 'pre',
  resolveId(id, importer) {
    return workspaceSourcesPlugin.resolveId(id, importer)
      ?? resolveExpoNodeModuleStub(id, importer);
  },
};

export function createUiProductionHooksVitestConfig(): UserConfig {
  return {
    define: {
      __DEV__: true,
    },
    optimizeDeps: {
      exclude: workspacePackages.map(({ packageName }) => packageName),
    },
    test: {
      setupFiles: [uiDev('vitestSetup.ts')],
      server: {
        deps: {
          // Production UI modules can reach React Navigation and Legend's React Native
          // entrypoints. Inline them so the node-safe aliases above see their Flow sources.
          inline: [/@react-navigation\/native/, /@react-navigation\/elements/, /@legendapp\/list/],
        },
      },
      env: {
        HAPPIER_FEATURE_POLICY_ENV: '',
        NODE_ENV: 'test',
      },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: [
        {
          find: /^react(\/.*)?$/,
          replacement: `${dirname(requireUiDependency.resolve('react/package.json'))}$1`,
        },
        {
          find: /^react-dom(\/.*)?$/,
          replacement: `${dirname(requireUiDependency.resolve('react-dom/package.json'))}$1`,
        },
        {
          find: /^react-test-renderer$/,
          replacement: requireUiDependency.resolve('react-test-renderer'),
        },
        { find: /^react-native-reanimated(?:\/.*)?$/, replacement: uiDev('reactNativeReanimatedStub.ts') },
        { find: /(?:^|[\\/])node_modules[\\/]react-native-reanimated[\\/].*$/, replacement: uiDev('reactNativeReanimatedStub.ts') },
        { find: /^react-native-keyboard-controller(?:\/.*)?$/, replacement: uiDev('reactNativeKeyboardControllerStub.ts') },
        { find: /(?:^|[\\/])node_modules[\\/]react-native-keyboard-controller[\\/].*$/, replacement: uiDev('reactNativeKeyboardControllerStub.ts') },
        { find: /^react-native\//, replacement: uiDev('reactNativeInternalStub.ts') },
        { find: /^react-native$/, replacement: uiDev('reactNativeStub.ts') },
        { find: 'react-native-safe-area-context', replacement: uiDev('reactNativeSafeAreaContextStub.ts') },
        { find: /expo-modules-core\/src\/index\.ts$/, replacement: uiDev('expoModulesCoreStub.ts') },
        { find: /^expo-modules-core(?:\/.*)?$/, replacement: uiDev('expoModulesCoreStub.ts') },
        { find: 'expo-constants', replacement: uiDev('expoConstantsStub.ts') },
        { find: 'expo-localization', replacement: uiDev('expoLocalizationStub.ts') },
        { find: 'expo-video', replacement: uiDev('expoVideoStub.ts') },
        { find: 'expo-router/drawer', replacement: uiDev('expoRouterDrawerStub.ts') },
        { find: 'expo-router', replacement: uiDev('expoRouterStub.ts') },
        { find: 'react-native-gesture-handler', replacement: uiDev('reactNativeGestureHandlerStub.ts') },
        { find: 'react-native-webview', replacement: uiDev('reactNativeWebviewStub.ts') },
        { find: /^expo$/, replacement: uiDev('expoStub.ts') },
        { find: 'expo-notifications', replacement: uiDev('expoNotificationsStub.ts') },
        { find: 'expo-task-manager', replacement: uiDev('expoTaskManagerStub.ts') },
        { find: 'expo-audio', replacement: uiDev('expoAudioStub.ts') },
        { find: 'expo-speech', replacement: uiDev('expoSpeechStub.ts') },
        { find: 'expo-speech-recognition', replacement: uiDev('expoSpeechRecognitionStub.ts') },
        { find: 'expo-clipboard', replacement: uiDev('expoClipboardStub.ts') },
        { find: 'expo-linear-gradient', replacement: uiDev('expoLinearGradientStub.ts') },
        { find: 'expo-camera', replacement: uiDev('expoCameraStub.ts') },
        { find: 'react-native-device-info', replacement: uiDev('reactNativeDeviceInfoStub.ts') },
        { find: '@sentry/react-native', replacement: uiDev('sentryReactNativeStub.ts') },
        { find: /^@react-native\/virtualized-lists(\/.*)?$/, replacement: uiDev('reactNativeVirtualizedListsStub.ts') },
        { find: /^abort-controller\/polyfill$/, replacement: uiDev('abortControllerPolyfillStub.ts') },
        { find: /^abort-controller\/polyfill\.mjs$/, replacement: uiDev('abortControllerPolyfillStub.ts') },
        { find: /^@expo\/vector-icons(?:\/.*)?$/, replacement: uiDev('expoVectorIconsStub.ts') },
        { find: 'rn-encryption', replacement: uiDev('rnEncryptionStub.ts') },
        { find: 'react-native-purchases', replacement: uiDev('reactNativePurchasesStub.ts') },
        { find: 'react-native-purchases-ui', replacement: uiDev('reactNativePurchasesUiStub.ts') },
        { find: 'react-native-mmkv', replacement: uiDev('reactNativeMmkvStub.ts') },
        {
          find: 'react-native-enriched-markdown/lib/module/web/streamingReveal.js',
          replacement: requireUiDependency.resolve('react-native-enriched-markdown/lib/module/web/streamingReveal.js'),
        },
        { find: 'react-native-enriched-markdown', replacement: uiDev('reactNativeEnrichedMarkdownStub.tsx') },
        { find: 'posthog-react-native', replacement: uiDev('posthogReactNativeStub.tsx') },
        { find: '@more-tech/react-native-libsodium', replacement: 'libsodium-wrappers' },
      ],
    },
    plugins: [appSourceAliasesPlugin, expoNodeModuleStubsPlugin],
  };
}
