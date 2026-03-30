import * as Notifications from 'expo-notifications';

import type { ActivityBadgeState } from '../buildActivityBadgeState';

export async function applyExpoNativeBadgeState(state: ActivityBadgeState): Promise<void> {
    await Notifications.setBadgeCountAsync(Math.max(0, state.count));
}
