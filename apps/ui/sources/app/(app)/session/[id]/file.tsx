import * as React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';
import { decodeSessionFilePathParam } from '@/scm/utils/filePathParam';
import { parseSessionFileDeepLinkAnchor } from '@/utils/url/sessionFileDeepLink';
import { SessionFileDetailsView } from '@/components/sessions/files/views/SessionFileDetailsView';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { shouldRedirectDetailsRouteToPanes } from '@/components/ui/panels/shouldRedirectDetailsRouteToPanes';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';

export default function FileScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ id: string; path: string }>();
    const sessionId = params.id || '';
    const decodedFilePath = decodeSessionFilePathParam(params.path as string);
    const filePath = isSafeWorkspaceRelativePath(decodedFilePath) ? decodedFilePath.trim() : '';
    const isUnsafeFilePath = Boolean(decodedFilePath) && !filePath;
    const deepLinkAnchor = React.useMemo(
        () => parseSessionFileDeepLinkAnchor(params as Record<string, string | string[] | undefined>),
        [params]
    );

    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled');
    const deviceType = useDeviceType();
    const { width: containerWidthPx } = useWindowDimensions();
    const shouldRedirect =
        Boolean(sessionId)
        && Boolean(filePath)
        && shouldRedirectDetailsRouteToPanes({ containerWidthPx, deviceType, multiPaneEnabled });

    const pane = useAppPaneScope(`session:${sessionId}`);

    const shouldUseDetailsScreen = Platform.OS !== 'web';
    const hasRedirectedToDetailsRef = React.useRef(false);

    React.useEffect(() => {
        hasRedirectedToDetailsRef.current = false;
    }, [filePath, sessionId]);

    React.useEffect(() => {
        if (!isUnsafeFilePath) return;
        if (!sessionId) return;
        router.replace({ pathname: '/session/[id]', params: { id: sessionId } } as any);
    }, [isUnsafeFilePath, router, sessionId]);

    React.useEffect(() => {
        if (!shouldRedirect) return;
        const fileName = filePath.split('/').at(-1) ?? filePath;
        pane.openDetailsTab({
            key: `file:${filePath}`,
            kind: 'file',
            title: fileName,
            resource: { kind: 'file', path: filePath, deepLinkAnchor },
        }, { intent: 'preview' });
        router.replace({ pathname: '/session/[id]', params: { id: sessionId } } as any);
    }, [deepLinkAnchor, filePath, pane, router, sessionId, shouldRedirect]);

    React.useEffect(() => {
        if (!shouldUseDetailsScreen) return;
        if (hasRedirectedToDetailsRef.current) return;
        if (isUnsafeFilePath) return;
        if (!sessionId) return;
        if (!filePath) return;
        if (shouldRedirect) return;
        hasRedirectedToDetailsRef.current = true;
        const fileName = filePath.split('/').at(-1) ?? filePath;
        pane.openDetailsTab(
            {
                key: `file:${filePath}`,
                kind: 'file',
                title: fileName,
                resource: { kind: 'file', path: filePath, deepLinkAnchor },
            },
            { intent: 'preview' },
        );
        router.replace({
            pathname: '/session/[id]/details',
            params: {
                id: sessionId,
                ...serializeSessionPaneUrlState({ details: { kind: 'file', path: filePath } }),
            },
        } as any);
    }, [deepLinkAnchor, filePath, isUnsafeFilePath, pane, router, sessionId, shouldRedirect, shouldUseDetailsScreen]);

    if (!sessionId || (!filePath && !isUnsafeFilePath)) {
        return <SessionInvalidLinkFallback />;
    }
    if (isUnsafeFilePath) return null;
    if (shouldRedirect) return null;
    if (shouldUseDetailsScreen) return null;
    return <SessionFileDetailsView sessionId={sessionId} scopeId={`session:${sessionId}`} filePath={filePath} deepLinkAnchor={deepLinkAnchor} />;
}
