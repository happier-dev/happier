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
    onMainTabPress: (tab: TabType) => void;
    onSurfacePress: (surface: SessionMobileSurface) => void;
}>;

export function SystemMobileBottomChrome(props: Props) {
    return props.model.kind === 'mainAppTabs'
        ? <MainSystemTabs activeTab={props.model.activeTab} onPress={props.onMainTabPress} />
        : <CockpitSystemTabs model={props.model} openDetailsTabCount={props.openDetailsTabCount} onPress={props.onSurfacePress} />;
}

function nativeBadge(badge: GitTabBadge | Readonly<{ kind: 'dot' }> | undefined): string | undefined {
    if (!badge) return undefined;
    if (badge.kind === 'dot') return '';
    if (badge.kind === 'count') return formatBadgeCount(badge.value);
    if (badge.added === 0 && badge.removed === 0) return formatBadgeCount(badge.modifiedCount, 999);
    return [badge.added > 0 ? `+${formatBadgeCount(badge.added, 999)}` : '', badge.removed > 0 ? `−${formatBadgeCount(badge.removed, 999)}` : ''].filter(Boolean).join(' ');
}

function MainSystemTabs(props: Readonly<{ activeTab: TabType; onPress: (tab: TabType) => void }>) {
    const tabs = useMainTabDefinitions();
    const newSessionPress = useTabBarNewSessionPress();
    const { theme } = useUnistyles();
    const items: SystemTabItem[] = tabs.map(tab => ({ id: tab.key, title: tab.label, sfSymbol: tab.sfSymbol, badge: nativeBadge(tab.badge) }));
    if (props.activeTab === 'sessions') {
        items.push({ id: 'newSession', title: t('newSession.title'), sfSymbol: 'square.and.pencil', action: true });
    }
    const onPress = React.useCallback((id: string) => {
        if (id === 'newSession' && props.activeTab === 'sessions') { newSessionPress(); return; }
        const tab = tabs.find(tab => tab.key === id);
        if (tab) props.onPress(tab.key);
    }, [newSessionPress, props.activeTab, props.onPress, tabs]);
    return <SystemTabBar items={items} selectedId={props.activeTab} hidden={false} tintColor={theme.colors.accent.blue} onPress={onPress} />;
}

function CockpitSystemTabs(props: Readonly<{
    model: Extract<MobileBottomChromeModel, { kind: 'sessionCockpit' }>;
    openDetailsTabCount: number;
    onPress: (surface: SessionMobileSurface) => void;
}>) {
    const tabs = useSessionCockpitTabDefinitions({
        sessionId: props.model.sessionId,
        terminalTabAvailable: props.model.terminalTabAvailable,
        openDetailsTabCount: props.openDetailsTabCount,
    });
    const { theme } = useUnistyles();
    const onPress = React.useCallback((id: string) => {
        const tab = tabs.find(tab => tab.id === id);
        if (tab) props.onPress(tab.id);
    }, [props.onPress, tabs]);
    return <SystemTabBar
        items={tabs.map(tab => ({ id: tab.id, title: tab.label, sfSymbol: tab.sfSymbol, badge: nativeBadge(tab.badge) }))}
        selectedId={props.model.surface}
        hidden={false}
        tintColor={theme.colors.accent.blue}
        onPress={onPress}
    />;
}
