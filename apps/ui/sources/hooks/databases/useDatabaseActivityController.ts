import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import type { DatabaseActivityController } from './activityController';

/** P2 supplies presentation and connectivity; the selected Resource owns its controller. */
export function useDatabaseActivityController<T>(controller: DatabaseActivityController<T>, options: Readonly<{
    presented: boolean;
    online: boolean;
}>) {
    const intervalMs = useSetting('databaseActivityAutoRefreshIntervalMs');
    const hostVisible = useHostActivelyViewed();
    const active = options.presented && options.online && hostVisible;
    const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

    React.useEffect(() => {
        if (!active) return;
        return controller.retainAutoRefresh({ intervalMs });
    }, [active, controller, intervalMs]);

    const refresh = React.useCallback(async () => {
        if (active) await controller.refresh();
    }, [active, controller]);

    return { ...snapshot, refresh };
}
