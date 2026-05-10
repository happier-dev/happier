import { isTauriDesktop } from '@/utils/platform/tauri';

export function isTauriMainWindowActivelyViewed(): boolean {
    if (!isTauriDesktop()) {
        return false;
    }

    const doc = (globalThis as unknown as {
        document?: {
            visibilityState?: string;
            hasFocus?: () => boolean;
        };
    }).document;

    if (doc?.visibilityState === 'hidden') {
        return false;
    }

    if (typeof doc?.hasFocus === 'function') {
        return doc.hasFocus();
    }

    return true;
}
