import '@expo/metro-runtime';

declare const require: (id: string) => unknown;

if (typeof window !== 'undefined') {
    try {
        const mod = require('./sources/utils/runtime/ensureGlobalBuffer');
        if (typeof mod === 'object' && mod !== null && 'ensureGlobalBuffer' in mod) {
            const ensure = (mod as { ensureGlobalBuffer?: unknown }).ensureGlobalBuffer;
            if (typeof ensure === 'function') {
                ensure();
            }
        }
    } catch {
        // ignore
    }

    try {
        const mod = require('./sources/dev/webHmrOptOut/webHmrOptOut');
        if (typeof mod === 'object' && mod !== null && 'installWebHmrOptOutForWebTab' in mod) {
            const install = (mod as { installWebHmrOptOutForWebTab?: unknown }).installWebHmrOptOutForWebTab;
            if (typeof install === 'function') {
                install({
                    url: new URL(window.location.href),
                    sessionStorage: window.sessionStorage,
                    history: window.history,
                });
            }
        }
    } catch {
        // ignore
    }

    try {
        const mod = require('./sources/utils/path/terminalConnectWebBootstrap');
        if (typeof mod === 'object' && mod !== null && 'bootstrapTerminalConnectWebHash' in mod) {
            const bootstrap = (mod as { bootstrapTerminalConnectWebHash?: unknown }).bootstrapTerminalConnectWebHash;
            if (typeof bootstrap === 'function') {
                bootstrap({
                    url: new URL(window.location.href),
                    sessionStorage: window.sessionStorage,
                    history: window.history,
                });
            }
        }
    } catch {
        // ignore
    }

    try {
        if (typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== 'undefined' && (globalThis as unknown as { __DEV__?: boolean }).__DEV__) {
            const mod = require('./sources/desktop/mcp/installTauriMcpWebviewDriverScripts');
            if (typeof mod === 'object' && mod !== null && 'installTauriMcpWebviewDriverScripts' in mod) {
                const install = (mod as { installTauriMcpWebviewDriverScripts?: unknown }).installTauriMcpWebviewDriverScripts;
                if (typeof install === 'function') {
                    install();
                }
            }
        }
    } catch {
        // ignore
    }
}

try {
    require('./sources/activity/adapters/ios/backgroundWake/defineLiveActivityBackgroundWakeTask');
} catch {
    // Background wake is best-effort and native-only; unsupported runtimes keep booting normally.
}

try {
    // RN-1: one-time Re.Pack ScriptManager init for plugin React Native bundle surfaces.
    // Native-only and fail-soft — web/test and non-Re.Pack hosts keep booting normally.
    const mod = require('./sources/components/plugins/reactNative/scriptManagerBoot');
    if (typeof mod === 'object' && mod !== null && 'initializePluginReactNativeScriptManagerOnce' in mod) {
        const init = (mod as { initializePluginReactNativeScriptManagerOnce?: unknown }).initializePluginReactNativeScriptManagerOnce;
        if (typeof init === 'function') {
            init();
        }
    }
} catch {
    // Re.Pack ScriptManager is only initializable in a Re.Pack-bundled native host.
}

require('./sources/unistyles');
require('expo-router/entry');
