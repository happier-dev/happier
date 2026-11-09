import * as React from 'react';

import { petActivityDismissalsState, usePetActivityDismissals } from '@/sync/domains/state/onboardingUiState';

import type { PetCompanionTrayItem } from './petCompanionActivityTypes';
import {
    appendDismissedPetCompanionTrayItemKey,
    normalizeDismissedPetCompanionTrayItemKeys,
} from './petCompanionTrayDismissal';

export function usePetCompanionTrayDismissals(): Readonly<{
    dismissedTrayItemKeys: ReadonlySet<string>;
    dismissTrayItem: (item: PetCompanionTrayItem) => void;
}> {
    const persistedDismissedTrayItemKeys = usePetActivityDismissals();
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
        petActivityDismissalsState.set('tray', appendDismissedPetCompanionTrayItemKey(
                [...dismissedTrayItemKeys],
                item.dismissKey,
            ));
    }, [dismissedTrayItemKeys]);

    return { dismissedTrayItemKeys, dismissTrayItem };
}
