import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';

import { createSessionFileDetailsTab } from './details/sessionDetailsTabBuilders';

export function useSessionFileDetailsOpener(scopeId: string): Readonly<{
    openFileInDetails: (fullPath: string) => void;
    openFileInDetailsPinned: (fullPath: string) => void;
}> {
    const pane = useAppPaneScope(scopeId);

    const openFileDetailsTab = React.useCallback((fullPath: string, intent?: { intent: 'pinned' }) => {
        deferOnWeb(() => {
            pane.openDetailsTab(createSessionFileDetailsTab(fullPath), intent);
        });
    }, [pane]);

    const openFileInDetails = React.useCallback((fullPath: string) => {
        openFileDetailsTab(fullPath);
    }, [openFileDetailsTab]);

    const openFileInDetailsPinned = React.useCallback((fullPath: string) => {
        openFileDetailsTab(fullPath, { intent: 'pinned' });
    }, [openFileDetailsTab]);

    return { openFileInDetails, openFileInDetailsPinned };
}
