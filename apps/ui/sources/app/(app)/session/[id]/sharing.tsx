import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import { readCurrentRouteAddress } from '@/components/appShell/workspace/currentRouteLocation';
import { matchWorkspaceDestinationRoute } from '@/components/appShell/workspace/workspaceRoutes';
import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { useOpenSessionCollaboration } from '@/components/sessions/collaboration/useOpenSessionCollaboration';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';

/**
 * The released `/session/:id/sharing` deep link, reduced to a scope-preserving
 * host.
 *
 * Every responsibility this page used to own — access reads and mutations,
 * recipient keys, publication, external materialization, and their scope and
 * modal lifecycles — now belongs to the canonical Collaboration surface and its
 * children. The route therefore holds no sharing state and does not hydrate the
 * Session: the Session root is the one hydration and authorization owner, and a
 * second hydration here would only add latency and a competing decision.
 *
 * An unqualified released link stays unqualified so the Session root resolves
 * its Home exactly as it does for every other entry point.
 */
export function SessionSharingCompatibilityRoute() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ id: string; serverId?: string; shareDirectory?: string }>();
    const sessionId = normalizeSessionId(params.id);
    const serverId = readSessionRouteServerId(params);
    const target = React.useMemo(
        () => (sessionId ? { sessionId, serverId } : null),
        [sessionId, serverId],
    );
    const openCollaboration = useOpenSessionCollaboration({
        target, replace: true, focusTarget: 'access',
        shareDirectory: params.shareDirectory === 'team' ? 'team' : undefined,
    });

    React.useEffect(() => {
        if (!target) return;
        // Expo can briefly render its stale Share scene as the browser leaves
        // the workspace. Only the live link may request this redirect.
        const address = readCurrentRouteAddress();
        if (address) {
            const route = matchWorkspaceDestinationRoute(address.pathname);
            if (route?.routeKey !== 'session/[id]/sharing' || normalizeSessionId(route.params.id) !== target.sessionId) return;
        }
        openCollaboration();
    }, [openCollaboration, target]);

    if (!sessionId) return <SessionInvalidLinkFallback />;

    return (
        <View testID="session-sharing-redirect" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
        </View>
    );
}

export { SessionSharingCompatibilityRoute as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionSharingCompatibilityRoute} />; }
