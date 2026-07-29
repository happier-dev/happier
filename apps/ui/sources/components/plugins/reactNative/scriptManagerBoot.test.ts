import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPluginReactNativeModuleFederationHostSharedScopeForTesting } from './moduleFederationHostSharedScope';
import {
    initializePluginReactNativeScriptManagerOnce,
    resetPluginReactNativeScriptManagerBootForTests,
} from './scriptManagerBoot';

type RepackGlobals = {
    __repack__?: { shared?: { scriptManager: unknown; enqueuedResolvers: unknown[] } };
    __webpack_require__?: { repack?: unknown };
    __webpack_share_scopes__?: unknown;
    __webpack_init_sharing__?: unknown;
};

const repackGlobals = globalThis as unknown as RepackGlobals;

describe('plugin React Native ScriptManager boot init', () => {
    beforeEach(() => {
        resetPluginReactNativeScriptManagerBootForTests();
        resetPluginReactNativeModuleFederationHostSharedScopeForTesting();
    });

    afterEach(() => {
        delete repackGlobals.__repack__;
        delete repackGlobals.__webpack_require__;
        delete repackGlobals.__webpack_share_scopes__;
        delete repackGlobals.__webpack_init_sharing__;
        resetPluginReactNativeModuleFederationHostSharedScopeForTesting();
    });

    it('initializes the Re.Pack ScriptManager exactly once across boot calls', () => {
        const init = vi.fn();
        const resolveClient = vi.fn(() => ({ ScriptManager: { init } }));

        expect(initializePluginReactNativeScriptManagerOnce({ resolveClient })).toBe(true);
        expect(init).toHaveBeenCalledTimes(1);

        // Idempotent: a second boot call is a no-op and does not re-init.
        expect(initializePluginReactNativeScriptManagerOnce({ resolveClient })).toBe(false);
        expect(init).toHaveBeenCalledTimes(1);
        expect(resolveClient).toHaveBeenCalledTimes(1);
    });

    it('initializes a ScriptManager exposed as a class (function with static init)', () => {
        // Re.Pack 5 exports `ScriptManager` as a class whose `init`/`shared` are
        // statics — `typeof ScriptManager === 'function'`, not 'object'. The boot
        // must not filter the class out.
        const init = vi.fn();
        class FakeScriptManager {
            static init = init;
        }
        const resolveClient = vi.fn(() => ({ ScriptManager: FakeScriptManager }));

        expect(initializePluginReactNativeScriptManagerOnce({ resolveClient })).toBe(true);
        expect(init).toHaveBeenCalledTimes(1);
    });

    it('provides the Re.Pack shared singleton registry for Metro-bundled hosts before init', () => {
        // Re.Pack 5's `ScriptManager.init()/shared` store the singleton on
        // `__webpack_require__.repack.shared` — a global only a Re.Pack-bundled host
        // provides. A Metro-bundled host must install an equivalent registry (also
        // mirrored on `__repack__`, which Re.Pack-built REMOTE bundles read) before
        // calling init, or the singleton can never exist.
        const init = vi.fn(() => {
            const registry = repackGlobals.__webpack_require__?.repack as
                | { shared?: { scriptManager: unknown } }
                | undefined;
            if (!registry?.shared) {
                throw new Error("Cannot read property 'shared' of undefined");
            }
            registry.shared.scriptManager = { loadScript: () => undefined };
        });
        const resolveClient = vi.fn(() => ({ ScriptManager: { init } }));

        expect(initializePluginReactNativeScriptManagerOnce({ resolveClient })).toBe(true);
        expect(init).toHaveBeenCalledTimes(1);
        // Host registry and remote-visible registry must be the SAME object so a
        // Re.Pack-built remote container shares the host's singleton.
        expect(repackGlobals.__repack__).toBeDefined();
        expect(repackGlobals.__webpack_require__?.repack).toBe(repackGlobals.__repack__);
        expect(repackGlobals.__repack__?.shared?.scriptManager).toBeDefined();
    });

    it('does not clobber a pre-existing Re.Pack host registry', () => {
        const existingShared = { scriptManager: { marker: 'host' }, enqueuedResolvers: [] };
        repackGlobals.__repack__ = { shared: existingShared };
        repackGlobals.__webpack_require__ = { repack: repackGlobals.__repack__ };
        const init = vi.fn();
        const resolveClient = vi.fn(() => ({ ScriptManager: { init } }));

        expect(initializePluginReactNativeScriptManagerOnce({ resolveClient })).toBe(true);
        expect(repackGlobals.__repack__?.shared).toBe(existingShared);
        expect(repackGlobals.__webpack_require__?.repack).toBe(repackGlobals.__repack__);
    });

    // RN-HARDEN: productizes the QA-only Module Federation share-scope hack
    // IOS-REBUILD hand-wired to prove `federated.importModule` live — the
    // native ScriptManager boot must also install a real share scope, not
    // just the ScriptManager singleton registry, or every Re.Pack remote
    // container's `container.init(shareScope)` call finds nothing.
    it('installs the Module Federation host shared scope alongside the ScriptManager registry', () => {
        const resolveClient = vi.fn(() => ({ ScriptManager: { init: vi.fn() } }));

        expect(initializePluginReactNativeScriptManagerOnce({ resolveClient })).toBe(true);

        expect(typeof repackGlobals.__webpack_init_sharing__).toBe('function');
        expect(repackGlobals.__webpack_share_scopes__).toEqual({});
    });

    it('does not install the shared scope when no native Re.Pack client resolves (fail-soft boot, e.g. web/test runtime)', () => {
        const resolveClient = vi.fn(() => null);

        expect(initializePluginReactNativeScriptManagerOnce({ resolveClient })).toBe(false);
        expect(repackGlobals.__webpack_init_sharing__).toBeUndefined();
    });
});
