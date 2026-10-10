import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { resetDesktopActivityOverlayPosition } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';

type PlacementIntent = Readonly<{ kind: 'mode'; value: LocalSettings['desktopOverlayPlacementMode'] }>
    | Readonly<{ kind: 'anchor'; value: LocalSettings['desktopOverlayAnchor'] }>
    | Readonly<{ kind: 'reset' }>;

/** Screen and Settings Actions apply the same placement change to storage and the native window. */
export async function commitDesktopOverlayPlacement(
    intent: PlacementIntent,
    writeLocal: (delta: Partial<LocalSettings>) => void,
): Promise<void> {
    if (intent.kind === 'mode' && intent.value === 'custom') {
        writeLocal({ desktopOverlayPlacementMode: 'custom' });
        return;
    }
    writeLocal(intent.kind === 'anchor' ? { desktopOverlayAnchor: intent.value } : {
        desktopOverlayPlacementMode: 'anchored', desktopOverlayAnchor: 'top_center',
        desktopOverlayOffsetX: 0, desktopOverlayOffsetY: 0,
    });
    await resetDesktopActivityOverlayPosition();
}
