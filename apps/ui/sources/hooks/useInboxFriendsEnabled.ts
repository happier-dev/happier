import { useServerFeatureValue } from './useServerFeatures';

export function useInboxFriendsEnabled(): boolean {
    return useServerFeatureValue({
        initial: true,
        select: (features) => features?.features?.social?.friends?.enabled !== false,
    });
}
