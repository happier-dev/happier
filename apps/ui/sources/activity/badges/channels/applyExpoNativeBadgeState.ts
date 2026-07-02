import type { ActivityBadgeState } from '../buildActivityBadgeState';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';

let pendingCount: number | null = null;
let drainPromise: Promise<boolean> | null = null;
let lastAppliedCount: number | null = null;

async function drainPendingBadgeCount(): Promise<boolean> {
    const Notifications = await loadExpoNotifications().catch(() => null);
    if (!Notifications) {
        pendingCount = null;
        return false;
    }

    let lastResult = true;
    while (pendingCount !== null) {
        const count = pendingCount;
        pendingCount = null;
        if (count === lastAppliedCount) continue;
        lastResult = await Notifications.setBadgeCountAsync(count);
        if (lastResult) {
            lastAppliedCount = count;
        }
    }
    return lastResult;
}

export function applyExpoNativeBadgeState(state: ActivityBadgeState): Promise<boolean> {
    pendingCount = Math.max(0, state.count);
    if (!drainPromise) {
        drainPromise = drainPendingBadgeCount().finally(() => {
            drainPromise = null;
            if (pendingCount !== null) {
                void applyExpoNativeBadgeState({ count: pendingCount, showNonNumericDot: false });
            }
        });
    }
    return drainPromise;
}
