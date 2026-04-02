import * as React from 'react';

import { getServerProfilesGeneration, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';

export function useServerProfilesGeneration(): number {
    const [generation, setGeneration] = React.useState(() => getServerProfilesGeneration());

    React.useEffect(() => {
        return subscribeServerProfiles(setGeneration);
    }, []);

    return generation;
}
