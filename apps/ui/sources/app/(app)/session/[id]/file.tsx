import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Platform, View, useWindowDimensions } from 'react-native';
import { decodeSessionFilePathParam } from '@/scm/utils/filePathParam';
import { parseSessionFileDeepLinkAnchor, readWorkspaceFileLinkView } from '@/utils/url/sessionFileDeepLink';
import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';
import { SessionFileDetailsView } from '@/components/sessions/files/views/SessionFileDetailsView';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { shouldRedirectDetailsRouteToPanes } from '@/components/ui/panels/shouldRedirectDetailsRouteToPanes';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useDestinationPaneScopeId, useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';

export function FileScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ id: string; serverId?: string; path: string }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const sessionId = normalizeSessionId(params.id);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionFileRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const decodedFilePath = decodeSessionFilePathParam(params.path as string);
    const filePath = isSafeWorkspaceRelativePath(decodedFilePath) ? decodedFilePath.trim() : '';
    useDestinationPageTitle(filePath.split('/').at(-1));
    const isUnsafeFilePath = Boolean(decodedFilePath) && !filePath;
    const deepLinkAnchor = React.useMemo(
        () => parseSessionFileDeepLinkAnchor(params as Record<string, string | string[] | undefined>),
        [params]
    );
    const initialView = React.useMemo(() => readWorkspaceFileLinkView(params), [params]);

    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled');
    const arrangement = useLocalSetting('paneArrangement');
    const deviceType = useDeviceType();
    const { width: containerWidthPx } = useWindowDimensions();
    const shouldRedirect =
        Boolean(sessionId)
        && Boolean(filePath)
        && sessionHydrated
        && shouldRedirectDetailsRouteToPanes({ containerWidthPx, deviceType, multiPaneEnabled, arrangement });

    const scopeId = useDestinationPaneScopeId(createSessionPaneScopeId(sessionId, routeScope.serverId));
    const pane = useAppPaneScope(scopeId);

    const shouldUseDetailsScreen = Platform.OS !== 'web';
    const hasRedirectedToDetailsRef = React.useRef(false);

    React.useEffect(() => {
        hasRedirectedToDetailsRef.current = false;
    }, [filePath, sessionId]);

    React.useEffect(() => {
        if (!isUnsafeFilePath) return;
        if (!sessionId) return;
        router.replace({ pathname: '/session/[id]', params: routeScope.withParams({ id: sessionId }) } as any);
    }, [isUnsafeFilePath, routeScope, router, sessionId]);

    React.useEffect(() => {
        if (!shouldRedirect) return;
        pane.openDetailsTab(createWorkspaceFileDetailsTab(filePath, deepLinkAnchor?.anchor, deepLinkAnchor?.source, initialView), { intent: 'preview' });
        router.replace({ pathname: '/session/[id]', params: routeScope.withParams({ id: sessionId }) } as any);
    }, [deepLinkAnchor, filePath, initialView, pane, routeScope, router, sessionId, shouldRedirect]);

    React.useEffect(() => {
        if (!shouldUseDetailsScreen) return;
        if (hasRedirectedToDetailsRef.current) return;
        if (isUnsafeFilePath) return;
        if (!sessionId) return;
        if (!filePath) return;
        if (!sessionHydrated) return;
        if (shouldRedirect) return;
        hasRedirectedToDetailsRef.current = true;
        pane.openDetailsTab(
            createWorkspaceFileDetailsTab(filePath, deepLinkAnchor?.anchor, deepLinkAnchor?.source, initialView),
            { intent: 'preview' },
        );
        router.replace({
            pathname: '/session/[id]/details',
            params: routeScope.withParams({
                id: sessionId,
                ...serializeSessionPaneUrlState({ details: { kind: 'file', path: filePath, ...initialView } }),
            }),
        } as any);
    }, [deepLinkAnchor, filePath, initialView, isUnsafeFilePath, pane, routeScope, router, sessionHydrated, sessionId, shouldRedirect, shouldUseDetailsScreen]);

    if (!sessionId || isSessionRouteHydrationMissing(routeHydrationState) || (!filePath && !isUnsafeFilePath)) {
        return <SessionInvalidLinkFallback />;
    }
    if (isUnsafeFilePath) return null;
    if (!sessionHydrated) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivitySpinner size="small" />
            </View>
        );
    }
    if (shouldRedirect) return null;
    if (shouldUseDetailsScreen) return null;
    return <SessionFileDetailsView sessionId={sessionId} serverId={routeScope.serverId} scopeId={scopeId} filePath={filePath} deepLinkAnchor={deepLinkAnchor} initialView={initialView} />;
}

export { FileScreen as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={FileScreen} />; }
