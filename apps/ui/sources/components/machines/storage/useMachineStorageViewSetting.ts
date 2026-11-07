import * as React from 'react';

import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { storage } from '@/sync/domains/state/storage';
import { MACHINE_STORAGE_VIEW_DEFAULT, type MachineStorageViewSettingChange } from '@/sync/domains/settings/registry/local/machineStorageViewSetting';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** Device-local Whole disk preferences; phones render List without replacing the desktop choice. */
export function useMachineStorageViewSetting(serverId: string, machineId: string, compact: boolean) {
    const key = `${serverId}\u0000${machineId}`;
    const select = React.useCallback((state: ReturnType<typeof storage.getState>) => state.localSettings.machineStorageViewV1[key], [key]);
    const own = storage(select, { localSettings: ['machineStorageViewV1'] }) ?? MACHINE_STORAGE_VIEW_DEFAULT;
    const { setSetting } = useSettingActionFeedback();
    const remember = React.useCallback((patch: MachineStorageViewSettingChange) => {
        fireAndForget(setSetting({ anchor: 'machines.storage.view', key }, patch));
    }, [key, setSetting]);
    return { shape: compact ? 'list' as const : own.shape, sort: own.sort, remember };
}
