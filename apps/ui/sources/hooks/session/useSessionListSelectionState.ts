import * as React from 'react';

import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';

export function useSessionListSelectionState() {
    const selection = useResolvedActiveServerSelection();
    const enabled = selection.enabled;
    const presentation = selection.presentation;
    const activeServerId = selection.activeServerId;
    const allowedServerIds = selection.allowedServerIds;

    return React.useMemo(() => ({
        enabled,
        presentation,
        activeServerId,
        allowedServerIds,
        selectedServerCount: allowedServerIds?.length ?? 0,
    }), [activeServerId, allowedServerIds, enabled, presentation]);
}
