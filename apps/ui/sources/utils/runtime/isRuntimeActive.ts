import { AppState, Platform } from 'react-native';
import { isTauriDesktop } from '@/utils/platform/tauri';

export function isRuntimeActive(): boolean {
    if (isTauriDesktop()) {
        return true;
    }

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
