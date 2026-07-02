import React from 'react';

import { useApplyLocalSettings } from '@/sync/store/settingsWriters';

export function useApplyBrandHeroSeen(): () => void {
    const applyLocalSettings = useApplyLocalSettings();

    return React.useCallback(() => {
        applyLocalSettings({ brandHeroSeenAt: Date.now() });
    }, [applyLocalSettings]);
}
