import * as React from 'react';

import { getActiveServerSnapshot, subscribeActiveServer, type ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

export function useActiveServerSnapshot(): ActiveServerSnapshot {
    const [snapshot, setSnapshot] = React.useState(() => getActiveServerSnapshot());

    React.useEffect(() => {
        return subscribeActiveServer((next) => {
            // Defensive copy: some runtime paths update the underlying snapshot object in-place.
            // React state updates are referential, so ensure subscribers re-render when fields change.
            setSnapshot({ ...next });
        });
    }, []);

    return snapshot;
}
