import * as React from 'react';

import { getServerProfilesGeneration, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';

export function useServerProfilesGeneration(enabled = true): number {
    const [generation, setGeneration] = React.useState(() => getServerProfilesGeneration());

    React.useEffect(() => {
        if (!enabled) return;
        const unsubscribe = subscribeServerProfiles(setGeneration);
        setGeneration(getServerProfilesGeneration());
        return unsubscribe;
    }, [enabled]);

    return generation;
}
