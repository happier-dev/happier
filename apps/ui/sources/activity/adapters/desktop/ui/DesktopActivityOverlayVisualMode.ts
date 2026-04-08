import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';

export type DesktopActivityOverlayVisualMode = 'notch_integrated' | 'floating_overlay';

export function resolveDesktopActivityOverlayVisualMode(params: Readonly<{
    presentationMode: DesktopOverlayPolicy['presentationMode'];
    compactStyle: DesktopOverlayPolicy['compactStyle'];
    hostMode?: 'floating' | 'notch_integrated' | null;
}>): DesktopActivityOverlayVisualMode {
    if (params.hostMode === 'notch_integrated') {
        return 'notch_integrated';
    }

    if (params.hostMode === 'floating') {
        return 'floating_overlay';
    }

    if (params.presentationMode === 'notch_integrated') {
        return 'notch_integrated';
    }

    if (params.presentationMode === 'floating_overlay') {
        return 'floating_overlay';
    }

    return 'floating_overlay';
}

export function resolveDesktopActivityOverlaySurfaceTestID(
    baseTestID: string,
    visualMode: DesktopActivityOverlayVisualMode,
): string {
    return `${baseTestID}-${visualMode === 'notch_integrated' ? 'notch' : 'floating'}`;
}
