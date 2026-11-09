import React from 'react';

import { onboardingHistoryState } from '@/sync/domains/state/onboardingUiState';

export function useApplyBrandHeroSeen(): () => void {
    return React.useCallback(() => {
        onboardingHistoryState.set('brandHeroSeenAt', Date.now());
    }, []);
}
