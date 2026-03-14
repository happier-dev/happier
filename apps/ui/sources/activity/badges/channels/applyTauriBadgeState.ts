import { getCurrentWindow } from '@tauri-apps/api/window';

import type { ActivityBadgeState } from '../buildActivityBadgeState';

export async function applyTauriBadgeState(state: ActivityBadgeState): Promise<void> {
    const window = getCurrentWindow();

    if (state.count > 0) {
        await window.setBadgeCount(state.count);
        await window.setBadgeLabel(undefined);
        return;
    }

    await window.setBadgeCount(undefined);
    await window.setBadgeLabel(state.showNonNumericDot ? '•' : undefined);
}
