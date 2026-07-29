import { describe, expect, it, vi } from 'vitest';

import { resolveReactNativeWebLoaderCapability } from './reactNativeWebLoaderCapability.native';
import { resolveDefaultReactNativeLoaderBackend } from './resolveDefaultReactNativeLoaderBackend.native';

describe('native plugin loader platform boundary', () => {
    it('selects Re.Pack without probing or advertising the web-only module loader', () => {
        const resolveWebLoaderBackend = vi.fn(() => ({
            backendId: 'reactNativeWebModule',
            available: true,
            loadInstalledBundle: async () => {},
        }));

        expect(resolveDefaultReactNativeLoaderBackend().backendId)
            .toBe('repackScriptManager');
        expect(resolveReactNativeWebLoaderCapability({ resolveLoaderBackend: resolveWebLoaderBackend }))
            .toBeNull();
        expect(resolveWebLoaderBackend).not.toHaveBeenCalled();
    });
});
