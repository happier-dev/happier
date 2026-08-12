import * as React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Platform, View } from 'react-native';
import { SessionCommitDetailsView } from '@/components/sessions/files/views/SessionCommitDetailsView';
import { useCanDockSessionPane } from '@/components/sessions/panes/open/useSessionOpenLayout';
import { resolveSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    isSessionRouteHydrationAvailable,
    isSessionRouteHydrationMissing,
} from '@/sync/domains/session/sessionRouteHydrationState';

function decodeSha(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export default function CommitScreen() {
    const router = useRouter();
    const routeParams = useLocalSearchParams<{ id: string; serverId?: string }>();
    const routeScope = createSessionRouteServerScope(routeParams);
    const { id: sessionIdParam } = routeParams;
    const sessionId = sessionIdParam || '';
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionCommitRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const sessionMissingAfterHydration = isSessionRouteHydrationMissing(routeHydrationState);
    const { sha: shaParam } = useLocalSearchParams<{ sha: string }>();
    // Commit refs cannot contain whitespace; accept accidental "oneline" strings by taking the first token.
    const shaRaw = decodeSha(shaParam || '').trim();
    const sha = shaRaw.split(/\s+/)[0] ?? '';

    // One owner for "can this layout dock a details pane", shared with `/file` and the open
    // direction — not a second reading of the device type and the multi-pane setting.
    const canDockDetailsPane = useCanDockSessionPane('details');
    const shouldRedirect = Boolean(sessionId) && Boolean(sha) && canDockDetailsPane;

    const pane = useAppPaneScope(resolveSessionPaneScopeId(sessionId));
    const shouldUseDetailsScreen = Platform.OS !== 'web';
    const hasRedirectedToDetailsRef = React.useRef(false);

    React.useEffect(() => {
        hasRedirectedToDetailsRef.current = false;
    }, [sessionId, sha]);

    React.useEffect(() => {
        if (!shouldRedirect) return;
        if (!sessionHydrated) return;
        pane.openDetailsTab({
            key: `commit:${sha}`,
            kind: 'commit',
            title: sha.slice(0, 7),
            resource: { kind: 'commit', commitHash: sha },
        }, { intent: 'preview' });
        router.replace(routeScope.buildHref(sessionId) as any);
    }, [pane, routeScope, router, sessionHydrated, sessionId, sha, shouldRedirect]);

    React.useEffect(() => {
        if (shouldRedirect) return;
        if (!shouldUseDetailsScreen) return;
        if (hasRedirectedToDetailsRef.current) return;
        if (!sessionHydrated) return;
        if (!sessionId) return;
        if (!sha) return;
        hasRedirectedToDetailsRef.current = true;
        pane.openDetailsTab(
            {
                key: `commit:${sha}`,
                kind: 'commit',
                title: sha.slice(0, 7),
                resource: { kind: 'commit', commitHash: sha },
            },
            { intent: 'preview' },
        );
        router.replace(routeScope.buildHref(sessionId, {
            suffix: '/details',
            query: serializeSessionPaneUrlState({ details: { kind: 'commit', sha } }),
        }) as any);
    }, [pane, routeScope, router, sessionHydrated, sessionId, sha, shouldRedirect, shouldUseDetailsScreen]);

    if (!sessionId || !sha) {
        return <SessionInvalidLinkFallback />;
    }
    if (!sessionHydrated && !sessionMissingAfterHydration) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivitySpinner size="small" />
            </View>
        );
    }
    if (sessionMissingAfterHydration) {
        return <SessionInvalidLinkFallback />;
    }
    if (shouldRedirect) return null;
    if (shouldUseDetailsScreen) return null;
    return <SessionCommitDetailsView sessionId={sessionId} sha={sha} onBack={() => router.back()} />;
}
