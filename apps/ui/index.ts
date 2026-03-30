import '@expo/metro-runtime';

declare const require: (id: string) => unknown;

if (typeof window !== 'undefined') {
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

require('./sources/unistyles');
require('expo-router/entry');
