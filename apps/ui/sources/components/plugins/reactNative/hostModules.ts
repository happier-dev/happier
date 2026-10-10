import * as React from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import * as ReactNative from 'react-native';
import * as ReactNavigationNative from '@react-navigation/native';
import * as ReactNavigationNativeStack from '@react-navigation/native-stack';
import * as ReactNativeReanimated from 'react-native-reanimated';
import * as PluginUi from '@happier-dev/plugin-ui';
import * as PluginUiComponents from '@happier-dev/plugin-ui/components';
import * as PluginUiHostApi from '@happier-dev/plugin-ui/hostApi';
import * as PluginUiData from '@happier-dev/plugin-ui/data';
import * as PluginUiPresentation from '@happier-dev/plugin-ui/presentation';
import * as PluginUiDeclarative from '@happier-dev/plugin-ui/declarative';
import * as PluginUiEnvironment from '@happier-dev/plugin-ui/environment';
import * as PluginUiAdvanced from '@happier-dev/plugin-ui/advanced';
import * as PluginUiClient from '@happier-dev/plugin-sdk/ui/client';

import type { PluginUiHostRuntimeExternalModulesV1 } from '@happier-dev/protocol/plugins/ui';

/**
 * The complete same-realm host ABI for executable Plugin UI bundles.
 *
 * Metro resolves `react-native` to RNW for the web target, so the two keys
 * intentionally point at the same namespace there. On native, plugin source
 * consumes `react-native`; the RNW key exists for the host-provided plugin-ui
 * family and is never a license for plugin-authored RNW imports.
 */
export const PLUGIN_UI_COMMON_JS_HOST_MODULES: PluginUiHostRuntimeExternalModulesV1 = Object.freeze({
    react: React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react/jsx-dev-runtime': ReactJsxDevRuntime,
    'react-native': ReactNative,
    'react-native-web': ReactNative,
    '@react-navigation/native': ReactNavigationNative,
    '@react-navigation/native-stack': ReactNavigationNativeStack,
    'react-native-reanimated': ReactNativeReanimated,
    '@happier-dev/plugin-ui': PluginUi,
    '@happier-dev/plugin-ui/components': PluginUiComponents,
    '@happier-dev/plugin-ui/hostApi': PluginUiHostApi,
    '@happier-dev/plugin-ui/data': PluginUiData,
    '@happier-dev/plugin-ui/presentation': PluginUiPresentation,
    '@happier-dev/plugin-ui/declarative': PluginUiDeclarative,
    '@happier-dev/plugin-ui/environment': PluginUiEnvironment,
    '@happier-dev/plugin-ui/advanced': PluginUiAdvanced,
    '@happier-dev/plugin-sdk/ui/client': PluginUiClient,
});
