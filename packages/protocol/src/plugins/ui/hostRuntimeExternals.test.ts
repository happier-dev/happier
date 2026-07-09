import { describe, expect, it } from 'vitest';

import {
    PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
    PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY,
    isPluginUiHostRuntimeExternalGlobalInstalled,
} from './hostRuntimeExternals.js';

describe('plugin UI host runtime externals', () => {
    it('declares the canonical global key and specifier list once', () => {
        expect(PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY).toBe('__happierPluginHostRuntime__');
        expect(PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS).toEqual([
            'react',
            'react-native-web',
            '@happier-dev/plugin-sdk/ui/hostApiClient',
        ]);
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
                'react-native-web': {},
                '@happier-dev/plugin-sdk/ui/hostApiClient': {},
            },
        })).toBe(true);
    });
});
