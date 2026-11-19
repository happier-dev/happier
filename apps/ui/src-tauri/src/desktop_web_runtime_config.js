function applyDesktopWebRuntimeConfig(next, mainWindowLabel) {
    try {
        const current = window.__HAPPIER_WEB_RUNTIME_CONFIG__;
        window.__HAPPIER_WEB_RUNTIME_CONFIG__ = {
            ...(current && typeof current === 'object' ? current : {}),
            ...next,
        };
        const label = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
        if (label === mainWindowLabel && typeof next.serverUrl === 'string' && next.serverUrl.trim()) {
            const url = new URL(window.location.href);
            url.searchParams.set('server', next.serverUrl.trim());
            window.history.replaceState(null, '', url.toString());
        }
    } catch {
        // An unavailable history object must not prevent the app from booting.
    }
}
