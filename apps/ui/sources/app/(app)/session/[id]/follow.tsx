import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { Stack, useLocalSearchParams, useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { openFollowNotificationSettings } from '@/components/sessions/follow/openFollowNotificationSettings';
import { AccountSessionFollowControl } from '@/components/sessions/follow/AccountSessionFollowControl';
import { FollowEditorPage } from '@/components/sessions/follow/FollowEditorPage';
import { SessionFollowUnavailableNotice } from '@/components/sessions/follow/SessionFollowUnavailableNotice';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { buildScopedSessionRouteHref, readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

const styles = StyleSheet.create(() => ({
    pending: { flex: 1, justifyContent: 'center' },
}));

export function SessionFollowScreen() {
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[]; archived?: string }>();
    const router = useRouter();
    const openingSettings = React.useRef(false);
    const sessionId = normalizeSessionId(params.id);
    const serverId = readSessionRouteServerId(params);
    // The control renders nothing when Following is unavailable, which on this dedicated route
    // is a blank screen. Read the same decision here so a link to a Home without Following lands
    // on a real answer with a way back to the Session it named.
    //
    // The decision has four shapes and every one of them is a screen: it has not arrived yet,
    // the probe could not reach the Home, the Home said no, or Following is there. Only the
    // last one mounts the editor; the others used to fall through to a blank route.
    const followingDecision = useFeatureDecision('sessions.following', { scopeKind: 'spawn', serverId: serverId ?? '' });
    const backToSession = React.useCallback(() => {
        if (!sessionId || !serverId) return;
        safeRouterBack({ router, fallbackHref: buildScopedSessionRouteHref({ sessionId, serverId }) as Href });
    }, [router, serverId, sessionId]);
    if (!sessionId || !serverId) return <SessionInvalidLinkFallback />;
    const address = { serverId, sessionId };
    const followingHeader = (
        <Stack.Screen options={{ headerShown: true, title: t('session.follow.editor.title') }} />
    );
    if (followingDecision?.state === 'disabled' || followingDecision?.state === 'unsupported') {
        return <>
            {followingHeader}
            <SessionFollowUnavailableNotice onBack={backToSession} />
        </>;
    }
    if (followingDecision?.state === 'unknown' && followingDecision.blockerCode === 'probe_failed') {
        return <>
            {followingHeader}
            <SessionFollowUnavailableNotice
                reason="unreachable"
                onBack={backToSession}
                // The canonical exact-Home feature probe, asked again. Nothing else on this
                // route can change the answer, and no second probe is introduced here.
                onRetry={() => { void getServerFeaturesSnapshot({ serverId, force: true }); }}
            />
        </>;
    }
    if (!followingDecision || followingDecision.state === 'unknown') {
        return <>
            {followingHeader}
            <View style={styles.pending}>
                <SurfaceStateCard testID="session-follow-checking" kind="loading" size="page" title={t('common.loading')} />
            </View>
        </>;
    }
    return <>
        {followingHeader}
        <AccountSessionFollowControl
            address={address}
            archived={params.archived === '1'}
            onClose={() => {
                if (!openingSettings.current) backToSession();
            }}
            onOpenNotificationSettings={() => {
                openingSettings.current = true;
                void openFollowNotificationSettings({
                    serverId,
                    navigate: () => router.replace('/settings/notifications'),
                }).finally(() => { openingSettings.current = false; });
            }}
            // The page scrolls; Unfollow · Done stay in thumb reach under it (lab P2-Ap).
            frame={(parts) => <FollowEditorPage title={parts.title} subtitle={parts.subtitle} footer={parts.footer}
                footerTestID="session-follow-footer">{parts.body}</FollowEditorPage>}
        />
    </>;
}

export { SessionFollowScreen as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionFollowScreen} />; }
