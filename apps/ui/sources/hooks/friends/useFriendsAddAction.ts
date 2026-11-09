import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { trackFriendsSearch } from '@/track';

export function useFriendsAddAction() {
    const router = useRouter();
    const { isReady } = useFriendsIdentityReadiness();
    return {
        isReady,
        openSearch: () => {
            if (!isReady) return;
            trackFriendsSearch();
            router.push('/friends/search');
        },
    };
}
