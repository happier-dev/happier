import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import { createTriageEntrySessionStartController, type TriageStartHostV1, type TriageEntrySessionStartOptionsV1, type TriageEntrySessionStartControllerV1 } from '../../sessions/entrySessionStartController.js';
export * from '../../sessions/entrySessionStartController.js';

export function useTriageEntrySessionStart(options?: TriageEntrySessionStartOptionsV1): TriageEntrySessionStartControllerV1 {
    const host = usePluginHostApi() as unknown as TriageStartHostV1;
    const owner = React.useMemo(() => createTriageEntrySessionStartController(host, options), [host, options?.mintCreationKey]);
    React.useEffect(() => { owner.activate(); return () => owner.dispose(); }, [owner]);
    return React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
}
