import * as React from 'react';
import { Platform } from 'react-native';

import { useDestinationInstanceTitles } from '../destinations/compactAppDestinationCatalog';
import { setDesktopWindowTitle } from '@/utils/platform/desktopWindowBridge';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { useOptionalWorkspaceNavigation } from './WorkspaceNavigationContext';

/** Browser and desktop window titles follow the same focused destination. */
export function useWorkspaceFocusedDestinationTitle(): string | null {
    const workspace = useOptionalWorkspaceNavigation();
    const group = workspace?.active ? workspace.state.groups[workspace.state.focusedGroupId] : undefined;
    const tab = group ? workspace?.state.tabs[group.activeTabId] : undefined;
    const saved = tab ? workspace?.state.fallbackTitlesByTabId[tab.id] : undefined;
    const entries = React.useMemo(() => tab ? [{ key: tab.id, ref: tab.target, fallbackTitle: saved }] : [], [tab, saved]);
    const titles = useDestinationInstanceTitles(workspace?.catalog ?? [], entries);
    return tab ? titles.get(tab.id) ?? t('common.loading') : null;
}

/** Expo disables automatic document titles; the workspace owns this one platform projection. */
export function WorkspaceWindowTitle(): null {
    const focusedTitle = useWorkspaceFocusedDestinationTitle();
    const title = focusedTitle ?? 'Happier';
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (typeof document !== 'undefined') document.title = title;
        fireAndForget(setDesktopWindowTitle(title), { tag: 'Workspace.windowTitle' });
    }, [title]);
    return null;
}
