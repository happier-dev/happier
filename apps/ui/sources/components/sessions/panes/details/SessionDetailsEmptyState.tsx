import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { useSessionProjectScmSnapshot } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { createSessionScmReviewDetailsTab } from './sessionDetailsTabBuilders';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

/**
 * A Session's Details with nothing open (details lab 2, ST "no tabs"): when the session has changed
 * files, the empty state invites reading them instead of explaining the pane. It mounts only while
 * Details is empty, so the always-mounted panel never subscribes to the working tree.
 */
export const SessionDetailsEmptyState = React.memo(function SessionDetailsEmptyState(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    openDetailsTab: AppPaneScopeApi['openDetailsTab'];
    onBrowseFiles?: () => void;
}>) {
    const snapshot = useSessionProjectScmSnapshot(props.sessionId, props.serverId ?? undefined);
    // The one change-count truth (the rail badge, the Git header and the tooltip read it too).
    const changedFileCount = snapshot?.repo.isRepo === true ? selectScmChangedFiles(snapshot).length : 0;
    const openDetailsTab = props.openDetailsTab;
    const openReview = React.useCallback(() => {
        openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' });
    }, [openDetailsTab]);

    if (changedFileCount > 0) {
        return (
            <SurfaceStateCard
                testID="pane-details-empty-state"
                kind="empty"
                iconName="git-diff"
                title={t('detailsSurface.chrome.emptyTitle')}
                reason={t('detailsSurface.chrome.reviewChangesReason', { count: changedFileCount })}
                action={{ label: t('detailsSurface.chrome.reviewChanges', { count: changedFileCount }), onPress: openReview }}
                secondaryAction={props.onBrowseFiles ? { label: t('detailsSurface.chrome.browseFiles'), onPress: props.onBrowseFiles } : undefined}
                note={t('detailsSurface.chrome.previewHint')}
            />
        );
    }
    return (
        <SurfaceStateCard
            testID="pane-details-empty-state"
            kind="empty"
            iconName="files"
            title={t('detailsSurface.chrome.emptyTitle')}
            reason={t('detailsSurface.chrome.emptyReason')}
            action={props.onBrowseFiles ? { label: t('detailsSurface.chrome.browseFiles'), onPress: props.onBrowseFiles } : undefined}
            note={t('detailsSurface.chrome.previewHint')}
        />
    );
});
