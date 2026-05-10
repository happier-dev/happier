import * as React from 'react';

import { useLocalSettings } from '@/sync/domains/state/storage';
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
    const localSettings = useLocalSettings();
    const applyLocalSettings = useApplyLocalSettings();
    const [optimisticDismissedKeys, setOptimisticDismissedKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const persistedDismissedKeys = React.useMemo(
        () => normalizeDismissedPetCompanionTrayItemKeys(localSettings.petsDismissedCompanionTrayItemKeys),
        [localSettings.petsDismissedCompanionTrayItemKeys],
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
