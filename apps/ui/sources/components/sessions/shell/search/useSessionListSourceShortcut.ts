import * as React from 'react';

import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { SessionListViewFilterController } from './useSessionListViewFilterController';

/** Source changes stay on the mounted list's retained filter, shared with its filter controls. */
export function useSessionListSourceShortcut(controller: SessionListViewFilterController, active: boolean): void {
    const { displayFilters, setSource, sourceAvailable } = controller;
    useKeyboardShortcutHandlers(React.useMemo(() => active && sourceAvailable ? {
        'sessionList.source.toggle': () => setSource(displayFilters.source === 'direct' ? 'persisted' : 'direct'),
    } : {}, [active, displayFilters.source, setSource, sourceAvailable]));
}
