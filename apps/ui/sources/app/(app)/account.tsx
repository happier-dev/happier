import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';

export default function LegacyAccountRoute() {
    const params = useLocalSearchParams();
    const server = typeof params.server === 'string' ? params.server : undefined;

    React.useEffect(() => {
        // Legacy route alias: historically `/account` existed; canonical path is `/settings/account`.
        if (server) {
            router.replace({ pathname: '/settings/account', params: { server } } as any);
            return;
        }
        router.replace('/settings/account');
    }, [server]);

    return null;
}
