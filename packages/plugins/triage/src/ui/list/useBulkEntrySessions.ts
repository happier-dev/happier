import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import { createTriageBulkEntrySessionsController, type TriageBulkHostV1, type TriageBulkSessionsOptionsV1, type TriageBulkSessionsControllerV1 } from '../../sessions/bulkEntrySessionsController.js';
export * from '../../sessions/bulkEntrySessionsController.js';

export function useTriageBulkEntrySessions(options?: TriageBulkSessionsOptionsV1): TriageBulkSessionsControllerV1 {
    const host = usePluginHostApi() as unknown as TriageBulkHostV1;
    const owner = React.useMemo(() => createTriageBulkEntrySessionsController(host, options), [host, options?.mintCreationKey]);
    React.useEffect(() => { owner.activate(); return () => owner.dispose(); }, [owner]);
    return React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
}
