import { describe, expect, it } from 'vitest';

import {
    PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS,
    PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS,
    PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
    PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY,
    isPluginUiHostRuntimeExternalGlobalInstalled,
} from './hostRuntimeExternals.js';

describe('plugin UI host runtime externals', () => {
    it('declares the canonical global key and specifier list once', () => {
        expect(PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY).toBe('__happierPluginHostRuntime__');
        expect(PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS).toEqual([
            'react',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
        ]);
        expect(PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS).toEqual([
            'react',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            'react-native-web',
            '@happier-dev/plugin-sdk/ui/client',
        ]);
    });

    it('declares the native host-provided singleton closure once, sharing the React runtime head', () => {
        expect(PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS).toEqual([
            'react',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            'react-native',
            'react-native-reanimated',
            '@react-navigation/native',
            '@react-navigation/native-stack',
        ]);
        // The web closure is `react-native-web` + the SDK client; the native
        // closure is `react-native` + animation/navigation. They must not
        // collapse into one list — a web artifact externalizing
        // `@react-navigation/native-stack` has no provider.
        expect(PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS)
            .not.toContain('react-native-web');
        expect(PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS)
            .not.toContain('@react-navigation/native-stack');
        for (const specifier of PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS) {
            expect(PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS).toContain(specifier);
        }
    });

    it('reports not-installed when the global is missing or partial', () => {
        expect(isPluginUiHostRuntimeExternalGlobalInstalled({})).toBe(false);
        expect(isPluginUiHostRuntimeExternalGlobalInstalled({
            [PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY]: { react: {} },
        })).toBe(false);
    });

    it('reports installed once every externalized specifier has a value', () => {
        expect(isPluginUiHostRuntimeExternalGlobalInstalled({
            [PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY]: {
                react: {},
                'react/jsx-runtime': {},
                'react/jsx-dev-runtime': {},
                'react-native-web': {},
                '@happier-dev/plugin-sdk/ui/client': {},
            },
        })).toBe(true);
    });
});
