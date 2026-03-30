import * as React from 'react';
import { useRouter } from 'expo-router';

import { useInboxAvailable } from './useInboxAvailable';

export function useRequireInboxAvailable(): boolean {
    const router = useRouter();
    const available = useInboxAvailable();

    React.useEffect(() => {
        if (available) return;
        router.replace('/');
    }, [available, router]);

    return available;
}
