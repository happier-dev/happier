import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { DocumentTabStrip, type DocumentTabItem, type DocumentTabEntityDragSource } from '@/components/ui/navigation/DocumentTabStrip';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { readSessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useActiveServerAccountScope, useSession } from '@/sync/domains/state/storage';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { hrefForDestinationRef, resolveCurrentAppDestination, useDestinationInstanceTitles } from '../destinations/compactAppDestinationCatalog';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useOptionalWorkspaceNavigation, type WorkspacePhoneControls } from './WorkspaceNavigationContext';
import { usePhoneWorkspaceTabs, type PhoneWorkspaceTab } from './usePhoneWorkspaceTabs';
import { resolveWorkspaceDestinationEntityItem } from './workspaceEntitySource';

export const PHONE_OPEN_TABS_RAIL_TEST_ID = 'phone-open-tabs-rail';

/** The rail is a set the person chose to keep, so it appears once a second tab is open (lab R). */
const MINIMUM_TABS = 2;

type RailItem = DocumentTabItem & Readonly<{
    icon: NonNullable<PhoneWorkspaceTab['icon']>;
    sessionId: string | null;
    serverId: string | null;
}>;

const styles = StyleSheet.create((theme) => ({
    // The strip keeps a finger's room above and below its pills inside its own viewport (44 pt tab targets).
    root: {
        paddingBottom: theme.space.s2,
    },
    synced: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        paddingLeft: theme.space.s4,
        paddingRight: theme.space.s2,
    },
    syncedLabel: {
        ...Typography.variant('micro'),
        color: theme.colors.text.tertiary,
    },
    pager: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 34,
        paddingHorizontal: theme.space.s20,
    },
    dots: {
        flexDirection: 'row',
        gap: theme.space.s4,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.surface.selected,
    },
    dotOn: {
        backgroundColor: theme.colors.text.secondary,
    },
    pagerPosition: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    pagerTitle: {
        flex: 1,
        minWidth: 0,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    pagerNext: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
        minHeight: 34,
    },
    pagerNextLabel: {
        ...Typography.variant('meta'),
        color: theme.colors.text.link,
    },
}));

/**
 * The phone's open tabs under the session header: the same tab instances as the desktop strip, as
 * scrolling pills (pinned marks first, the preview last in italics). A tap shows the tab (never a
 * history step); the open tab carries its close. Hidden below two tabs.
 */
export const PhoneOpenTabsRail = React.memo(function PhoneOpenTabsRail() {
    const phoneTabs = usePhoneWorkspaceTabs();
    const scope = useActiveServerAccountScope();
    const runtime = useEntityDragDropRuntime();
    const dragBindingId = React.useId();
    const workspace = useOptionalWorkspaceNavigation();
    const syncStatus = useOptionalWorkspaceNavigation()?.tabSyncStatus;
    const { theme } = useUnistyles();
    // Keep only the rail's own visible facts, not the upstream pane/state objects.
    // A different active tab or one changed title must not replace every strip row.
    const itemsRef = React.useRef<readonly RailItem[]>([]);
    const items = React.useMemo((): readonly RailItem[] => {
        const previous = itemsRef.current;
        const byKey = new Map(previous.map(item => [item.key, item]));
        const next = phoneTabs.tabs.map((tab): RailItem => {
            const item: RailItem = {
                key: tab.id,
                title: tab.title,
                // A desktop split is one tab here; its count says it holds more than one pane.
                subtitle: tab.panes.length > 1 ? String(tab.panes.length) : null,
                isPreview: tab.preview,
                isPinned: tab.pinned,
                isUnavailable: tab.unavailable,
                icon: tab.unavailable ? 'cloud-slash' : tab.icon ?? 'file',
                sessionId: tab.unavailable ? null : tab.session?.sessionId ?? null,
                serverId: tab.unavailable ? null : tab.session?.serverId ?? null,
            };
            const held = byKey.get(item.key);
            return held && held.title === item.title && held.subtitle === item.subtitle
                && held.isPreview === item.isPreview && held.isPinned === item.isPinned
                && held.isUnavailable === item.isUnavailable && held.icon === item.icon
                && held.sessionId === item.sessionId && held.serverId === item.serverId ? held : item;
        });
        itemsRef.current = previous.length === next.length && next.every((item, index) => item === previous[index]) ? previous : next;
        return itemsRef.current;
    }, [phoneTabs.tabs]);
    const renderLeadingIcon = React.useCallback((item: RailItem, active: boolean) => {
        const color = item.isUnavailable ? theme.colors.text.tertiary : active ? theme.colors.text.primary : theme.colors.text.secondary;
        if (item.sessionId !== null) return <RailSessionMark sessionId={item.sessionId} serverId={item.serverId} />;
        return <Icon name={item.icon} size={14} color={color} />;
    }, [theme.colors.text.primary, theme.colors.text.secondary, theme.colors.text.tertiary]);
    const synced = syncStatus === 'synced' || syncStatus === 'pending';
    const trailing = React.useMemo(() => (synced ? (
        <View style={styles.synced} accessible accessibilityLabel={t('phoneNav.rail.syncedA11y')}>
            <Icon name="arrows-clockwise" size={13} color={theme.colors.text.tertiary} />
            <Text style={styles.syncedLabel}>{t('phoneNav.rail.synced')}</Text>
        </View>
    ) : null), [synced, theme.colors.text.tertiary]);
    const catalog = useOptionalWorkspaceNavigation()?.phone?.catalog ?? null;
    const { activate: activateTab, close: closeTab } = phoneTabs;
    // A tab this phone cannot show has nowhere to go: it says so where it is, and offers to close it.
    const activate = React.useCallback((tabId: string) => {
        const tab = phoneTabs.tabs.find((item) => item.id === tabId);
        const pane = tab?.panes.find((item) => item.id === tab.activeTabId);
        const href = pane && catalog ? hrefForDestinationRef(catalog, pane.target) : null;
        if (tab && pane && !href) {
            Modal.alert(t('phoneNav.rail.notAvailableTitle'), t('phoneNav.rail.notAvailableUnknown'), [
                { text: t('phoneNav.rail.closeTab'), onPress: () => closeTab(tab.id) },
                { text: t('common.done'), style: 'cancel' },
            ]);
            return;
        }
        activateTab(tabId);
    }, [activateTab, catalog, closeTab, phoneTabs.tabs]);
    const activeTab = phoneTabs.tabs.find((tab) => tab.id === phoneTabs.activeTabId) ?? null;
    const entityDragSource: DocumentTabEntityDragSource | undefined = scope ? {
        runtime, id: dragBindingId, scope, nativeDragAxis: 'vertical',
        isCurrent: () => Boolean(workspace?.phone),
        getItem: tabKey => {
            const tab = phoneTabs.tabs.find(candidate => candidate.id === tabKey);
            if (!tab || tab.unavailable || !workspace?.phone) return null;
            // A desktop pair is one rail entry; carry the pane currently shown on the phone.
            const pane = workspace.state.tabs[tab.activeTabId];
            const href = pane ? hrefForDestinationRef(workspace.phone.catalog, pane.target) : null;
            return href ? resolveWorkspaceDestinationEntityItem({ href, scope, catalog: workspace.phone.catalog }) : null;
        },
    } : undefined;
    if (!phoneTabs.available || items.length < MINIMUM_TABS) return null;
    return (
        <View style={styles.root} testID={PHONE_OPEN_TABS_RAIL_TEST_ID}>
            <DocumentTabStrip
                variant="rail"
                tabs={items}
                activeTabKey={phoneTabs.activeTabId}
                accessibilityLabel={t('phoneNav.rail.label')}
                onActivate={activate}
                onClose={phoneTabs.close}
                onPin={noop}
                onUnpin={noop}
                renderLeadingIcon={renderLeadingIcon}
                entityDragSource={entityDragSource}
                tabNativeId={railTabNativeId}
                railTrailing={trailing}
                testIds={RAIL_TEST_IDS}
            />
            {activeTab && activeTab.panes.length > 1 && catalog ? (
                <PhoneSplitPager tab={activeTab} catalog={catalog} onShowPane={activateTab} />
            ) : null}
        </View>
    );
});

/**
 * A desktop split is one tab on a phone: its panes take turns on screen. The pager names the pane on
 * screen and offers the next one by name (phone-nav lab K, "1 of 2 … Diff ›").
 */
const PhoneSplitPager = React.memo(function PhoneSplitPager(props: Readonly<{
    tab: PhoneWorkspaceTab;
    catalog: WorkspacePhoneControls['catalog'];
    onShowPane: (paneId: string) => void;
}>) {
    const { theme } = useUnistyles();
    const { tab } = props;
    const entries = React.useMemo(() => tab.panes.map((pane) => ({ key: pane.id, ref: pane.target })), [tab.panes]);
    const titles = useDestinationInstanceTitles(props.catalog, entries);
    const index = Math.max(0, tab.panes.findIndex((pane) => pane.id === tab.activeTabId));
    const next = tab.panes[(index + 1) % tab.panes.length];
    const paneName = (pane: typeof next) => {
        if (pane.target.kind === 'session') return t('phoneNav.rail.chatPane');
        const href = hrefForDestinationRef(props.catalog, pane.target);
        return titles.get(pane.id) ?? t(href ? 'common.loading' : 'common.unavailable');
    };
    return (
        <View style={styles.pager}>
            <View style={styles.dots}>
                {tab.panes.map((pane, at) => <View key={pane.id} style={[styles.dot, at === index ? styles.dotOn : null]} />)}
            </View>
            <Text style={styles.pagerPosition}>{t('phoneNav.rail.paneOf', { position: index + 1, total: tab.panes.length })}</Text>
            <Text style={styles.pagerTitle} numberOfLines={1}>{titles.get(tab.panes[index].id) ?? tab.title}</Text>
            <HappierPressable
                style={styles.pagerNext}
                onPress={() => props.onShowPane(next.id)}
                accessibilityRole="button"
                accessibilityLabel={`${t('phoneNav.rail.nextPane')}: ${paneName(next)}`}
            >
                <Text style={styles.pagerNextLabel}>{paneName(next)}</Text>
                <Icon name="caret-right" size={14} color={theme.colors.text.link} />
            </HappierPressable>
        </View>
    );
});

const noop = () => {};
const railTabNativeId = (key: string) => `phone-rail-tab-${key}`;
const RAIL_TEST_IDS = {
    tab: (key: string) => `phone-rail-tab-${key}`,
    tabClose: (key: string) => `phone-rail-tab-close-${key}`,
};

/** A session tab carries the mark its row and header carry: a Bot's face, otherwise its Agent's mark. */
const RailSessionMark = React.memo(function RailSessionMark(props: Readonly<{ sessionId: string; serverId: string | null }>) {
    const { theme } = useUnistyles();
    const session = useSession(props.sessionId, props.serverId);
    const botFace = session ? readSessionBotFaceFacts(session, props.serverId) : null;
    if (botFace) return <SessionBotFace facts={botFace} size={14} />;
    const agentId = session ? readSessionPresentationAgentId(session) ?? '' : '';
    const machineId = session ? readSessionOwnerMetadataView(session)?.machineId ?? null : null;
    return (
        <SessionAgentCatalogIdentityIcon
            agentId={agentId}
            machineId={machineId}
            serverId={props.serverId}
            color={theme.colors.text.primary}
            size={14}
        />
    );
});
