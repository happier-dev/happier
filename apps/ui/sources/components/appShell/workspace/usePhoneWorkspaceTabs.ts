import * as React from 'react';

import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import {
    hrefForDestinationRef, readDestinationSessionAddress, resolveCurrentAppDestination, useDestinationInstanceTitles, type CompactAppDestination, type DestinationInstanceTitleEntry,
} from '../destinations/compactAppDestinationCatalog';
import { useOptionalWorkspaceNavigation } from './WorkspaceNavigationContext';
import { projectWorkspacePhoneTabs, type WorkspacePhoneTab } from './workspacePhoneProjection';

/** One open tab as a phone shows it: the owner's instances plus what a row needs to name it. */
export type PhoneWorkspaceTab = WorkspacePhoneTab & Readonly<{
    /** The live title of the pane on screen (a session's name, a file, a page). */
    title: string;
    /** The destination's glyph; null for a session, which shows its agent's mark instead. */
    icon: IconName | null;
    /** Set when the pane on screen is a session. */
    session: Readonly<{ sessionId: string; serverId: string | null }> | null;
    /** The tab still exists here but this phone cannot show it (unknown kind, unavailable plugin). */
    unavailable: boolean;
    pinned: boolean;
    /** The phone's preview: replaced by the next thing opened, never synced. */
    preview: boolean;
    /**
     * One line saying where a non-session tab lives when its title alone does not (the destination's
     * own name, a split's pane position, or why it is unavailable); null when there is nothing to add.
     */
    context: string | null;
}>;

export type PhoneWorkspaceTabs = Readonly<{
    /** The workspace owner runs on this phone (tabs may still be empty). */
    available: boolean;
    /** Rail order: the owner's order (pinned first), the preview last. */
    tabs: readonly PhoneWorkspaceTab[];
    /** The tab on screen, when the screen is one of them. */
    activeTabId: string | null;
    /** Shows a tab (any pane id of it): the phone navigates; a tab switch is never a history step. */
    activate: (tabId: string) => void;
    /** Closes a tab everywhere its set is synced. */
    close: (tabId: string) => void;
}>;

const NONE: readonly WorkspacePhoneTab[] = [];
const NO_ENTRIES: readonly DestinationInstanceTitleEntry[] = [];
const NO_CATALOG: readonly CompactAppDestination[] = [];
const noop = () => {};

/**
 * The phone's view of the canonical workspace owner: the same tab instances the desktop strip shows,
 * recomposed for one screen (a desktop split is one tab holding its panes). Not a store — every read
 * and write goes through `WorkspaceProvider`.
 *
 * `contentDemandKeys`: the tabs whose Session content this reader demands so they can be named (the
 * rail's mounted window); null for every tab (a page that lists them all). Titles of other tabs come
 * from content already held or the title saved with the layout.
 */
export function usePhoneWorkspaceTabs(contentDemandKeys: ReadonlySet<string> | null): PhoneWorkspaceTabs {
    const phone = useOptionalWorkspaceNavigation(value => value?.phone ?? null);
    const state = useOptionalWorkspaceNavigation(value => value?.state ?? null);
    const isSessionVisible = useSessionRecordingVisibility(phone !== null);
    const projected = React.useMemo(() => {
        if (!phone || !state) return NONE;
        const rows = projectWorkspacePhoneTabs(state)
            // A blank "new tab" is the owner's empty-group filler, never something to show.
            .map((tab) => ({ ...tab, panes: tab.panes.filter((pane) => {
                const session = readDestinationSessionAddress(pane.target);
                return pane.target.kind !== 'newTab' && (!session || isSessionVisible(session));
            }) }))
            .filter((tab) => tab.panes.length > 0)
            .map((tab) => (tab.panes.some((pane) => pane.id === tab.activeTabId) ? tab : { ...tab, activeTabId: tab.panes[0].id }));
        return [...rows.filter((tab) => !tab.panes.some((pane) => pane.preview)), ...rows.filter((tab) => tab.panes.some((pane) => pane.preview))];
    }, [phone, state, isSessionVisible]);
    const titleEntries = React.useMemo(() => (projected.length === 0 ? NO_ENTRIES : projected.flatMap((tab) => {
        const pane = tab.panes.find((item) => item.id === tab.activeTabId) ?? tab.panes[0];
        return [{ key: tab.id, instanceKey: pane.id, ref: pane.target, fallbackTitle: state?.fallbackTitlesByTabId[pane.id] }];
    })), [projected, state?.fallbackTitlesByTabId]);
    const catalog = phone?.catalog ?? null;
    const titles = useDestinationInstanceTitles(catalog ?? NO_CATALOG, titleEntries, contentDemandKeys);
    const tabs = React.useMemo((): readonly PhoneWorkspaceTab[] => projected.map((tab) => {
        const pane = tab.panes.find((item) => item.id === tab.activeTabId) ?? tab.panes[0];
        const href = catalog ? hrefForDestinationRef(catalog, pane.target) : null;
        const destination = href && catalog ? resolveCurrentAppDestination(catalog, href) : null;
        const isSession = pane.target.kind === 'session' && typeof pane.target.params.id === 'string';
        const title = titles.get(tab.id) ?? t(href ? 'common.loading' : 'common.unavailable');
        const unavailable = href === null || (destination?.kind === 'plugin' && destination.availability === 'unavailable');
        const position = tab.panes.findIndex((item) => item.id === pane.id) + 1;
        const context = unavailable
            ? (destination?.kind === 'plugin' ? destination.unavailableReason : undefined) ?? t('phoneNav.rail.notAvailableTitle')
            : tab.panes.length > 1
                ? t('phoneNav.rail.paneOf', { position, total: tab.panes.length })
                : destination && destination.title !== title ? destination.title : null;
        return {
            ...tab,
            title,
            context,
            icon: isSession ? null : destination?.icon ?? 'file',
            session: isSession ? { sessionId: pane.target.params.id, serverId: pane.target.params.serverId ?? null } : null,
            unavailable,
            pinned: tab.panes.some((item) => item.pinned),
            preview: tab.panes.some((item) => item.preview),
        };
    }), [catalog, projected, state?.fallbackTitlesByTabId, titles]);
    const activeTabId = React.useMemo(() => {
        if (!phone?.onTab || !state) return null;
        const focused = state.groups[state.focusedGroupId]?.activeTabId ?? null;
        return tabs.find((tab) => tab.panes.some((pane) => pane.id === focused))?.id ?? null;
    }, [phone?.onTab, state, tabs]);
    return React.useMemo(() => ({
        available: phone !== null,
        tabs,
        activeTabId,
        activate: phone?.activateTab ?? noop,
        close: phone?.closeTab ?? noop,
    }), [activeTabId, phone, tabs]);
}
