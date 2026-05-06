import { getCurrentWindow } from '@tauri-apps/api/window';

import type { ActivityBadgeState } from '../buildActivityBadgeState';

let pendingState: ActivityBadgeState | null = null;
let drainPromise: Promise<void> | null = null;
let lastAppliedStateKey: string | null = null;

function getStateKey(state: ActivityBadgeState): string {
    return `${Math.max(0, state.count)}:${state.showNonNumericDot ? 'dot' : 'none'}`;
}

async function applyTauriBadgeStateDirect(state: ActivityBadgeState): Promise<void> {
    const window = getCurrentWindow();

    if (state.count > 0) {
        await window.setBadgeCount(state.count);
        return;
    }

    await window.setBadgeCount(undefined);
    await window.setBadgeLabel(state.showNonNumericDot ? '•' : undefined);
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
