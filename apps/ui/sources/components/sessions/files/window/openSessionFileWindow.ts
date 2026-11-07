import { Platform } from 'react-native';

import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';

import { buildSessionFileWindowHref, type SessionFileWindowTarget } from './sessionFileWindowRoute';

/** Share of the screen a browser file window covers, matching the desktop shell's choice. */
const BROWSER_WINDOW_SCREEN_FRACTION = { width: 0.6, height: 0.8 } as const;

/** Separate windows exist on the web and in the desktop app; phones show one screen at a time. */
export function canOpenSessionFileWindow(): boolean {
    return Platform.OS === 'web';
}

export async function openSessionFileWindow(target: SessionFileWindowTarget, title: string): Promise<void> {
    const href = buildSessionFileWindowHref(target);
    if (isTauriDesktop()) {
        await invokeTauri<void>('desktop_open_file_window', { route: href, title });
        return;
    }
    if (typeof window === 'undefined') return;
    const screen = window.screen;
    const width = Math.round((screen?.availWidth ?? 0) * BROWSER_WINDOW_SCREEN_FRACTION.width);
    const height = Math.round((screen?.availHeight ?? 0) * BROWSER_WINDOW_SCREEN_FRACTION.height);
    // `popup` asks for a separate window rather than a tab; the size is the browser's unit (CSS px).
    const features = width > 0 && height > 0
        ? `popup,noopener,width=${width},height=${height}`
        : 'popup,noopener';
    window.open(href, '_blank', features);
}
