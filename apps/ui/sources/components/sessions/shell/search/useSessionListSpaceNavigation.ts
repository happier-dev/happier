import * as React from 'react';

import { neighbourCollectionSpaceId } from '@/components/ui/lists/collection/collectionSpaceSwipe';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import type { SessionListViewFilterController } from './useSessionListViewFilterController';

const SELECTED_SPACE_SETTING = { anchor: 'session.list.selectedSpace' } as const;

/** Strip, menu, digit and title-swipe intents all use the captured Settings Action writer. */
export function useSessionListSpaceNavigation(controller: SessionListViewFilterController) {
    const { setSetting } = useSettingActionFeedback({ serverId: controller.spaceSettingsScope?.serverId });
    const selectSpace = React.useCallback(async (spaceId: string): Promise<boolean> => {
        if (!controller.spacesEnabled || !controller.spaceSettingsScope || !controller.spaces.some(space => space.id === spaceId)) return false;
        const accepted = await setSetting(SELECTED_SPACE_SETTING, { spaceId });
        if (accepted && spaceId === controller.selectedSpaceId) controller.resetFilters();
        return accepted;
    }, [controller.resetFilters, controller.selectedSpaceId, controller.spaceSettingsScope, controller.spaces, controller.spacesEnabled, setSetting]);
    const selectOrdinal = React.useCallback((ordinal: number): boolean => {
        if (!controller.spacesEnabled || !Number.isInteger(ordinal) || ordinal < 1) return false;
        const space = controller.spaces[ordinal - 1];
        if (!space) return false;
        void selectSpace(space.id);
        return true;
    }, [controller.spaces, controller.spacesEnabled, selectSpace]);
    const selectRelative = React.useCallback((direction: -1 | 1): boolean => {
        const spaceId = controller.spacesEnabled ? neighbourCollectionSpaceId(controller.spaces, controller.selectedSpaceId, direction) : null;
        if (spaceId === null) return false;
        void selectSpace(spaceId);
        return true;
    }, [controller.selectedSpaceId, controller.spaces, controller.spacesEnabled, selectSpace]);
    const [filterOpenRequested, setFilterOpenRequested] = React.useState(false);
    const acknowledgeFilterOpenRequest = React.useCallback(() => setFilterOpenRequested(false), []);
    const { showCoordinatorsRequest, spacesReady, spacesEnabled, selectedSpaceId, retentionScopeKey,
        contextDefaultFilters, updateFilters, acknowledgeShowCoordinatorsRequest } = controller;
    React.useEffect(() => {
        if (!showCoordinatorsRequest || !spacesReady) return;
        if (!spacesEnabled || selectedSpaceId === 'my-work') {
            updateFilters({ ...contextDefaultFilters, coordinator: 'coordinator' });
            // Settings navigation can replace this list while selection is in flight.
            // Consume the retained intent only after its destination carries the filter.
            acknowledgeShowCoordinatorsRequest();
            setFilterOpenRequested(true);
            return;
        }
        // A retired list's cancelled selection is not completion of the intent.
        // The next mounted list resumes it through the same Settings Action.
        void selectSpace('my-work');
    }, [acknowledgeShowCoordinatorsRequest, contextDefaultFilters, retentionScopeKey,
        selectSpace, selectedSpaceId, showCoordinatorsRequest, spacesReady, spacesEnabled, updateFilters]);
    return React.useMemo(() => ({ selectSpace, selectOrdinal, selectRelative, filterOpenRequested, acknowledgeFilterOpenRequest }),
        [acknowledgeFilterOpenRequest, filterOpenRequested, selectOrdinal, selectRelative, selectSpace]);
}
