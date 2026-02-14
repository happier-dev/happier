import { useFeatureEnabled } from './useFeatureEnabled';

export function useFriendsEnabled(): boolean {
    return useFeatureEnabled('social.friends');
}

