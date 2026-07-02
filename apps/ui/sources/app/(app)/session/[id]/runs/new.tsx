import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { Text } from '@/components/ui/text/Text';
import { SessionExecutionRunLauncherView } from '@/components/sessions/runs/launcher/SessionExecutionRunLauncherView';
import { resolveExecutionRunLauncherIntent } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

export default function SessionNewRunScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[]; intent?: string | string[] }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
    const sessionId = normalizeSessionId(params.id);
    const routeHydrationState = useHydrateSessionForRoute(sessionId, 'SessionNewRunScreen.hydrate', routeScope.hydrationOptions);
    const hydrateReady = isSessionRouteHydrationAvailable(routeHydrationState);
    const rawIntent = params.intent;
    const hasIntentParam = rawIntent !== undefined;
    const initialIntent = resolveExecutionRunLauncherIntent(rawIntent);
    const launcherIntent = initialIntent ?? 'review';
    const parentSessionHref = sessionId ? routeScope.buildHref(sessionId) : '/session';

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        headerTitle: t('executionRuns.newRun.headerTitle'),
        headerBackTitle: t('common.back'),
    }), []);
    const handleRequestClose = React.useCallback(() => {
        safeRouterBack({
            router,
            navigation,
            fallbackHref: parentSessionHref,
        });
    }, [navigation, parentSessionHref, router]);

    if (hasIntentParam && initialIntent === null) {
        return (
            <View style={{ flex: 1, backgroundColor: theme.colors.background?.canvas ?? theme.colors.surface.base }}>
                <Stack.Screen options={screenOptions} />
                <ConstrainedScreenContent
                    style={{
                        flex: 1,
                        paddingHorizontal: 16,
                        paddingVertical: 16,
                        gap: 16,
                    }}
                >
                    <Text style={{ color: theme.colors.text.secondary }}>{t('errors.invalidFormat')}</Text>
                </ConstrainedScreenContent>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.background?.canvas ?? theme.colors.surface.base }}>
            <Stack.Screen options={screenOptions} />
            <ConstrainedScreenContent
                style={{
                    flex: 1,
                    paddingHorizontal: 16,
                    paddingVertical: 16,
                    gap: 16,
                }}
            >
                {!sessionId || isSessionRouteHydrationMissing(routeHydrationState) ? (
                    <Text style={{ color: theme.colors.text.primary }}>{t('errors.sessionDeleted')}</Text>
                ) : !hydrateReady ? (
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                ) : (
                    <SessionExecutionRunLauncherView
                        sessionId={sessionId}
                        routeHydrationState={routeHydrationState}
                        initialIntent={launcherIntent}
                        presentation="screen"
                        onRequestClose={handleRequestClose}
                    />
                )}
            </ConstrainedScreenContent>
        </View>
    );
}
