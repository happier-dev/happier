import * as React from 'react';

import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';

export function useSessionListSelectionState() {
    const selection = useResolvedActiveServerSelection();
    const enabled = selection.enabled;
    const presentation = selection.presentation;
    const activeTarget = selection.activeTarget;
    const activeServerId = selection.activeServerId;
    const allowedServerIds = selection.allowedServerIds;

    return React.useMemo(() => ({
        enabled,
        presentation,
        activeTarget,
        activeServerId,
        allowedServerIds,
        selectedServerCount: allowedServerIds?.length ?? 0,
    }), [activeTarget, activeServerId, allowedServerIds, enabled, presentation]);
}
