import React from 'react';
import { useRouter } from 'expo-router';

import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';

export default function NewAutomationRoute() {
    const router = useRouter();
    const support = useAutomationsSupport();

    React.useEffect(() => {
        if (support.loading) return;
        router.replace(support.enabled ? '/new?automation=1' : '/new');
    }, [router, support.enabled, support.loading]);

    return null;
}
