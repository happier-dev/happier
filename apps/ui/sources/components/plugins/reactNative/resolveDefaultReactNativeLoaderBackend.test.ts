import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repackClientState = vi.hoisted(() => ({
    client: null as unknown,
}));

vi.mock('./nativeRepackClientResolver', () => ({
    resolveDefaultNativeRepackClient: () => repackClientState.client,
}));

import { resolveDefaultReactNativeLoaderBackend as resolveNativeLoaderBackend } from './resolveDefaultReactNativeLoaderBackend.native';
import { resolveDefaultReactNativeLoaderBackend as resolveWebLoaderBackend } from './resolveDefaultReactNativeLoaderBackend.web';
import {
    resetPluginReactNativeScriptManagerBootForTests,
} from './scriptManagerBoot';

type RepackGlobals = {
    __repack__?: unknown;
    __webpack_require__?: unknown;
    __webpack_share_scopes__?: unknown;
    __webpack_init_sharing__?: unknown;
};

const repackGlobals = globalThis as unknown as RepackGlobals;

describe('resolveDefaultReactNativeLoaderBackend', () => {
    beforeEach(() => {
        repackClientState.client = null;
        resetPluginReactNativeScriptManagerBootForTests();
    });

    afterEach(() => {
        delete repackGlobals.__repack__;
        delete repackGlobals.__webpack_require__;
        delete repackGlobals.__webpack_share_scopes__;
        delete repackGlobals.__webpack_init_sharing__;
    });

    it('selects the web module backend on web (LEDGER DEC-6 — reactNative mode also renders on web)', () => {
        const backend = resolveWebLoaderBackend();
        expect(backend.backendId).toBe('reactNativeWebModule');
    });

    it('selects the Re.Pack ScriptManager backend on ios/android (unchanged native behavior)', () => {
        expect(resolveNativeLoaderBackend().backendId).toBe('repackScriptManager');
    });

    it('falls closed to the Re.Pack backend (native-only, package-missing) for any other/unknown platform', () => {
        const backend = resolveNativeLoaderBackend();
        expect(backend.backendId).toBe('repackScriptManager');
        expect(backend.available).toBe(false);
    });

    it('initializes Re.Pack before advertising the native backend as available', () => {
        class ScriptManager {
            static shared: unknown;

            static init(): void {
                ScriptManager.shared = {
                    addResolver: () => undefined,
                    removeResolver: () => undefined,
                    loadScript: () => undefined,
                };
            }
        }
        repackClientState.client = {
            ScriptManager,
            Federated: {
                importModule: () => undefined,
            },
        };

        expect(resolveNativeLoaderBackend()).toMatchObject({
            backendId: 'repackScriptManager',
            available: true,
        });
    });
});
