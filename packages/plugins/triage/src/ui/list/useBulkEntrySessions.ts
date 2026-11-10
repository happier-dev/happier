import * as React from 'react';
import { usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import { presentTriageMountedUiActionFailure } from '../mountedActions.js';
import { createTriageBulkEntrySessionsController, type TriageBulkHostV1, type TriageBulkSessionsOptionsV1, type TriageBulkSessionsControllerV1 } from '../../sessions/bulkEntrySessionsController.js';
export * from '../../sessions/bulkEntrySessionsController.js';

export function useTriageBulkEntrySessions(options?: TriageBulkSessionsOptionsV1): TriageBulkSessionsControllerV1 {
    const host = usePluginHostApi();
    const text = usePluginTranslation();
    const owner = React.useMemo(() => createTriageBulkEntrySessionsController(host as unknown as TriageBulkHostV1, options), [host, options?.mintCreationKey]);
    React.useEffect(() => { owner.activate(); return () => owner.dispose(); }, [owner]);
    const snapshot = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
    const cancel = React.useCallback(async () => {
        try { await owner.getSnapshot().cancel(); }
        catch (error) { await presentTriageMountedUiActionFailure(host, error, text); }
    }, [owner, host, text]);
    const reset = React.useCallback(async () => {
        try { await owner.getSnapshot().reset(); }
        catch (error) { await presentTriageMountedUiActionFailure(host, error, text); }
    }, [owner, host, text]);
    return React.useMemo(() => ({ ...snapshot, cancel, reset }), [snapshot, cancel, reset]);
}
