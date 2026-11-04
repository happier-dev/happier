import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Redirect, useIsFocused } from '@/components/appShell/workspace/destinationRoute';

import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { SessionsList } from '@/components/sessions/shell/SessionsList';
import { resolveFocusedSessionListSurfaceOwnership } from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';
import { SessionListLayoutIntentProvider } from '@/hooks/session/sessionListLayoutIntent';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { t } from '@/text';

const stylesheet = StyleSheet.create(() => ({
    root: {
        flex: 1,
    },
}));

const RECENT_SESSIONS_PATHNAME = '/session/recent';

/**
 * Compatibility host for links that predate Recent activity as a list layout.
 *
 * It is a presentation intent, not a preference: the canonical Sessions list renders
 * Recent activity for this visit while the Account's saved layout is untouched, so
 * Back returns to whatever the person last chose in View options and no
 * Session-list, query or settings request is made by opening the link.
 */
export function LegacyRecentSessionsRoute() {
    // Where the Sessions column stands beside the page, a second copy of its list says nothing: the column's own
    // view switch shows Recent activity. Only a phone or a collapsed column needs this page.
    const column = useAppShellColumn();
    if (column.columnVisible) return <Redirect href="/" />;
    return <RecentSessionsPage />;
}

function RecentSessionsPage() {
    useDestinationPageTitle(t('settingsSession.sessionList.layoutRecentActivityTitle'));
    const isFocused = useIsFocused();
    const surfaceOwnership = resolveFocusedSessionListSurfaceOwnership(isFocused);
    const styles = stylesheet;

    return (
        <SessionListLayoutIntentProvider choice="recent_activity">
            <View style={styles.root} testID="recent-sessions-screen">
                <SessionsList
                    pathname={RECENT_SESSIONS_PATHNAME}
                    releaseRetentionOnRouteRemoval
                    surfaceOwnership={surfaceOwnership}
                />
            </View>
        </SessionListLayoutIntentProvider>
    );
}

export { LegacyRecentSessionsRoute as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={LegacyRecentSessionsRoute} />; }
