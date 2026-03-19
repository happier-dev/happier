import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionRightPanel } from '@/components/sessions/panes/SessionRightPanel';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useDeviceType } from '@/utils/platform/responsive';

export default function TerminalScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const { id: sessionIdParam } = useLocalSearchParams<{ id: string }>();
    const sessionId = String(sessionIdParam ?? '').trim();
    const sessionHydrated = useHydrateSessionForRoute(sessionId, 'SessionTerminalRoute.ensureSessionVisible');
    const scopeId = React.useMemo(() => `session:${sessionId}`, [sessionId]);
    const pane = useAppPaneScope(scopeId);
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;

    const deviceType = useDeviceType();
    const terminalEnabled = useFeatureEnabled('terminal.embeddedPty');
    const dockLocationRaw = useLocalSetting('embeddedTerminalDockLocation');
    const dockLocation = deviceType === 'phone' ? 'sidebar' : dockLocationRaw;
    const terminalTabAvailable = terminalEnabled && dockLocation === 'sidebar';

    const activeDetailsKey = pane.scopeState?.details?.activeTabKey ?? null;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const detailsTabs = pane.scopeState?.details?.tabs ?? [];
    const lastPushedDetailsKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        lastPushedDetailsKeyRef.current = null;
    }, [sessionId]);

    // Navigate back if terminal tab is unavailable (feature disabled or docked elsewhere)
    React.useEffect(() => {
        if (!isFocused) return;
        if (!sessionId) return;
        if (!sessionHydrated) return;
        if (!terminalTabAvailable) {
            safeRouterBack({ router, navigation, fallbackHref: `/session/${sessionId}` });
        }
    }, [isFocused, navigation, router, sessionId, sessionHydrated, terminalTabAvailable]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!sessionId) return;
        if (!terminalTabAvailable) return;
        openRight({ tabId: 'terminal' });
        setRightTab('terminal');
    }, [isFocused, openRight, sessionId, setRightTab, terminalTabAvailable]);

    React.useEffect(() => {
        if (!sessionId) return;
        if (!detailsIsOpen) {
            lastPushedDetailsKeyRef.current = null;
            return;
        }
        if (!isFocused) return;
        if (!detailsTabs.length) return;
        const key = typeof activeDetailsKey === 'string' && activeDetailsKey ? activeDetailsKey : detailsTabs.at(-1)?.key ?? null;
        if (!key) return;
        if (lastPushedDetailsKeyRef.current === key) return;
        lastPushedDetailsKeyRef.current = key;
        router.push({
            pathname: '/session/[id]/details',
            params: {
                id: sessionId,
                ...buildActiveDetailsRouteParams(detailsTabs, key),
            },
        } as any);
    }, [activeDetailsKey, detailsIsOpen, detailsTabs, isFocused, router, sessionId]);

    const onRequestClose = React.useCallback(() => {
        closeRight();
        safeRouterBack({ router, navigation, fallbackHref: `/session/${sessionId}` });
    }, [closeRight, navigation, router, sessionId]);

    if (!sessionId) {
        return <SessionInvalidLinkFallback />;
    }

    return (
        <View testID="session-terminal-screen" style={{ flex: 1 }}>
            {sessionHydrated ? (
                <SessionRightPanel sessionId={sessionId} scopeId={scopeId} onRequestClose={onRequestClose} />
            ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator />
                </View>
            )}
        </View>
    );
}
