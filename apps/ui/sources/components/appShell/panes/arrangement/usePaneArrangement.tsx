import * as React from 'react';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import type { PaneArrangement } from '@/components/ui/panels/paneBreakpoints';
import { readShellColumnActionOwner, subscribeShellColumnActionOwners } from '@/sync/ops/actions/scopeActionFamily';

export function usePaneArrangement() {
    const value = useLocalSetting('paneArrangement');
    const applyLocalSettings = useApplyLocalSettings();
    const arrangement: PaneArrangement = value === 'editor' ? 'editor' : 'session';
    const setArrangement = React.useCallback((next: PaneArrangement) => {
        applyLocalSettings({ paneArrangement: next });
    }, [applyLocalSettings]);
    const toggle = React.useCallback(() => setArrangement(arrangement === 'editor' ? 'session' : 'editor'), [arrangement, setArrangement]);
    return React.useMemo(() => ({ arrangement, setArrangement, toggle }), [arrangement, setArrangement, toggle]);
}

/**
 * Whether the focused destination follows the arrangement (Session and Project pages on a
 * multi-pane device). Chrome outside the pane hosts, such as the title strip's toggle, shows itself
 * only then; it re-reads when the focused host's facts change.
 */
const readArrangementAvailable = () => readShellColumnActionOwner('main')?.arrangementAvailable === true;
export function usePaneArrangementAvailable(): boolean {
    return React.useSyncExternalStore(subscribeShellColumnActionOwners, readArrangementAvailable, readArrangementAvailable);
}
