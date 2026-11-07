import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { SessionFileDetailsView } from '@/components/sessions/files/views/SessionFileDetailsView';
import { resolveSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import {
    isSessionRouteHydrationAvailable,
    isSessionRouteHydrationMissing,
} from '@/sync/domains/session/sessionRouteHydrationState';

import { parseSessionFileWindowParams } from './sessionFileWindowRoute';

/**
 * A window that shows one session file across its whole width ("Open in new window"). It is a
 * second instance of the app on the `/file-window` route; the layouts leave out the sidebar and the
 * main-window-only runtimes for it.
 */
export function SessionFileWindowScreen(): React.ReactElement {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const target = React.useMemo(() => parseSessionFileWindowParams(params), [params]);
    const sessionId = target?.sessionId ?? '';
    const hydrationOptions = React.useMemo(
        () => (target?.serverId ? { serverId: target.serverId } : undefined),
        [target?.serverId],
    );
    const hydrationState = useHydrateSessionForRoute(sessionId, 'SessionFileWindow.ensureSessionVisible', hydrationOptions);
    const title = target?.path.split('/').at(-1) ?? '';

    let body: React.ReactElement;
    if (!target || isSessionRouteHydrationMissing(hydrationState)) {
        body = <SessionInvalidLinkFallback />;
    } else if (!isSessionRouteHydrationAvailable(hydrationState)) {
        body = (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivitySpinner size="small" />
            </View>
        );
    } else {
        body = (
            <SessionFileDetailsView
                sessionId={target.sessionId}
                scopeId={resolveSessionPaneScopeId(target.sessionId)}
                filePath={target.path}
                presentation="window"
            />
        );
    }

    return (
        <View testID="session-file-window" style={{ flex: 1, backgroundColor: theme.colors.surface.base }}>
            <Stack.Screen options={{ headerShown: false, title }} />
            {body}
        </View>
    );
}
