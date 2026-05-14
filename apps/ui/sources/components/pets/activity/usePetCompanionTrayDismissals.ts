import * as React from 'react';

import { useLocalSetting } from '@/sync/domains/state/storage';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';

import type { PetCompanionTrayItem } from './petCompanionActivityTypes';
import {
    appendDismissedPetCompanionTrayItemKey,
    normalizeDismissedPetCompanionTrayItemKeys,
} from './petCompanionTrayDismissal';

export function usePetCompanionTrayDismissals(): Readonly<{
    dismissedTrayItemKeys: ReadonlySet<string>;
    dismissTrayItem: (item: PetCompanionTrayItem) => void;
}> {
    const persistedDismissedTrayItemKeys = useLocalSetting('petsDismissedCompanionTrayItemKeys');
    const applyLocalSettings = useApplyLocalSettings();
    const [optimisticDismissedKeys, setOptimisticDismissedKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const persistedDismissedKeys = React.useMemo(
        () => normalizeDismissedPetCompanionTrayItemKeys(persistedDismissedTrayItemKeys),
        [persistedDismissedTrayItemKeys],
    );
    const dismissedTrayItemKeys = React.useMemo(
        () => new Set([...persistedDismissedKeys, ...optimisticDismissedKeys]),
        [optimisticDismissedKeys, persistedDismissedKeys],
    );
    const dismissTrayItem = React.useCallback((item: PetCompanionTrayItem) => {
        setOptimisticDismissedKeys((current) => {
            if (current.has(item.dismissKey)) return current;
            const next = new Set(current);
            next.add(item.dismissKey);
            return next;
        });
        applyLocalSettings({
            petsDismissedCompanionTrayItemKeys: appendDismissedPetCompanionTrayItemKey(
                [...dismissedTrayItemKeys],
                item.dismissKey,
            ),
        });
    }, [applyLocalSettings, dismissedTrayItemKeys]);

    return { dismissedTrayItemKeys, dismissTrayItem };
}
