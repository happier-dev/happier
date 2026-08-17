import * as React from 'react';
import { Platform } from 'react-native';

import { DEFAULT_AGENT_ID, getAgentCore } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { useLocalSettingMutable, useSession, useSessionProjectScmStatus, useSetting } from '@/sync/domains/state/storage';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { resolveGitTabBadge } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import {
    resolveSessionCockpitMobileCatalog,
    resolveSessionCockpitMobileTabVisibility,
    type SessionCockpitMobileCatalogEntry,
} from '@/components/workspaceCockpit/session/sessionCockpitMobileCatalog';
import { toggleSessionCockpitPinnedSurface } from '@/sync/domains/settings/mobileSurfacePinning';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import {
    CockpitTabBar,
    CockpitTabBarAction,
    type CockpitTabBarTabDefinition,
} from './CockpitTabBar';

type SessionCockpitTabBarProps = Readonly<{
    sessionId: string;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
    pluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    projectionGeneration?: number | null;
    onSurfacePress: (surface: SessionMobileSurface) => void;
}>;

type SessionCockpitTabDefinition = Readonly<{
    id: SessionMobileSurface;
    label: string;
    icon: CockpitTabBarTabDefinition<SessionMobileSurface>['icon'];
    badge?: CockpitTabBarTabDefinition<SessionMobileSurface>['badge'];
}>;

export const SessionCockpitTabBar = React.memo((props: SessionCockpitTabBarProps) => {
    const session = useSession(props.sessionId);
    const scmStatus = useSessionProjectScmStatus(props.sessionId);
    const gitBadgeMode = useSetting('tabBarGitBadgeMode');
    const openTabsBadgeEnabled = useSetting('tabBarOpenTabsBadgeEnabled');
    const [pinnedSurfaceIds, setPinnedSurfaceIds] = useLocalSettingMutable('sessionCockpitPinnedSurfaceIds');
    const [moreOpen, setMoreOpen] = React.useState(false);
    const agentId = React.useMemo(
        () => (session ? readSessionPresentationAgentId(session) : null) ?? DEFAULT_AGENT_ID,
        [session],
    );
    const gitBadge = resolveGitTabBadge(gitBadgeMode, scmStatus);
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

    const catalog = React.useMemo(() => resolveSessionCockpitMobileCatalog({
        terminalTabAvailable: props.terminalTabAvailable,
        pluginPlacements: props.pluginPlacements,
        projectionGeneration: props.projectionGeneration,
    }), [props.pluginPlacements, props.projectionGeneration, props.terminalTabAvailable]);
    const visibility = React.useMemo(() => resolveSessionCockpitMobileTabVisibility({
        catalog,
        pinnedSurfaceIds: [
            ...(pinnedSurfaceIds ?? []),
            ...(props.activeSurface === 'chat' ? [] : [props.activeSurface]),
        ],
    }), [catalog, pinnedSurfaceIds, props.activeSurface]);
    const tabForEntry = (entry: SessionCockpitMobileCatalogEntry): SessionCockpitTabDefinition => {
        if (entry.owner === 'host') {
            if (entry.id === 'chat') {
                return {
                    id: 'chat',
                    label: t(getAgentCore(agentId).displayNameKey),
                    icon: {
                        render: ({ active, size }) => (
                            <AgentIcon
                                agentId={agentId}
                                size={size}
                                style={{ opacity: active ? 1 : 0.68 }}
                                testID="session-cockpit-tab-chat-agent-icon"
                            />
                        ),
                    },
                };
            }
            return {
                id: 'tabs',
                label: t('common.tabs'),
                icon: 'stack',
                badge: openTabsBadgeEnabled && props.openDetailsTabCount > 0
                    ? { kind: 'count', value: props.openDetailsTabCount }
                    : undefined,
            };
        }
        const tab = entry.tab;
        return {
            id: entry.id,
            label: tab.owner === 'plugin' ? tab.label : t(tab.labelKey),
            icon: tab.icon,
            ...(entry.id === 'git' && gitBadge ? { badge: gitBadge } : {}),
        };
    };
    const tabs = visibility.visible.map(tabForEntry);
    const menuEntries = React.useMemo(() => {
        const result = [...visibility.overflow];
        for (const entry of visibility.visible) {
            if (entry.owner !== 'rightSidebar' || entry.tab.owner !== 'plugin') continue;
            if (!result.some((candidate) => candidate.id === entry.id)) result.push(entry);
        }
        return result;
    }, [visibility.overflow, visibility.visible]);
    const menuItems: readonly DropdownMenuItem[] = menuEntries.map((entry) => {
        const tab = tabForEntry(entry);
        const pluginEntry = entry.owner === 'rightSidebar' && entry.tab.owner === 'plugin';
        const pinned = pinnedSurfaceIds?.includes(entry.id) === true;
        return {
            id: entry.id,
            testID: `session-cockpit-more-item:${entry.id}`,
            title: tab.label,
            icon: <Icon name={typeof tab.icon === 'string' ? tab.icon : 'puzzle-piece'} size={18} />,
            ...(pluginEntry ? {
                rightElement: (
                    <IconButton
                        testID={`session-cockpit-pin:${entry.id}`}
                        accessibilityLabel={t(pinned ? 'projects.actions.unpin' : 'projects.actions.pin')}
                        tooltip={t(pinned ? 'projects.actions.unpin' : 'projects.actions.pin')}
                        iconName="push-pin"
                        iconSize={16}
                        minimumInteractiveTargetSize={minimumInteractiveTargetSize}
                        accessibilityRole="checkbox"
                        checked={pinned}
                        selected={pinned}
                        size={28}
                        variant="plain"
                        onPress={(event) => {
                            event?.stopPropagation?.();
                            setPinnedSurfaceIds([...toggleSessionCockpitPinnedSurface(pinnedSurfaceIds, entry.id)]);
                        }}
                    />
                ),
            } : {}),
        };
    });

    return (
        <CockpitTabBar
            activeSurface={props.activeSurface}
            barTestId={`session-cockpit-tabbar-${props.sessionId}`}
            tabs={tabs}
            tabTestIdPrefix="session-cockpit-tab-"
            onSurfacePress={props.onSurfacePress}
            trailing={menuItems.length > 0 ? (
                <DropdownMenu
                    open={moreOpen}
                    onOpenChange={setMoreOpen}
                    items={menuItems}
                    selectedId={menuItems.some((item) => item.id === props.activeSurface) ? props.activeSurface : null}
                    onSelect={(surface) => {
                        setMoreOpen(false);
                        props.onSurfacePress(surface as SessionMobileSurface);
                    }}
                    matchTriggerWidth={false}
                    placement="top"
                    trigger={({ open, toggle }) => (
                        <CockpitTabBarAction
                            testID="session-cockpit-tab-more"
                            label={t('common.more')}
                            icon="dots-three"
                            expanded={open}
                            onPress={toggle}
                        />
                    )}
                />
            ) : null}
        />
    );
});
