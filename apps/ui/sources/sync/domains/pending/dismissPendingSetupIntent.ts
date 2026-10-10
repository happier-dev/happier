import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { getPendingSetupIntent, setPendingSetupIntent } from './pendingSetupIntent';
import { buildDismissedThisComputerSetupIntent } from './pendingSetupIntent.shared';

/**
 * "I'll do this later" for machine setup: the one writer every setup-wizard exit uses. It is
 * recorded on the pending setup intent, which is scoped to the signed-in account on the active
 * Home, so the choice never carries over to another account on this device.
 */
export function dismissPendingSetupIntent(): void {
    const current = getPendingSetupIntent();
    if (current?.branch === 'askHappier') return;
    if (current) {
        if (current.phase !== 'dismissed') {
            setPendingSetupIntent({ ...current, phase: 'dismissed' });
        }
        return;
    }
    setPendingSetupIntent(buildDismissedThisComputerSetupIntent(getActiveServerSnapshot().serverUrl));
}
