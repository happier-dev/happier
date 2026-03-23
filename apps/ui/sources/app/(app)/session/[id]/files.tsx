import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SessionRightPanel } from '@/components/sessions/panes/SessionRightPanel';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

export default function FilesScreenRoute() {
    const router = useRouter();
    const navigation = useNavigation();
    const isFocused = useIsFocused();
    const { id: sessionIdParam } = useLocalSearchParams<{ id: string }>();
    const sessionId = String(sessionIdParam ?? '').trim();
    const sessionHydrated = useHydrateSessionForRoute(sessionId, 'SessionFilesRoute.ensureSessionVisible');
    const scopeId = React.useMemo(() => `session:${sessionId}`, [sessionId]);
    const pane = useAppPaneScope(scopeId);
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;

    const activeDetailsKey = pane.scopeState?.details?.activeTabKey ?? null;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const detailsTabs = pane.scopeState?.details?.tabs ?? [];
    const lastPushedDetailsKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        lastPushedDetailsKeyRef.current = null;
    }, [sessionId]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (!sessionId) return;
        openRight({ tabId: 'files' });
        if (pane.scopeState?.right?.activeTabId !== 'files') {
            setRightTab('files');
        }
    }, [isFocused, openRight, sessionId, setRightTab, pane.scopeState?.right?.activeTabId]);

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
        <View testID="session-files-screen" style={{ flex: 1 }}>
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
