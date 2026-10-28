import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useMainTabDefinitions } from '@/components/ui/navigation/useMainTabDefinitions';
import { useTabBarNewSessionPress } from '@/components/ui/navigation/TabBarNewSessionButton';
import { formatBadgeCount, type GitTabBadge } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useSessionCockpitTabDefinitions } from './bars/useSessionCockpitTabDefinitions';
import type { MobileBottomChromeModel } from './mobileBottomChromeTypes';
import { SystemTabBar, type SystemTabItem } from './SystemTabBar';

type Props = Readonly<{
    model: Exclude<MobileBottomChromeModel, { kind: 'hidden' }>;
    openDetailsTabCount: number;
    hidden: boolean;
    onMainTabPress: (tab: TabType) => void;
    onSurfacePress: (surface: SessionMobileSurface) => void;
}>;

type TabPresentation = Pick<React.ComponentProps<typeof SystemTabBar>, 'items' | 'selectedId' | 'onPress'>;

export function SystemMobileBottomChrome(props: Props) {
    const [presentation, setPresentation] = React.useState<TabPresentation | null>(null);
    const { theme } = useUnistyles();
    // Only the active family subscribes to its definitions. It publishes before paint;
    // the sibling native anchor stays mounted even when that family changes.
    return <>
        {props.model.kind === 'mainAppTabs'
            ? <MainTabPresentation activeTab={props.model.activeTab} onPress={props.onMainTabPress} onPresentation={setPresentation} />
            : <CockpitTabPresentation model={props.model} openDetailsTabCount={props.openDetailsTabCount} onPress={props.onSurfacePress} onPresentation={setPresentation} />}
        {presentation ? <SystemTabBar {...presentation} hidden={props.hidden} tintColor={theme.colors.accent.blue} /> : null}
    </>;
}

function nativeBadge(badge: GitTabBadge | Readonly<{ kind: 'dot' }> | undefined): string | undefined {
    if (!badge) return undefined;
    if (badge.kind === 'dot') return '';
    if (badge.kind === 'count') return formatBadgeCount(badge.value);
    if (badge.added === 0 && badge.removed === 0) return formatBadgeCount(badge.modifiedCount, 999);
    return [badge.added > 0 ? `+${formatBadgeCount(badge.added, 999)}` : '', badge.removed > 0 ? `−${formatBadgeCount(badge.removed, 999)}` : ''].filter(Boolean).join(' ');
}

// Memoization prevents the presentation publication from re-running its producer.
const MainTabPresentation = React.memo(function MainTabPresentation(props: Readonly<{
    activeTab: TabType;
    onPress: (tab: TabType) => void;
    onPresentation: (presentation: TabPresentation) => void;
}>) {
    const tabs = useMainTabDefinitions();
    const newSessionPress = useTabBarNewSessionPress();
    const items: SystemTabItem[] = tabs.map(tab => ({ id: tab.key, title: tab.label, sfSymbol: tab.sfSymbol, badge: nativeBadge(tab.badge) }));
    if (props.activeTab === 'sessions') {
        items.push({ id: 'newSession', title: t('newSession.title'), sfSymbol: 'square.and.pencil', action: true });
    }
    const onPress = React.useCallback((id: string) => {
        if (id === 'newSession' && props.activeTab === 'sessions') { newSessionPress(); return; }
        const tab = tabs.find(tab => tab.key === id);
        if (tab) props.onPress(tab.key);
    }, [newSessionPress, props.activeTab, props.onPress, tabs]);
    React.useLayoutEffect(() => {
        props.onPresentation({ items, selectedId: props.activeTab, onPress });
    }, [items, onPress, props.activeTab, props.onPresentation]);
    return null;
});

const CockpitTabPresentation = React.memo(function CockpitTabPresentation(props: Readonly<{
    model: Extract<MobileBottomChromeModel, { kind: 'sessionCockpit' }>;
    openDetailsTabCount: number;
    onPress: (surface: SessionMobileSurface) => void;
    onPresentation: (presentation: TabPresentation) => void;
}>) {
    const tabs = useSessionCockpitTabDefinitions({
        sessionId: props.model.sessionId,
        terminalTabAvailable: props.model.terminalTabAvailable,
        openDetailsTabCount: props.openDetailsTabCount,
    });
    const onPress = React.useCallback((id: string) => {
        const tab = tabs.find(tab => tab.id === id);
        if (tab) props.onPress(tab.id);
    }, [props.onPress, tabs]);
    React.useLayoutEffect(() => {
        props.onPresentation({
            items: tabs.map(tab => ({ id: tab.id, title: tab.label, sfSymbol: tab.sfSymbol, badge: nativeBadge(tab.badge) })),
            selectedId: props.model.surface,
            onPress,
        });
    }, [tabs, onPress, props.model.surface, props.onPresentation]);
    return null;
});
