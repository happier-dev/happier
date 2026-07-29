import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const uiSources = resolve(__dirname, '../../../apps/ui/sources');
const uiDev = (path: string): string => resolve(uiSources, 'dev', path);

export default defineConfig({
  define: {
    __DEV__: false,
  },
  test: {
    environment: 'node',
    hookTimeout: 60_000,
    setupFiles: [uiDev('vitestSetup.ts')],
  },
  resolve: {
    alias: [
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
      { find: 'rn-encryption', replacement: uiDev('rnEncryptionStub.ts') },
      { find: 'react-native-purchases', replacement: uiDev('reactNativePurchasesStub.ts') },
      { find: 'react-native-purchases-ui', replacement: uiDev('reactNativePurchasesUiStub.ts') },
      { find: 'react-native-mmkv', replacement: uiDev('reactNativeMmkvStub.ts') },
      { find: 'react-native-enriched-markdown', replacement: uiDev('reactNativeEnrichedMarkdownStub.tsx') },
      { find: 'posthog-react-native', replacement: uiDev('posthogReactNativeStub.tsx') },
      { find: '@more-tech/react-native-libsodium', replacement: 'libsodium-wrappers' },
      { find: '@/platform/cryptoRandom', replacement: resolve(uiSources, 'platform/cryptoRandom.node.ts') },
      { find: '@/platform/hmacSha512', replacement: resolve(uiSources, 'platform/hmacSha512.node.ts') },
      { find: '@/platform/randomUUID', replacement: resolve(uiSources, 'platform/randomUUID.node.ts') },
      { find: '@/platform/digest', replacement: resolve(uiSources, 'platform/digest.node.ts') },
      { find: '@', replacement: uiSources },
    ],
  },
});
