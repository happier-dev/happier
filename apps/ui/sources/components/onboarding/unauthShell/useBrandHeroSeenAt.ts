import { useLocalSetting } from '@/sync/store/hooks';

export function useBrandHeroSeenAt(): number | null {
    return useLocalSetting('brandHeroSeenAt');
}
