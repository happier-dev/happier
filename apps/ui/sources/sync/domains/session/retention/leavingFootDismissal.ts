import { storage } from '@/sync/domains/state/storage';
import { applyLocalSettingsFromUi } from '@/sync/store/settingsWriters';

type LeavingFootDismissal = Readonly<{ leavingThrough?: number; policyStartsAt?: number }>;

export function writeLeavingFootDismissal(serverId: string, patch: LeavingFootDismissal): void {
    const current = storage.getState().localSettings.leavingFootDismissals;
    applyLocalSettingsFromUi({
        leavingFootDismissals: { ...current, [serverId]: { ...current[serverId], ...patch } },
    });
}
