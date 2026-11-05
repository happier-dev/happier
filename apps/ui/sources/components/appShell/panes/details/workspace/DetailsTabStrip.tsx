import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { DocumentTabStrip, type DocumentTabPresentation, type DocumentTabStripTestIds } from '@/components/ui/navigation/DocumentTabStrip';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import type { DetailsTabState, DetailsWorkspaceGroupView } from './detailsWorkspaceTypes';
import { hrefForDestinationRef, useDestinationInstanceTitles, type DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { runGuardedTabNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useWorkspaceRouterFacts } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { detailsTabNavigationKey } from './detailsTabLifetime';

export type DetailsTabStripTestIds = DocumentTabStripTestIds;
export type DetailsTabPresentation = DocumentTabPresentation;
export type DetailsTabStripProps = Readonly<{
    sessionId?: string;
    serverId?: string | null;
    paneScopeId?: string;
    resolveTabHref?: (tab: DetailsTabState) => string | null;
    pane: Pick<AppPaneScopeApi, 'setActiveDetailsTab' | 'pinDetailsTab' | 'unpinDetailsTab' | 'closeDetailsTab'>;
    group: DetailsWorkspaceGroupView;
    resolveTabIconName?: ((tab: DetailsTabState) => string | null | undefined) | null;
    resolveTabPresentation?: ((tab: DetailsTabState) => DetailsTabPresentation | null | undefined) | null;
    unsavedTabKeys?: ReadonlySet<string>;
    testIds?: DetailsTabStripTestIds;
}>;

export function detailsTabNativeId(groupId: string, tabKey: string): string {
    return `details-${toTestIdSafeValue(groupId)}-tab-${toTestIdSafeValue(tabKey)}`;
}

export function detailsTabPanelNativeId(groupId: string, tabKey: string): string {
    return `details-${toTestIdSafeValue(groupId)}-panel-${toTestIdSafeValue(tabKey)}`;
}

function detailsTabDestinationRef(tab: DetailsTabState, sessionId: string, serverId: string | null | undefined): DestinationRef {
    return {
        kind: tab.kind === 'session' ? 'session' : 'sessionDetails',
        params: { id: sessionId, ...(serverId ? { serverId } : {}), ...buildActiveDetailsRouteParams([tab], tab.key) },
    };
}

/** A Details tab's close, as its strip offers it: an unsaved tab asks first. */
export function useGuardedDetailsTabClose(closeDetailsTab: AppPaneScopeApi['closeDetailsTab'], scopeId?: string): (tabKey: string) => void {
    return React.useCallback((tabKey: string) => {
        void runGuardedTabNavigation([scopeId ? detailsTabNavigationKey(scopeId, tabKey) : tabKey], () => closeDetailsTab(tabKey));
    }, [closeDetailsTab, scopeId]);
}

/** Details owns resource semantics; DocumentTabStrip owns the shared document chrome. */
export const DetailsTabStrip = React.memo((props: DetailsTabStripProps) => {
    const { theme } = useUnistyles();
    const { sessionId, serverId, resolveTabHref, resolveTabIconName } = props;
    const workspace = useWorkspaceRouterFacts();
    const closeTab = useGuardedDetailsTabClose(props.pane.closeDetailsTab, props.paneScopeId);
    const entries = React.useMemo(() => sessionId ? props.group.tabs.map(tab => ({
        key: tab.key, fallbackTitle: tab.title, ref: detailsTabDestinationRef(tab, sessionId, serverId),
    })) : [], [props.group.tabs, serverId, sessionId]);
    const titles = useDestinationInstanceTitles(EMPTY_CATALOG, entries);
    const previousTitleRows = React.useRef<ReadonlyMap<DetailsTabState, DetailsTabState>>(new Map());
    const tabs = React.useMemo(() => {
        const nextTitleRows = new Map<DetailsTabState, DetailsTabState>();
        const rows = props.group.tabs.map(tab => {
            const title = titles.get(tab.key);
            if (!title || title === tab.title) return tab;
            // Another title changing must not replace an unchanged derived row.
            // Exact source identity keeps every other visual field current.
            const previous = previousTitleRows.current.get(tab);
            const row = previous?.title === title ? previous : { ...tab, title };
            nextTitleRows.set(tab, row);
            return row;
        });
        previousTitleRows.current = nextTitleRows;
        return rows;
    }, [props.group.tabs, titles]);
    const primaryColor = theme.colors.text.primary;
    const secondaryColor = theme.colors.text.secondary;
    const renderLeadingIcon = React.useCallback((tab: DetailsTabState, active: boolean) => {
        if (tab.kind === 'file') return <FileIcon fileName={tab.title} size={M.tabGlyphPx}
            testID={`session-details-tab-file-icon-${toTestIdSafeValue(tab.key)}`} />;
        const iconName = resolveTabIconName?.(tab) ?? ({
            commit: 'git-commit', scmReview: 'diff', scmStash: 'archive',
            scmPullRequest: 'git-pull-request', terminal: 'terminal', executionRunLauncher: 'play',
        }[tab.kind] ?? 'circle');
        return <Icon name={iconName as IconName} size={M.tabGlyphPx}
            color={active ? primaryColor : secondaryColor} />;
    }, [resolveTabIconName, primaryColor, secondaryColor]);
    const wrapTab = React.useCallback((tab: DetailsTabState, content: React.ReactNode) => {
        const href = resolveTabHref ? resolveTabHref(tab)
            : sessionId ? hrefForDestinationRef(EMPTY_CATALOG, detailsTabDestinationRef(tab, sessionId, serverId)) : null;
        const scope = workspace?.read().desktopPresentation;
        const windowTarget = props.paneScopeId && scope?.layoutId ? {
            kind: 'paneTab' as const, serverId: scope.serverId, accountId: scope.accountId,
            layoutId: scope.layoutId, scopeId: props.paneScopeId, tabKey: tab.key,
        } : undefined;
        return <WorkspaceDestinationRow href={href} middleClickBehavior="passthrough" openOptions={windowTarget ? { windowTarget } : undefined}
            onOpened={() => closeTab(tab.key)}>{content}</WorkspaceDestinationRow>;
    }, [closeTab, props.paneScopeId, resolveTabHref, serverId, sessionId, workspace]);
    return <DocumentTabStrip
        tabs={tabs}
        activeTabKey={props.group.activeTabKey}
        accessibilityLabel={t('common.details')}
        onActivate={props.pane.setActiveDetailsTab}
        onPin={props.pane.pinDetailsTab}
        onUnpin={props.pane.unpinDetailsTab}
        onClose={closeTab}
        resolveTabPresentation={props.resolveTabPresentation}
        unsavedTabKeys={props.unsavedTabKeys}
        testIds={props.testIds}
        tabNativeId={(key) => detailsTabNativeId(props.group.id, key)}
        panelNativeId={(key) => detailsTabPanelNativeId(props.group.id, key)}
        renderLeadingIcon={renderLeadingIcon}
        wrapTab={wrapTab}
    />;
});

const EMPTY_CATALOG = Object.freeze([]);
