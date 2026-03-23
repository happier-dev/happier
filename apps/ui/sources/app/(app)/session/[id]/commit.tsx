import * as React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';
import { SessionCommitDetailsView } from '@/components/sessions/files/views/SessionCommitDetailsView';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { shouldRedirectDetailsRouteToPanes } from '@/components/ui/panels/shouldRedirectDetailsRouteToPanes';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';

function decodeSha(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export default function CommitScreen() {
    const router = useRouter();
    const { id: sessionIdParam } = useLocalSearchParams<{ id: string }>();
    const sessionId = sessionIdParam || '';
    const { sha: shaParam } = useLocalSearchParams<{ sha: string }>();
    // Commit refs cannot contain whitespace; accept accidental "oneline" strings by taking the first token.
    const shaRaw = decodeSha(shaParam || '').trim();
    const sha = shaRaw.split(/\s+/)[0] ?? '';

    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled');
    const deviceType = useDeviceType();
    const { width: containerWidthPx } = useWindowDimensions();
    const shouldRedirect =
        Boolean(sessionId)
        && Boolean(sha)
        && shouldRedirectDetailsRouteToPanes({ containerWidthPx, deviceType, multiPaneEnabled });

    const pane = useAppPaneScope(`session:${sessionId}`);
    const shouldUseDetailsScreen = Platform.OS !== 'web';
    const hasRedirectedToDetailsRef = React.useRef(false);

    React.useEffect(() => {
        hasRedirectedToDetailsRef.current = false;
    }, [sessionId, sha]);

    React.useEffect(() => {
        if (!shouldRedirect) return;
        pane.openDetailsTab({
            key: `commit:${sha}`,
            kind: 'commit',
            title: sha.slice(0, 7),
            resource: { kind: 'commit', commitHash: sha },
        }, { intent: 'preview' });
        router.replace({ pathname: '/session/[id]', params: { id: sessionId } } as any);
    }, [pane, router, sessionId, sha, shouldRedirect]);

    React.useEffect(() => {
        if (shouldRedirect) return;
        if (!shouldUseDetailsScreen) return;
        if (hasRedirectedToDetailsRef.current) return;
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
        router.replace({
            pathname: '/session/[id]/details',
            params: {
                id: sessionId,
                ...serializeSessionPaneUrlState({ details: { kind: 'commit', sha } }),
            },
        } as any);
    }, [pane, router, sessionId, sha, shouldRedirect, shouldUseDetailsScreen]);

    if (!sessionId || !sha) {
        return <SessionInvalidLinkFallback />;
    }
    if (shouldRedirect) return null;
    if (shouldUseDetailsScreen) return null;
    return <SessionCommitDetailsView sessionId={sessionId} sha={sha} onBack={() => router.back()} />;
}
