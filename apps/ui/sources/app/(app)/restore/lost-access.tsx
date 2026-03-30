import * as React from 'react';
import { useRouter } from 'expo-router';

import { LostAccessView } from '@/components/account/restore/LostAccessView';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

export default function LostAccessScreen() {
    const router = useRouter();
    return (
        <LostAccessView
            returnTo="/"
            onBack={() => safeRouterBack({ router, fallbackHref: '/' })}
        />
    );
}

