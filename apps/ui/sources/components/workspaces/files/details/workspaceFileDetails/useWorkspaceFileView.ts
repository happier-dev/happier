import * as React from 'react';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { PaneScopeState } from '@/components/appShell/panes/model/appPaneReducer';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { resolveOpenDetailsFilePath } from '@/components/workspaces/files/resolveOpenDetailsFilePath';
import { buildWorkspaceFileViewPatch, readWorkspaceFileView, type WorkspaceFileView } from './workspaceFileView';
import { readFileTabChanges } from '@/components/sessions/panes/url/sessionPaneUrlState';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

/**
 * Memory belongs to the existing file tab; this hook only binds its reader and patch writer. The opening
 * comparison comes from the tab the page renders (`renderedChanges`), which a workspace tab addressed by a
 * Details link renders without placing it in the pane; otherwise from the pane's tab.
 */
/**
 * The pane facts a File page reads, selected per tab so an unrelated tab, Right or Bottom patch does not
 * re-render the page. Values are primitives or the stored tab record/state, so shallow equality holds.
 */
export type WorkspaceFilePaneFacts = Readonly<{
    detailsOpen: boolean;
    /** The focused group's active tab, as the scope view resolves it. */
    activeTabKey: string | null;
    /** The active tab of the group named by `focusedGroupId` (no first-group fallback). */
    focusedGroupActiveTabKey: string | null;
    presentedFilePath: string | null;
    tabState: unknown;
    resource: unknown;
}>;

export function selectWorkspaceFilePaneFacts(scope: PaneScopeState | null, tabKey: string): WorkspaceFilePaneFacts | null {
    if (!scope) return null;
    const details = buildDetailsWorkspaceStateView(scope.details);
    return {
        detailsOpen: details.isOpen,
        activeTabKey: details.activeTabKey,
        focusedGroupActiveTabKey: details.groups.find(group => group.id === details.focusedGroupId)?.activeTabKey ?? null,
        presentedFilePath: resolveOpenDetailsFilePath(details),
        tabState: details.tabState[tabKey],
        resource: details.tabs.find(tab => tab.key === tabKey)?.resource,
    };
}

type WorkspaceFileViewPane = Pick<AppPaneScopeApi, 'scopeId' | 'patchDetailsTabState'> & Readonly<{
    scopeState: Pick<WorkspaceFilePaneFacts, 'tabState' | 'resource'> | null;
}>;

export function useWorkspaceFileView(pane: WorkspaceFileViewPane, tabKey: string, renderedChanges?: SessionScmReviewComparison) {
    const tabState = pane.scopeState?.tabState;
    const resource = pane.scopeState?.resource;
    const paneChanges = React.useMemo(() => readFileTabChanges(resource), [resource]);
    // A renderer reads its tab each render; the comparison keeps its identity while its value is unchanged.
    const renderedKey = renderedChanges ? JSON.stringify(renderedChanges) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value
    const rendered = React.useMemo(() => renderedChanges, [renderedKey]);
    const initialChanges = rendered ?? paneChanges;
    const current = React.useMemo(() => ({ tabKey, tabState, patch: pane.patchDetailsTabState }), [pane.scopeId, tabKey]);
    current.tabState = tabState;
    current.patch = pane.patchDetailsTabState;
    const patchView = React.useCallback((patch: Partial<WorkspaceFileView>) => {
        const target = current;
        const next = buildWorkspaceFileViewPatch(target.tabState, patch);
        // Consecutive controls in one event merge before React publishes the next pane snapshot.
        target.tabState = next;
        target.patch(target.tabKey, next);
    }, [current]);
    return { view: React.useMemo(() => readWorkspaceFileView(tabState), [tabState]), initialChanges, patchView };
}
