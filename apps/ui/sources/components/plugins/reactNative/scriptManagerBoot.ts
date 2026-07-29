import { installPluginReactNativeModuleFederationHostSharedScope } from './moduleFederationHostSharedScope';
import { resolveDefaultNativeRepackClient } from './nativeRepackClientResolver';

/**
 * RN-1: the one-time Re.Pack `ScriptManager` boot initialization. Re.Pack's
 * `ScriptManager.shared` singleton must be initialized once, early, before any plugin
 * React Native bundle surface resolves a script. We do it at app boot rather than
 * lazily per-surface so the installed-artifact and dev-hot-reload loaders always find
 * an initialized ScriptManager.
 *
 * Re.Pack 5 stores the singleton on `__webpack_require__.repack.shared`, a registry a
 * Re.Pack/webpack-bundled HOST injects at bundle start (mirrored on the global
 * `__repack__`, which Re.Pack-built REMOTE containers read — see Re.Pack's
 * `RepackTargetPlugin/implementation/init.js`). This app's native host is bundled by
 * METRO, which provides neither, so the boot installs an equivalent shared registry
 * first: `globalThis.__repack__` and `__webpack_require__.repack` pointing at the SAME
 * object, so a Re.Pack-built remote bundle loaded via ScriptManager shares the host's
 * singleton.
 *
 * This is native-only and fail-soft: on web/test runtimes the client resolver returns
 * null and booting continues normally. The installed-artifact / dev loaders then fail
 * closed with the `repack_script_manager_unavailable` diagnostic instead of crashing
 * the app.
 */

type RepackSharedRegistry = {
    scriptManager: unknown;
    enqueuedResolvers: unknown[];
};

type RepackRuntimeRegistry = { shared: RepackSharedRegistry };

type RepackRuntimeGlobals = {
    __repack__?: { shared?: RepackSharedRegistry };
    __webpack_require__?: { repack?: unknown };
};

type RepackScriptManagerInitApi = Readonly<{
    ScriptManager?: Readonly<{ init?: () => void; shared?: unknown }>;
}>;

let scriptManagerBootCompleted = false;

function readScriptManagerInitApi(client: unknown): RepackScriptManagerInitApi['ScriptManager'] | null {
    if (!client || typeof client !== 'object') {
        return null;
    }
    const scriptManager = (client as RepackScriptManagerInitApi).ScriptManager;
    // Re.Pack 5 exports `ScriptManager` as a CLASS: `init`/`shared` are statics, so
    // `typeof scriptManager === 'function'`. Accept both shapes.
    if (!scriptManager) return null;
    if (typeof scriptManager !== 'object' && typeof scriptManager !== 'function') return null;
    return scriptManager;
}

function ensureRepackSharedRegistry(): void {
    const runtimeGlobals = globalThis as unknown as RepackRuntimeGlobals;
    const existingShared =
        runtimeGlobals.__repack__?.shared
        ?? (runtimeGlobals.__webpack_require__?.repack as RepackRuntimeRegistry | undefined)?.shared;
    const shared: RepackSharedRegistry = existingShared ?? {
        scriptManager: undefined,
        enqueuedResolvers: [],
    };
    if (!runtimeGlobals.__repack__) {
        runtimeGlobals.__repack__ = { shared };
    } else if (!runtimeGlobals.__repack__.shared) {
        runtimeGlobals.__repack__.shared = shared;
    }
    if (!runtimeGlobals.__webpack_require__) {
        runtimeGlobals.__webpack_require__ = {};
    }
    if (!runtimeGlobals.__webpack_require__.repack) {
        runtimeGlobals.__webpack_require__.repack = runtimeGlobals.__repack__;
    }
}

export function initializePluginReactNativeScriptManagerOnce(
    options?: Readonly<{
        resolveClient?: () => unknown;
    }>,
): boolean {
    if (scriptManagerBootCompleted) {
        return false;
    }
    scriptManagerBootCompleted = true;

    try {
        const client = (options?.resolveClient ?? resolveDefaultNativeRepackClient)();
        const scriptManager = readScriptManagerInitApi(client);
        if (!scriptManager || typeof scriptManager.init !== 'function') {
            return false;
        }
        // A client resolved (native runtime): make sure the Re.Pack singleton registry
        // exists before init — a Metro-bundled host has no `__webpack_require__.repack`.
        ensureRepackSharedRegistry();
        // RN-HARDEN: also install the Module Federation host shared scope
        // (`__webpack_init_sharing__`/`__webpack_share_scopes__`) — a
        // Re.Pack-built remote container's `Federated.importModule` needs
        // these to resolve its declared exact React runtime closure plus
        // `react-native` singleton. Productizes what was previously a
        // QA-only runtime hack
        // (see moduleFederationHostSharedScope.ts's module doc).
        installPluginReactNativeModuleFederationHostSharedScope();
        scriptManager.init();
        return true;
    } catch {
        // Re.Pack ScriptManager is only initializable in a native host with the
        // callstack-repack pod linked. Any other runtime keeps booting; the RN
        // loaders fail closed on their own.
        return false;
    }
}

export function resetPluginReactNativeScriptManagerBootForTests(): void {
    scriptManagerBootCompleted = false;
}
