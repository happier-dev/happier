import { getCurrentWindow } from '@tauri-apps/api/window';

import { desktopHostKind, type DesktopHostKind } from '@/utils/platform/desktopHost';

export const PERSONAL_HOME_TAURI_MAIN_WINDOW_LABEL = 'main';

export function resolvePersonalHomeBootstrapHost(input: Readonly<{
    desktopHostKind: DesktopHostKind | null;
    currentWindowLabel: string | null;
}>): boolean {
    return input.desktopHostKind === 'tauri'
        && input.currentWindowLabel === PERSONAL_HOME_TAURI_MAIN_WINDOW_LABEL;
}

function readCurrentTauriWindowLabel(): string | null {
    try {
        const label = getCurrentWindow().label;
        return typeof label === 'string' && label.length > 0 ? label : null;
    } catch {
        return null;
    }
}

/**
 * Platform fact only; setupSurfacePolicy owns admission for Personal Home installation.
 * Call this before constructing runtime, daemon, authentication, or system-task hooks.
 */
export function isPersonalHomeBootstrapRuntimeHost(): boolean {
    const hostKind = desktopHostKind();
    return resolvePersonalHomeBootstrapHost({
        desktopHostKind: hostKind,
        currentWindowLabel: hostKind === 'tauri' ? readCurrentTauriWindowLabel() : null,
    });
}
