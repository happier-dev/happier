import * as React from 'react';
import {
    createSessionCommitDetailsTab,
    createSessionFileDetailsTab,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

type PaneLike = Readonly<{
    openDetailsTab: (tab: any, options?: any) => void;
}>;

export function useSessionRightPanelGitOpenDetails(pane: PaneLike): Readonly<{
    openFileInDetails: (fullPath: string) => void;
    openFileInDetailsPinned: (fullPath: string) => void;
    openCommitInDetails: (sha: string) => void;
}> {
    const openDetailsTab = pane.openDetailsTab;

    const openFileInDetails = React.useCallback((fullPath: string) => {
        openDetailsTab(createSessionFileDetailsTab(fullPath));
    }, [openDetailsTab]);

    const openFileInDetailsPinned = React.useCallback((fullPath: string) => {
        openDetailsTab(
            createSessionFileDetailsTab(fullPath),
            { intent: 'pinned' }
        );
    }, [openDetailsTab]);

    const openCommitInDetails = React.useCallback((sha: string) => {
        const tab = createSessionCommitDetailsTab(sha);
        if (tab) openDetailsTab(tab);
    }, [openDetailsTab]);

    return { openFileInDetails, openFileInDetailsPinned, openCommitInDetails };
}
