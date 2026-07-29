import type { BrowserViewTargetV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    applyCloseDetailsTab,
    applyOpenDetailsTab,
    applySplitDetailsGroup,
    createEmptyPaneDetailsState,
} from '@/components/appShell/panes/details/workspace/detailsWorkspaceReducer';

import {
    BROWSER_VIEW_DETAILS_TAB_KIND,
    createBrowserViewDetailsTab,
} from './browserSurfaceDetailsTabModel';

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: { title: 'Preview' },
} satisfies BrowserViewTargetV1;

const secondTarget = {
    ...target,
    targetId: 'preview_2',
    display: { title: 'Second' },
} satisfies BrowserViewTargetV1;

/**
 * D2-revised dispatch proof: a `browser-view` tab is a first-class details-workspace tab. Opening,
 * focusing-existing, splitting and closing all go through the canonical `detailsWorkspaceReducer`
 * — there is no browser-store ordering authority involved. The browser is a CONSUMER of the one
 * tab engine.
 */
describe('browser-view tab dispatches through the details-workspace reducer', () => {
    it('opens a browser-view tab into the focused group as a workspace tab', () => {
        const tab = createBrowserViewDetailsTab({ target });
        const state = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab, openAs: 'pinned' });

        expect(state.tabsByKey[tab.key]?.kind).toBe(BROWSER_VIEW_DETAILS_TAB_KIND);
        const group = Object.values(state.groupsById).find((g) => g.tabKeys.includes(tab.key));
        expect(group?.activeTabKey).toBe(tab.key);
    });

    it('focuses the existing tab on re-open of the same target (no duplicate)', () => {
        const tab = createBrowserViewDetailsTab({ target });
        const opened = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab, openAs: 'pinned' });
        const reopened = applyOpenDetailsTab(opened, {
            tab: createBrowserViewDetailsTab({ target }),
            openAs: 'pinned',
        });

        const browserTabs = Object.values(reopened.tabsByKey).filter(
            (t) => t.kind === BROWSER_VIEW_DETAILS_TAB_KIND,
        );
        expect(browserTabs).toHaveLength(1);
    });

    it('splits a group holding a browser-view tab into a new group', () => {
        const tab = createBrowserViewDetailsTab({ target });
        const opened = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab, openAs: 'pinned' });
        const groupId = Object.values(opened.groupsById).find((g) => g.tabKeys.includes(tab.key))?.id;
        expect(groupId).toBeDefined();

        const split = applySplitDetailsGroup(opened, { axis: 'horizontal', groupId });
        expect(Object.keys(split.groupsById).length).toBeGreaterThan(Object.keys(opened.groupsById).length);
    });

    it('interleaves a second browser-view tab in the same group by default', () => {
        const first = createBrowserViewDetailsTab({ target });
        const second = createBrowserViewDetailsTab({ target: secondTarget });
        let state = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab: first, openAs: 'pinned' });
        state = applyOpenDetailsTab(state, { tab: second, openAs: 'pinned' });

        const group = Object.values(state.groupsById).find((g) => g.tabKeys.includes(first.key));
        expect(group?.tabKeys).toContain(first.key);
        expect(group?.tabKeys).toContain(second.key);
    });

    it('closes a browser-view tab through the workspace reducer', () => {
        const tab = createBrowserViewDetailsTab({ target });
        const opened = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab, openAs: 'pinned' });
        const closed = applyCloseDetailsTab(opened, tab.key);

        expect(closed.tabsByKey[tab.key]).toBeUndefined();
    });
});
