import { useOnboardingHistoryTimestamp } from '@/sync/domains/state/onboardingUiState';

export function useBrandHeroSeenAt(): number | null {
    return useOnboardingHistoryTimestamp('brandHeroSeenAt');
}
