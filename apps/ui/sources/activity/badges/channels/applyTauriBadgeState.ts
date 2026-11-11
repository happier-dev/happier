import { getCurrentWindow } from '@tauri-apps/api/window';

import type { ActivityBadgeState } from '../activityBadgeState';

let pendingState: ActivityBadgeState | null = null;
let drainPromise: Promise<void> | null = null;
let lastAppliedStateKey: string | null = null;

function getStateKey(state: ActivityBadgeState): string {
    return `${Math.max(0, state.count)}:${state.showNonNumericDot ? 'dot' : 'none'}`;
}

function getTauriDesktopPlatform(): 'macos' | 'windows' | 'other' {
    const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    if (/Windows NT/i.test(userAgent)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos';
    return 'other';
}

async function applyTauriBadgeStateDirect(state: ActivityBadgeState): Promise<void> {
    const window = getCurrentWindow();
    const platform = getTauriDesktopPlatform();

    // Tauri exposes neither badge command on Windows. Avoid invoking commands that the
    // platform cannot implement; otherwise every state update becomes an unhandled IPC error.
    if (platform === 'windows') return;

    if (state.count > 0) {
        await window.setBadgeCount(state.count);
        return;
    }

    await window.setBadgeCount(undefined);
    if (platform === 'macos') {
        await window.setBadgeLabel(state.showNonNumericDot ? '•' : undefined);
    }
}

async function drainPendingBadgeState(): Promise<void> {
    while (pendingState) {
        const state = pendingState;
        pendingState = null;
        const stateKey = getStateKey(state);
        if (stateKey === lastAppliedStateKey) continue;
        await applyTauriBadgeStateDirect(state);
        lastAppliedStateKey = stateKey;
    }
}

export function applyTauriBadgeState(state: ActivityBadgeState): Promise<void> {
    pendingState = state;
    if (!drainPromise) {
        drainPromise = drainPendingBadgeState().finally(() => {
            drainPromise = null;
            if (pendingState) {
                void applyTauriBadgeState(pendingState);
            }
        });
    }
    return drainPromise;
}
