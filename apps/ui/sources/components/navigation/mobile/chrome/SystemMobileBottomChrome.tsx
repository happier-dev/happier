import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useTabBarNewSessionPress } from '@/components/ui/navigation/TabBarNewSessionButton';
import { formatBadgeCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { ProjectPageChromeCounts } from '@/components/projects/navigation/ProjectPageChromeCounts';
import { useMainAppTabDefinitions } from './bars/useMainAppTabDefinitions';
import { MainAppTabBar } from './bars/MainAppTabBar';
import { usePhoneDestinationsMore } from '@/components/appShell/destinations/PhoneDestinationsMenu';
import { SessionCockpitTabBar, useSessionCockpitBarPresentation } from './bars/SessionCockpitTabBar';
import { ProjectCockpitTabBar, PROJECT_PHONE_NAVIGATION_ADDRESS, useProjectCockpitBarPresentation, type ProjectNavigationPage } from './bars/ProjectCockpitTabBar';
import { DiscussionCockpitTabBar, useDiscussionCockpitBarPresentation } from './bars/DiscussionCockpitTabBar';
import { MachineCockpitTabBar, machineNavigationTab, useMachineCockpitBarPresentation } from './bars/MachineCockpitTabBar';
import type { CockpitTabBadge } from './bars/CockpitTabBar';
import { detailNavigationTab } from './bars/detailPhoneNavigation';
import { WorkflowCockpitTabBar, useWorkflowCockpitBarPresentation } from '@/components/workflows/navigation/WorkflowNavigationViews';
import { EnvironmentCockpitTabBar, useEnvironmentCockpitBarPresentation } from '@/components/projects/deployments/EnvironmentNavigationViews';
import { PluginDetailCockpitTabBar, usePluginDetailCockpitBarPresentation } from '@/components/plugins/pages/PluginDetailNavigationViews';
import { SystemTabBar, type SystemTabItem, type SystemTabBarSessionNavigationEvent } from './SystemTabBar';
import { useSessionSwitcher } from './lateralSwipe/useSessionSwitcher';
import { useSessionSwitcherInputEnabled } from './lateralSwipe/useSessionSwitcherInputEnabled';
import { resolveSessionSwitcherRelease } from './lateralSwipe/sessionSwitcherGesture';
import { useSetting } from '@/sync/domains/state/storage';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import type { SystemMobileBottomChromeModel } from './systemMobileBottomChromeTypes';
export type { SystemMobileBottomChromeModel } from './systemMobileBottomChromeTypes';

type TabPresentation = Pick<React.ComponentProps<typeof SystemTabBar>, 'items' | 'selectedId' | 'onPress' | 'sessionNavigation'>;
type Publication = Readonly<{ onPresentation: (presentation: TabPresentation) => void }>;

/** Family data owners publish before paint; the sibling native anchor never changes type or position. */
export function SystemMobileBottomChrome(props: Readonly<{ model: SystemMobileBottomChromeModel; hidden: boolean }>) {
    const [presentation, setPresentation] = React.useState<TabPresentation | null>(null);
    const { theme } = useUnistyles();
    const showLabels = useSetting('tabBarShowLabels');
    const model = props.model;
    return <>
        {model.kind === 'mainAppTabs' ? <MainPresentation {...model.props} onPresentation={setPresentation} />
            : model.kind === 'sessionCockpit' ? <SessionPresentation {...model.props} inputHidden={props.hidden} onPresentation={setPresentation} />
                : model.kind === 'projectCockpit' ? <ProjectPresentation {...model.props} onPresentation={setPresentation} />
                    : model.kind === 'machineCockpit' ? <MachinePresentation {...model.props} onPresentation={setPresentation} />
                    : model.kind === 'workflowCockpit' ? <WorkflowPresentation {...model.props} onPresentation={setPresentation} />
                    : model.kind === 'environmentCockpit' ? <EnvironmentPresentation {...model.props} onPresentation={setPresentation} />
                    : model.kind === 'pluginCockpit' ? <PluginDetailPresentation {...model.props} onPresentation={setPresentation} />
                    : <DiscussionPresentation {...model.props} onPresentation={setPresentation} />}
        {presentation ? <SystemTabBar {...presentation} showLabels={showLabels} hidden={props.hidden} tintColor={theme.colors.accent.blue} /> : null}
    </>;
}

function nativeBadge(badge: CockpitTabBadge | Readonly<{ kind: 'dot' }> | undefined): string | undefined {
    if (!badge) return undefined;
    if (badge.kind === 'dot' || badge.kind === 'attention') return '';
    if (badge.kind === 'count') return formatBadgeCount(badge.value);
    if (badge.kind === 'text') return badge.value;
    if (badge.added === 0 && badge.removed === 0) return formatBadgeCount(badge.changedFileCount, 999);
    return [badge.added > 0 ? `+${formatBadgeCount(badge.added, 999)}` : '', badge.removed > 0 ? `−${formatBadgeCount(badge.removed, 999)}` : ''].filter(Boolean).join(' ');
}

// A publication re-renders the parent, not its unchanged active producer. Inactive families never subscribe.
const MainPresentation = React.memo(function MainPresentation(props: React.ComponentProps<typeof MainAppTabBar> & Publication) {
    const tabs = useMainAppTabDefinitions();
    const newSessionPress = useTabBarNewSessionPress();
    // The bar's own tabs are placements too: More lists them, and only the placed ones (or the open one) ride UIKit.
    const activeId = props.selectedDestinationId ?? props.activeTab;
    const main = React.useMemo(() => ({ activeId, onTabPress: props.onTabPress }), [activeId, props.onTabPress]);
    const more = usePhoneDestinationsMore({ native: true, main });
    const placedTabs = React.useMemo(() => tabs.filter(tab => more.bar.mainTabKeys.includes(tab.key)), [tabs, more.bar.mainTabKeys]);
    React.useLayoutEffect(() => {
        const items: SystemTabItem[] = placedTabs.map(tab => ({ id: tab.key, title: tab.label, sfSymbol: tab.sfSymbol,
            accessibilityLabel: tab.accessibilityLabel, badge: nativeBadge(tab.badge) }));
        items.push(...more.bar.tabs.map(tab => ({ id: tab.id, title: tab.label, sfSymbol: tab.sfSymbol,
            accessibilityLabel: tab.unavailableReason ? `${tab.label}, ${tab.unavailableReason}` : tab.accessibilityLabel ?? tab.label,
            disabled: tab.disabled, badge: nativeBadge(tab.badge) })));
        if (more.available) items.push({ id: 'more', title: t('common.more'), sfSymbol: 'ellipsis', action: true });
        const destinationId = props.selectedDestinationId ?? props.activeTab;
        const selectedId = items.some(item => item.id === destinationId) ? destinationId : 'more';
        if (selectedId === 'sessions') items.push({ id: 'newSession', title: t('newSession.title'), sfSymbol: 'square.and.pencil', action: true });
        props.onPresentation({ items, selectedId, onPress: id => {
            if (id === 'newSession' && selectedId === 'sessions') { newSessionPress(); return; }
            if (id === 'more') { more.open(); return; }
            const tab = tabs.find(tab => tab.key === id);
            if (tab) props.onTabPress(tab.key);
            else more.bar.onPress(id);
        } });
    }, [tabs, placedTabs, newSessionPress, more.available, more.open, more.bar.tabs, more.bar.onPress, props.activeTab, props.selectedDestinationId, props.onTabPress, props.onPresentation]);
    return more.menu;
});

const SessionPresentation = React.memo(function SessionPresentation(props: React.ComponentProps<typeof SessionCockpitTabBar> & Publication & Readonly<{ inputHidden: boolean }>) {
    const switcher = useSessionSwitcher({ sessionId: props.sessionId, serverId: props.serverId ?? null });
    const inputEnabled = useSessionSwitcherInputEnabled() && !props.inputHidden;
    const sidewaysEnabled = useSetting('sessionCockpitSwipeNavigationEnabled') === true;
    const onNavigate = React.useCallback((event: SystemTabBarSessionNavigationEvent) => {
        if (!inputEnabled) return;
        if (event.source === 'swipe') {
            if (!sidewaysEnabled) return;
            // UIKit reports the stroke; the band's existing release policy decides whether it lands.
            const release = resolveSessionSwitcherRelease({ ...event, phase: 'side', index: 0,
                scrubbed: false, velocityY: 0, flickEnabled: false, cancelled: false });
            if (release.kind !== 'open') return;
        }
        if (!switcher.step(event.direction)) {
            announceAccessibilityMessage(t(event.direction === 'next' ? 'phoneNav.switcher.noOlderSessions' : 'phoneNav.switcher.noNewerSessions'));
        }
    }, [inputEnabled, sidewaysEnabled, switcher.step]);
    const sessionNavigation = React.useMemo(() => ({ swipeEnabled: inputEnabled && sidewaysEnabled,
        labels: inputEnabled ? { previous: t('workspaceCockpit.previousSession'), next: t('workspaceCockpit.nextSession') } : null,
        onNavigate,
    }), [inputEnabled, sidewaysEnabled, onNavigate]);
    const { visibility, tabForEntry, menu, openMore, pageTabs } = useSessionCockpitBarPresentation(props, true);
    // UIKit owns available rail capacity. User-hidden entries stay hidden; pinned and overflow keep their canonical order.
    const topMode = pageTabs === 'top';
    // The open tool from More already rides the visible items; UIKit lists every overflow tool once.
    const tabs = [...visibility.visible, ...(topMode ? [] : visibility.overflow.filter(entry => !visibility.visible.includes(entry)))].map(tabForEntry);
    React.useLayoutEffect(() => {
        const items: SystemTabItem[] = tabs.map(tab => ({ id: tab.id, title: tab.label, sfSymbol: tab.sfSymbol,
            accessibilityLabel: tab.accessibilityLabel, badge: nativeBadge(tab.badge), disabled: tab.disabled }));
        if (topMode) items.push({ id: 'more', title: t('common.more'), sfSymbol: 'ellipsis', action: true });
        props.onPresentation({ items, sessionNavigation,
        selectedId: props.activeSurface, onPress: id => {
            if (topMode && id === 'more') { openMore(); return; }
            const tab = tabs.find(tab => tab.id === id);
            if (tab && !tab.disabled) props.onSurfacePress(tab.id);
        } });
    }, [tabs, topMode, openMore, props.activeSurface, props.onSurfacePress, props.onPresentation, sessionNavigation]);
    return topMode ? menu : null;
});

const ProjectPresentation = React.memo(function ProjectPresentation(props: React.ComponentProps<typeof ProjectCockpitTabBar> & Publication) {
    const { preferences } = useNavigationSurfacePlacement(PROJECT_PHONE_NAVIGATION_ADDRESS);
    return props.countScope ? <ProjectPageChromeCounts {...props.countScope} pages={props.pages} preferences={preferences}>
        {pages => <ProjectPresentationContent {...props} pages={pages} />}
    </ProjectPageChromeCounts> : <ProjectPresentationContent {...props} />;
});

function ProjectPresentationContent(props: Omit<React.ComponentProps<typeof ProjectCockpitTabBar>, 'pages'> & Publication & Readonly<{ pages: readonly ProjectNavigationPage[] }>) {
    const presentation = useProjectCockpitBarPresentation(props, true);
    const tabs = presentation.shown.map(presentation.tabForPage);
    React.useLayoutEffect(() => {
        props.onPresentation({ items: [...tabs.map(tab => ({ id: tab.id, title: tab.label, sfSymbol: tab.sfSymbol,
            accessibilityLabel: tab.accessibilityLabel, disabled: tab.disabled })),
            { id: 'more', title: t('common.more'), sfSymbol: 'ellipsis', action: true }],
            selectedId: presentation.shown.some(item => item.id === presentation.activeId) ? presentation.activeId
                : presentation.behindMore.some(item => item.id === presentation.activeId) ? 'more' : '', onPress: id => {
                if (id === 'more') presentation.openMore(); else presentation.select(id);
            } });
    }, [tabs, presentation.activeId, presentation.openMore, presentation.select, props.onPresentation]);
    return presentation.menu;
}

const DiscussionPresentation = React.memo(function DiscussionPresentation(props: React.ComponentProps<typeof DiscussionCockpitTabBar> & Publication) {
    const presentation = useDiscussionCockpitBarPresentation(props, true);
    const tabs = presentation.shown.map(presentation.tabForItem);
    React.useLayoutEffect(() => {
        props.onPresentation({ items: [...tabs.map(tab => ({ id: tab.id, title: tab.label, sfSymbol: tab.sfSymbol,
            disabled: tab.disabled })), { id: 'more', title: t('common.more'), sfSymbol: 'ellipsis', action: true }],
            selectedId: presentation.shown.some(item => item.id === presentation.activeId) ? props.activeSurface
                : presentation.behindMore.some(item => item.id === presentation.activeId) ? 'more' : '', onPress: id => {
                if (id === 'more') presentation.openMore(); else presentation.select(id);
            } });
    }, [tabs, props.activeSurface, presentation.activeId, presentation.openMore, presentation.select, props.onPresentation]);
    return presentation.menu;
});

const MachinePresentation = React.memo(function MachinePresentation(props: React.ComponentProps<typeof MachineCockpitTabBar> & Publication) {
    const presentation = useMachineCockpitBarPresentation(props, true);
    const tabs = presentation.shown.map(machineNavigationTab);
    React.useLayoutEffect(() => {
        props.onPresentation({ items: [...tabs.map(tab => ({ id: tab.id, title: tab.label, sfSymbol: tab.sfSymbol,
            disabled: tab.disabled })), { id: 'more', title: t('common.more'), sfSymbol: 'ellipsis', action: true }],
            selectedId: presentation.shown.some(item => item.id === props.activeId) ? props.activeId
                : presentation.behindMore.some(item => item.id === props.activeId) ? 'more' : '', onPress: id => {
                if (id === 'more') presentation.openMore(); else props.onSelect(id);
            } });
    }, [tabs, props.activeId, presentation.openMore, props.onSelect, props.onPresentation]);
    return presentation.menu;
});

const WorkflowPresentation = React.memo(function WorkflowPresentation(props: React.ComponentProps<typeof WorkflowCockpitTabBar> & Publication) {
    const presentation = useWorkflowCockpitBarPresentation(props, true);
    const activeId = props.model.sideId ?? props.model.activeId;
    usePublishDetailPresentation(presentation, activeId, props.onSelect, props.onPresentation);
    return presentation.menu;
});

const EnvironmentPresentation = React.memo(function EnvironmentPresentation(props: React.ComponentProps<typeof EnvironmentCockpitTabBar> & Publication) {
    const presentation = useEnvironmentCockpitBarPresentation(props, true);
    usePublishDetailPresentation(presentation, props.model.activeId, props.onSelect, props.onPresentation);
    return presentation.menu;
});

const PluginDetailPresentation = React.memo(function PluginDetailPresentation(props: React.ComponentProps<typeof PluginDetailCockpitTabBar> & Publication) {
    const presentation = usePluginDetailCockpitBarPresentation(props, true);
    usePublishDetailPresentation(presentation, props.model.activeId, props.onSelect, props.onPresentation);
    return presentation.menu;
});

/** The same More/selection projection serves each detail kind's native presenter. */
function usePublishDetailPresentation(
    presentation: Pick<ReturnType<typeof useEnvironmentCockpitBarPresentation>, 'shown' | 'behindMore' | 'openMore'>,
    activeId: string,
    onSelect: (id: string) => void,
    onPresentation: Publication['onPresentation'],
) {
    const tabs = presentation.shown.map(detailNavigationTab);
    React.useLayoutEffect(() => {
        onPresentation({ items: [...tabs.map(tab => ({ id: tab.id, title: tab.label, sfSymbol: tab.sfSymbol,
            disabled: tab.disabled })), { id: 'more', title: t('common.more'), sfSymbol: 'ellipsis', action: true }],
            selectedId: presentation.shown.some(item => item.id === activeId) ? activeId
                : presentation.behindMore.some(item => item.id === activeId) ? 'more' : '', onPress: id => {
                if (id === 'more') presentation.openMore(); else onSelect(id);
            } });
    }, [tabs, activeId, presentation.openMore, onSelect, onPresentation]);
}
