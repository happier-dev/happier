import * as React from 'react';
import { router } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';

export default function SetupRoute() {
    const auth = useAuth();
    const redirectedRef = React.useRef(false);

    React.useEffect(() => {
        if (redirectedRef.current) {
            return;
        }

        if (!auth.isAuthenticated) {
            redirectedRef.current = true;
            clearPendingSetupIntent();
            router.replace('/');
            return;
        }

        redirectedRef.current = true;
        router.replace('/setup/wizard');
    }, [auth.isAuthenticated]);

    return null;
}
