import { describe, expect, it } from 'vitest';

import * as publicBuildApi from './index.js';

describe('public plugin UI build contract', () => {
    it('owns every supported plugin UI build helper', () => {
        expect(Object.keys(publicBuildApi).sort()).toEqual([
            'PLUGIN_UI_BUILD_CONFIG_BASENAMES',
            'createReactNativeRepackSharedModules',
            'createReactNativeWebVitePlugins',
            'definePluginUiBuildConfig',
            'defineReactNativeWebViteBuildPreset',
        ].sort());
    });
});
