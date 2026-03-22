import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import {
    SessionExecutionRunDetailsView,
    type SessionExecutionRunDetailsViewHandle,
} from '@/components/sessions/runs/details/SessionExecutionRunDetailsView';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

function normalizeParam(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) return value[0].trim();
    return null;
}

export default function SessionRunDetailsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams();
    const sessionId = normalizeParam((params as Record<string, unknown>)?.id);
    const runId = normalizeParam((params as Record<string, unknown>)?.runId);
    const hydrateReady = useHydrateSessionForRoute(sessionId ?? '', 'SessionRunDetailsScreen.hydrate');
    const detailsRef = React.useRef<SessionExecutionRunDetailsViewHandle | null>(null);
    const headerTint = theme.colors.header?.tint ?? theme.colors.text;
    const parentSessionHref = sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/session';

    const headerRight = React.useCallback(() => (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('runs.runDetails.a11y.refreshRun')}
            onPress={() => {
                void detailsRef.current?.reload();
            }}
            testID="session-run-details-refresh"
            hitSlop={10}
            style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.7 : 1 })}
        >
            <Ionicons name="refresh" size={20} color={headerTint} />
        </Pressable>
    ), [headerTint]);

    const headerLeft = React.useCallback(() => (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
            onPress={() => safeRouterBack({
                router,
                navigation,
                fallbackHref: parentSessionHref,
            })}
            testID="session-run-details-back"
            hitSlop={10}
            style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.7 : 1 })}
        >
            <Ionicons name="arrow-back" size={20} color={headerTint} />
        </Pressable>
    ), [headerTint, navigation, parentSessionHref, router]);

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        headerTitle: runId ? t('runs.runLabel', { runId }) : t('runs.title'),
        headerLeft,
        headerRight,
    }), [headerLeft, headerRight, runId]);

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.groupped?.background ?? theme.colors.surface }}>
            <Stack.Screen options={screenOptions} />
            {!hydrateReady ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            ) : !sessionId || !runId ? (
                <SessionInvalidLinkFallback />
            ) : (
                <SessionExecutionRunDetailsView
                    ref={detailsRef}
                    sessionId={sessionId}
                    runId={runId}
                    presentation="screen"
                />
            )}
        </View>
    );
}
