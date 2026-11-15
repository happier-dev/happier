import * as React from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import * as ReactNative from 'react-native';
import * as ReactNavigationNative from '@react-navigation/native';
import * as ReactNavigationNativeStack from '@react-navigation/native-stack';
import * as ReactNativeReanimated from 'react-native-reanimated';
import { PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULE_LOADERS } from '@happier-dev/protocol/plugins/ui/hostProvidedProtocolModuleLoaders.generated';
import * as ZodMini from 'zod/mini';

import type { PluginUiHostRuntimeExternalModulesV1 } from '@happier-dev/protocol/plugins/ui';

/**
 * The complete same-realm host ABI for executable Plugin UI bundles.
 *
 * Metro resolves `react-native` to RNW for the web target, so the two keys
 * intentionally point at the same namespace there. On native, plugin source
 * consumes `react-native`; the RNW key exists for the host-provided plugin-ui
 * family and is never a license for plugin-authored RNW imports.
 */
const hostModules = {
    react: React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react/jsx-dev-runtime': ReactJsxDevRuntime,
    'react-native': ReactNative,
    'react-native-web': ReactNative,
    '@react-navigation/native': ReactNavigationNative,
    '@react-navigation/native-stack': ReactNavigationNativeStack,
    'react-native-reanimated': ReactNativeReanimated,
    // Plugin UI, SDK and Protocol families load when an artifact first requires them: Metro keeps
    // a literal `require` inside its getter, while a namespace import would evaluate at app start.
    get '@happier-dev/plugin-ui'(): unknown { return require('@happier-dev/plugin-ui'); },
    get '@happier-dev/plugin-ui/components'(): unknown { return require('@happier-dev/plugin-ui/components'); },
    get '@happier-dev/plugin-ui/hostApi'(): unknown { return require('@happier-dev/plugin-ui/hostApi'); },
    get '@happier-dev/plugin-ui/data'(): unknown { return require('@happier-dev/plugin-ui/data'); },
    get '@happier-dev/plugin-ui/declarative'(): unknown { return require('@happier-dev/plugin-ui/declarative'); },
    get '@happier-dev/plugin-ui/environment'(): unknown { return require('@happier-dev/plugin-ui/environment'); },
    get '@happier-dev/plugin-ui/advanced'(): unknown { return require('@happier-dev/plugin-ui/advanced'); },
    get '@happier-dev/plugin-ui/ansi'(): unknown { return require('@happier-dev/plugin-ui/ansi'); },
    get '@happier-dev/plugin-sdk/machine-provisioners'(): unknown { return require('@happier-dev/plugin-sdk/machine-provisioners'); },
    get '@happier-dev/plugin-sdk/ui/client'(): unknown { return require('@happier-dev/plugin-sdk/ui/client'); },
    // Public portable SDK owners stay demand-loaded in Metro's existing realm.
    get '@happier-dev/plugin-sdk'(): unknown { return require('@happier-dev/plugin-sdk'); },
    get '@happier-dev/plugin-sdk/actions'(): unknown { return require('@happier-dev/plugin-sdk/actions'); },
    get '@happier-dev/plugin-sdk/agents'(): unknown { return require('@happier-dev/plugin-sdk/agents'); },
    get '@happier-dev/plugin-sdk/async'(): unknown { return require('@happier-dev/plugin-sdk/async'); },
    get '@happier-dev/plugin-sdk/automations'(): unknown { return require('@happier-dev/plugin-sdk/automations'); },
    get '@happier-dev/plugin-sdk/collections'(): unknown { return require('@happier-dev/plugin-sdk/collections'); },
    get '@happier-dev/plugin-sdk/connected-accounts'(): unknown { return require('@happier-dev/plugin-sdk/connected-accounts'); },
    get '@happier-dev/plugin-sdk/contributions'(): unknown { return require('@happier-dev/plugin-sdk/contributions'); },
    get '@happier-dev/plugin-sdk/errors'(): unknown { return require('@happier-dev/plugin-sdk/errors'); },
    get '@happier-dev/plugin-sdk/events'(): unknown { return require('@happier-dev/plugin-sdk/events'); },
    get '@happier-dev/plugin-sdk/manifest'(): unknown { return require('@happier-dev/plugin-sdk/manifest'); },
    get '@happier-dev/plugin-sdk/protocol'(): unknown { return require('@happier-dev/plugin-sdk/protocol'); },
    get '@happier-dev/plugin-sdk/reviews'(): unknown { return require('@happier-dev/plugin-sdk/reviews'); },
    get '@happier-dev/plugin-sdk/scm'(): unknown { return require('@happier-dev/plugin-sdk/scm'); },
    get '@happier-dev/plugin-sdk/scm/hosting'(): unknown { return require('@happier-dev/plugin-sdk/scm/hosting'); },
    get '@happier-dev/plugin-sdk/sessions'(): unknown { return require('@happier-dev/plugin-sdk/sessions'); },
    get '@happier-dev/plugin-sdk/storage'(): unknown { return require('@happier-dev/plugin-sdk/storage'); },
    get '@happier-dev/plugin-sdk/ui'(): unknown { return require('@happier-dev/plugin-sdk/ui'); },
    get '@happier-dev/plugin-sdk/webhooks'(): unknown { return require('@happier-dev/plugin-sdk/webhooks'); },
    get '@happier-dev/protocol'(): unknown { return require('@happier-dev/protocol'); },
    get zod(): unknown { return require('zod'); },
    'zod/mini': ZodMini,
    get 'zod/v4/core'(): unknown { return require('zod/v4/core'); },
    get 'zod/v4/locales/en.js'(): unknown { return require('zod/v4/locales/en.js'); },
};

// Copy descriptors, never values: object spread or `Object.assign` would run every getter at app start
// (native Babel lowers spread to `Object.assign`).
export const PLUGIN_UI_COMMON_JS_HOST_MODULES: PluginUiHostRuntimeExternalModulesV1 = Object.freeze(Object.defineProperties(
    {} as PluginUiHostRuntimeExternalModulesV1,
    {
        // Every public Protocol subpath React Native can load (generated by the Protocol export
        // generator; the compiler leaves exactly these external): the host's own instances.
        ...Object.fromEntries(Object.entries(PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULE_LOADERS)
            .map(([specifier, load]) => [specifier, { enumerable: true, get: load }])),
        ...Object.getOwnPropertyDescriptors(hostModules),
    },
));
