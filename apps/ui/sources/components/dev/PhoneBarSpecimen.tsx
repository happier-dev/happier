import * as React from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CockpitTabBar, CockpitTabBarAction, type CockpitTabBarTabDefinition } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { ChatHeaderView } from '@/components/sessions/transcript/ChatHeaderView';
import { layout } from '@/components/ui/layout/layout';
import { resolveFloatingTabBarSlotCount } from '@/components/ui/navigation/FloatingTabBarSurface';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    resolveSessionCockpitMobileCatalog,
    resolveSessionCockpitMobileTabVisibility,
    type SessionCockpitMobileCatalogEntry,
} from '@/components/workspaceCockpit/session/sessionCockpitMobileCatalog';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useSetting } from '@/sync/domains/state/storage';
import { navigationPlacementsFromLegacyPins } from '@/sync/domains/settings/mobileSurfacePinning';
import { t } from '@/text';

/**
 * Dev-only: the Session bar's width policy (phone-nav lab T) without a live session.
 * Every frame renders the bar primitive from the catalog owner's own decision (`rest`: the defaults;
 * `overflow` / `always`: seven pinned tools), so the account's "Always swipe" setting and this
 * device's pins are never written to stage them.
 */

type Frame = 'rest' | 'overflow' | 'always';

const SEVEN_PINNED: readonly string[] = ['browse', 'git', 'companion', 'terminal', 'navigation', 'services', 'tabs'];

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.base },
    body: { paddingHorizontal: 20, paddingTop: 12, gap: 14 },
    copy: { fontSize: 16, lineHeight: 23, color: theme.colors.text.primary, ...Typography.default() },
    bar: { position: 'absolute', left: 0, right: 0, bottom: 0 },
}));

function tabFor(entry: SessionCockpitMobileCatalogEntry): CockpitTabBarTabDefinition<SessionMobileSurface> {
    if (entry.owner === 'host') {
        if (entry.id === 'chat') {
            return {
                id: 'chat', label: 'Claude',
                icon: { render: ({ size, tintColor }) => <SessionAgentCatalogIdentityIcon agentId="claude" machineId={null} serverId={null} color={tintColor} size={size} /> },
            };
        }
        return entry.id === 'companion'
            ? { id: 'companion', label: t('sessionBoard.companion.title'), icon: 'stack-simple', badge: { kind: 'attention' } }
            : { id: 'tabs', label: t('phoneNav.bar.openFiles'), icon: 'files' };
    }
    return {
        id: entry.id,
        label: entry.tab.owner === 'plugin' ? entry.tab.label : t(entry.tab.labelKey),
        icon: entry.tab.icon,
        ...(entry.id === 'git' ? { badge: { kind: 'count' as const, value: 14 } } : {}),
    };
}

function PinnedBar(props: Readonly<{ alwaysSwipe: boolean; pinned: readonly string[] | null }>) {
    const windowWidth = useWindowDimensions().width;
    const tabMinWidth = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels')).tabMinWidth;
    const catalog = React.useMemo(() => resolveSessionCockpitMobileCatalog({ terminalTabAvailable: true }), []);
    const visibility = resolveSessionCockpitMobileTabVisibility({
        catalog,
        preferences: navigationPlacementsFromLegacyPins(props.pinned),
        slotCount: resolveFloatingTabBarSlotCount({ windowWidth, maxWidth: layout.maxWidth, tabMinWidth }),
        alwaysSwipe: props.alwaysSwipe,
    });
    return (
        <CockpitTabBar
            activeSurface="chat"
            barTestId="phone-bar-specimen"
            tabTestIdPrefix="phone-bar-specimen-tab-"
            tabs={visibility.visible.map(tabFor)}
            layout={visibility.mode === 'scroll' ? 'scroll' : 'fit'}
            onSurfacePress={() => {}}
            trailing={<CockpitTabBarAction testID="phone-bar-specimen-more" label={t('common.more')} icon="dots-three" onPress={() => {}} />}
        />
    );
}

export function PhoneBarSpecimen(props: Readonly<{ frame: string | null }>) {
    const frame: Frame = props.frame === 'overflow' || props.frame === 'always' ? props.frame : 'rest';
    return (
        <View style={styles.root}>
            <ChatHeaderView title="Fix settings modal remount" subtitle="happier · MacBook Pro" onBackPress={() => {}} />
            <ScrollView contentContainerStyle={styles.body}>
                <Text style={styles.copy}>
                    It remounts because SettingsModal’s key includes the window width, so every resize throws its state away.
                </Text>
            </ScrollView>
            <View style={styles.bar}>
                {/* `rest` is the default bar (no pins) as the catalog owner decides it, with the session's
                    agent mark and the Git/Companion badges a live session would carry; the real
                    SessionCockpitTabBar needs a hydrated session record for those, which a fixture has not. */}
                <PinnedBar alwaysSwipe={frame === 'always'} pinned={frame === 'rest' ? null : SEVEN_PINNED} />
            </View>
        </View>
    );
}
