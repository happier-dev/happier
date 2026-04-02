import { AppState, Platform } from 'react-native';

export function isRuntimeActive(): boolean {
    try {
        const appState = String(AppState.currentState ?? '').trim();
        if (appState && appState !== 'active' && appState !== 'unknown') {
            return false;
        }
    } catch {
        // ignore
    }

    try {
        if (Platform.OS !== 'web') {
            return true;
        }
    } catch {
        // ignore
    }

    // Tauri webviews frequently report document.visibilityState="hidden" even when the desktop app
    // is on-screen (e.g. when the window is not focused). Treating that as inactive disables
    // networking and breaks desktop onboarding/control panel connectivity.
    try {
        const g = globalThis as unknown as { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
        if (typeof g.__TAURI__ !== 'undefined' || typeof g.__TAURI_INTERNALS__ !== 'undefined') {
            return true;
        }
    } catch {
        // ignore
    }

    try {
        const doc = (globalThis as unknown as { document?: Document }).document;
        if (doc && typeof doc.visibilityState === 'string' && doc.visibilityState === 'hidden') {
            return false;
        }
    } catch {
        // ignore
    }

    return true;
}
