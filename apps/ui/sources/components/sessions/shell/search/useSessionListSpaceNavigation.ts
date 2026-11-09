import * as React from 'react';

import { neighbourHappierCollectionSpaceId } from '@happier-dev/plugin-ui/presentation';
import { selectCollectionSpace } from '@/sync/domains/session/listing/sessionListSpaces';
import type { SessionListViewFilterController } from './useSessionListViewFilterController';

/** Strip, menu, digit and title-swipe intents navigate through the device UI-state owner. */
export function useSessionListSpaceNavigation(controller: SessionListViewFilterController) {
    const selectSpace = React.useCallback((spaceId: string): boolean => {
        if (!controller.spacesEnabled || !controller.spaceSettingsScope) return false;
        selectCollectionSpace(controller.spaceSettingsScope, 'sessionWork', spaceId);
        if (spaceId === controller.selectedSpaceId) controller.resetFilters();
        return true;
    }, [controller.resetFilters, controller.selectedSpaceId, controller.spaceSettingsScope, controller.spacesEnabled]);
    const selectOrdinal = React.useCallback((ordinal: number): boolean => {
        if (!controller.spacesEnabled || !Number.isInteger(ordinal) || ordinal < 1) return false;
        const space = controller.spaces[ordinal - 1];
        if (!space) return false;
        return selectSpace(space.id);
    }, [controller.spaces, controller.spacesEnabled, selectSpace]);
    const selectRelative = React.useCallback((direction: -1 | 1): boolean => {
        const spaceId = controller.spacesEnabled ? neighbourHappierCollectionSpaceId(controller.spaces, controller.selectedSpaceId, direction) : null;
        if (spaceId === null) return false;
        return selectSpace(spaceId);
    }, [controller.selectedSpaceId, controller.spaces, controller.spacesEnabled, selectSpace]);
    const [filterOpenRequested, setFilterOpenRequested] = React.useState(false);
    const acknowledgeFilterOpenRequest = React.useCallback(() => setFilterOpenRequested(false), []);
    const { showCoordinatorsRequest, spacesReady, spacesEnabled, selectedSpaceId, retentionScopeKey,
        contextDefaultFilters, updateFilters, acknowledgeShowCoordinatorsRequest } = controller;
    React.useEffect(() => {
        if (!showCoordinatorsRequest || !spacesReady) return;
        if (!spacesEnabled || selectedSpaceId === 'my-work') {
            updateFilters({ ...contextDefaultFilters, coordinator: 'coordinator' });
            // Consume the retained intent only after its destination carries the filter.
            acknowledgeShowCoordinatorsRequest();
            setFilterOpenRequested(true);
            return;
        }
        // The selected Space's next projection carries the retained intent.
        void selectSpace('my-work');
    }, [acknowledgeShowCoordinatorsRequest, contextDefaultFilters, retentionScopeKey,
        selectSpace, selectedSpaceId, showCoordinatorsRequest, spacesReady, spacesEnabled, updateFilters]);
    return React.useMemo(() => ({ selectSpace, selectOrdinal, selectRelative, filterOpenRequested, acknowledgeFilterOpenRequest }),
        [acknowledgeFilterOpenRequest, filterOpenRequested, selectOrdinal, selectRelative, selectSpace]);
}
