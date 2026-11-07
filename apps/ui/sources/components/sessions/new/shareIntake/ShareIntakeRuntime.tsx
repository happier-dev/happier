import * as React from 'react';
import { useRouter } from 'expo-router';
import { useShareIntent } from 'expo-share-intent';

import { mapShareIntentToNewSession } from './mapShareIntentToNewSession';
import { prepareNewSessionFromShare } from './openNewSessionFromShare';

// Android system Share sheet -> new-session composer. Mounted only while authenticated, so a share that
// arrives before sign-in stays pending in the hook and is handled once this mounts.
export function ShareIntakeRuntime() {
    const router = useRouter();
    const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();

    React.useEffect(() => {
        if (!hasShareIntent) return;
        const share = mapShareIntentToNewSession(shareIntent);
        resetShareIntent();
        if (share.prompt === undefined && share.sources.length === 0) return;
        router.push(prepareNewSessionFromShare(share));
    }, [hasShareIntent, shareIntent, resetShareIntent, router]);

    return null;
}
