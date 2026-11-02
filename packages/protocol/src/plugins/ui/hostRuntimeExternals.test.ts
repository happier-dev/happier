import { describe, expect, it } from 'vitest';

import * as hostRuntimeExternals from './hostRuntimeExternals.js';

describe('plugin UI host runtime externals', () => {
    it('does not publish predecessor global-install or native-subset contracts', () => {
        expect(hostRuntimeExternals).not.toHaveProperty('PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY');
        expect(hostRuntimeExternals).not.toHaveProperty('PLUGIN_UI_HOST_REACT_RUNTIME_EXTERNAL_SPECIFIERS');
        expect(hostRuntimeExternals).not.toHaveProperty('PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS');
        expect(hostRuntimeExternals).not.toHaveProperty('isPluginUiHostRuntimeExternalGlobalInstalled');
    });
});
