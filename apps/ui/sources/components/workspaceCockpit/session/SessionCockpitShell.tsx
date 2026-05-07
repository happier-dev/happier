import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { prepareMobileSurfaceTransition } from '@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import {
    createSessionCommitDetailsTab,
    createSessionDetailsTerminalTab,
    createSessionFileDetailsTab,
    createSessionScmReviewDetailsTab,
    createSessionScmStashDetailsTab,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { SessionBrowseFilesSurface } from '@/components/sessions/panes/surfaces/SessionBrowseFilesSurface';
import { SessionGitSurface } from '@/components/sessions/panes/surfaces/SessionGitSurface';
import { SessionTerminalSurface } from '@/components/sessions/panes/surfaces/SessionTerminalSurface';
import {
    buildActiveDetailsRouteParams,
    serializeSessionPaneUrlState,
    type SessionPaneUrlDetailsTarget,
    type SessionPaneUrlState,
} from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';

import {
    buildSessionDetailsRouteQuery,
    resolveSessionDetailsSourceSurface,
} from './sessionCockpitNavigation';
import {
    resolveSessionRoutePathForSurface,
    resolveSessionRightTabIdForSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';

type SessionCockpitShellProps = Readonly<{
    sessionId: string;
    scopeId: string;
    surface: SessionMobileSurface;
    routeServerId?: string | null;
    safeAreaPadding?: boolean;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    terminalTabAvailable?: boolean;
}>;

export const SessionCockpitShell = React.memo((props: SessionCockpitShellProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname();
    const pane = useAppPaneScope(props.scopeId);
    const routeScope = React.useMemo(
        () => createSessionRouteServerScope({ serverId: props.routeServerId ?? undefined }),
        [props.routeServerId],
    );
    const activeRightTabId = pane.scopeState?.right?.activeTabId ?? null;
    const rightIsOpen = pane.scopeState?.right?.isOpen ?? false;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const closeDetails = pane.closeDetails;
    const setRightTab = pane.setRightTab;
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const hasDeepLinkedDetailsTarget = props.paneUrlState?.details != null;

    const targetRightTabId = resolveSessionRightTabIdForSurface(props.surface, terminalTabAvailable);
    React.useEffect(() => {
        if (!targetRightTabId) return;

        openRight({ tabId: targetRightTabId });
        if (activeRightTabId !== targetRightTabId) {
            setRightTab(targetRightTabId);
        }
    }, [activeRightTabId, openRight, setRightTab, targetRightTabId]);

    React.useEffect(() => {
        if (props.surface !== 'chat') return;
        if (rightIsOpen !== true) return;

        closeRight();
    }, [closeRight, props.surface, rightIsOpen]);

    React.useEffect(() => {
        if (props.surface !== 'chat') return;
        if (detailsIsOpen !== true) return;
        if (hasDeepLinkedDetailsTarget) return;

        closeDetails();
    }, [closeDetails, detailsIsOpen, hasDeepLinkedDetailsTarget, props.surface]);

    const pushDetailsRoute = React.useCallback((params: Record<string, string>) => {
        const targetHref = resolveSessionRoutePathForSurface(props.sessionId, 'tabs', {
            serverId: routeScope.serverId,
            query: buildSessionDetailsRouteQuery(
                params,
                resolveSessionDetailsSourceSurface(props.surface),
            ),
        });
        prepareMobileSurfaceTransition({
            currentPathname: pathname,
            targetHref,
            operation: 'push',
        });
        router.push(targetHref as never);
    }, [pathname, props.sessionId, props.surface, routeScope, router]);

    const openDetailsRoute = React.useCallback((
        target: SessionPaneUrlDetailsTarget,
        intent?: { intent: 'pinned' },
    ) => {
        deferOnWeb(() => {
            if (target.kind === 'file') {
                pane.openDetailsTab(createSessionFileDetailsTab(target.path), intent);
                pushDetailsRoute(serializeSessionPaneUrlState({ details: target }));
                return;
            }

            if (target.kind === 'commit') {
                const tab = createSessionCommitDetailsTab(target.sha);
                if (!tab) return;

                pane.openDetailsTab(tab, intent);
                pushDetailsRoute(serializeSessionPaneUrlState({ details: target }));
                return;
            }

            if (target.kind === 'terminal') {
                const tab = createSessionDetailsTerminalTab();
                pane.openDetailsTab(tab, intent);
                pushDetailsRoute(buildActiveDetailsRouteParams([tab], tab.key));
                return;
            }

            pane.openDetailsTab(createSessionScmReviewDetailsTab(), intent);
            pushDetailsRoute(serializeSessionPaneUrlState({ details: target }));
        });
    }, [pane, pushDetailsRoute]);

    const openFileInDetails = React.useCallback((fullPath: string) => {
        openDetailsRoute({ kind: 'file', path: fullPath });
    }, [openDetailsRoute]);

    const openFileInDetailsPinned = React.useCallback((fullPath: string) => {
        openDetailsRoute({ kind: 'file', path: fullPath }, { intent: 'pinned' });
    }, [openDetailsRoute]);

    const openCommitInDetails = React.useCallback((sha: string) => {
        const normalizedSha = sha.trim().split(/\s+/)[0] ?? '';
        if (!normalizedSha) return;

        openDetailsRoute({ kind: 'commit', sha: normalizedSha });
    }, [openDetailsRoute]);

    const openReviewAllChanges = React.useCallback(() => {
        openDetailsRoute({ kind: 'scmReview' }, { intent: 'pinned' });
    }, [openDetailsRoute]);

    const openStashDetails = React.useCallback(() => {
        deferOnWeb(() => {
            const tab = createSessionScmStashDetailsTab();
            pane.openDetailsTab(tab, { intent: 'pinned' });
            pushDetailsRoute({});
        });
    }, [pane, pushDetailsRoute]);

    const safeAreaTopMode = 'internal';
    const headerSafeAreaTopMode = 'internal';
    const renderSessionChrome = React.useCallback((contentOverride?: React.ReactNode) => (
        <SessionView
            id={props.sessionId}
            routeServerId={props.routeServerId ?? undefined}
            jumpToSeq={props.jumpToSeq}
            paneUrlState={props.paneUrlState ?? undefined}
            initialAttachmentDrafts={props.initialAttachmentDrafts}
            contentOverride={contentOverride}
            safeAreaTopMode={safeAreaTopMode}
            headerSafeAreaTopMode={headerSafeAreaTopMode}
            chatBottomSpacing="none"
        />
    ), [
        headerSafeAreaTopMode,
        props.initialAttachmentDrafts,
        props.jumpToSeq,
        props.paneUrlState,
        props.routeServerId,
        props.sessionId,
        safeAreaTopMode,
    ]);

    if (props.surface === 'chat') {
        return renderSessionChrome();
    }

    if (props.surface === 'browse') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-files-screen" safeAreaPadding={false}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.textSecondary} />}>
                    <SessionBrowseFilesSurface
                        sessionId={props.sessionId}
                        onOpenFile={openFileInDetails}
                        onOpenFilePinned={openFileInDetailsPinned}
                    />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'git') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-git-screen" safeAreaPadding={false}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.textSecondary} />}>
                    <SessionGitSurface
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        onOpenFile={openFileInDetails}
                        onOpenFilePinned={openFileInDetailsPinned}
                        onOpenCommit={openCommitInDetails}
                        onOpenReviewAllChanges={openReviewAllChanges}
                        onOpenStashDetails={openStashDetails}
                    />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'terminal' && terminalTabAvailable) {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-terminal-screen" safeAreaPadding={false}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.textSecondary} />}>
                    <SessionTerminalSurface sessionId={props.sessionId} scopeId={props.scopeId} />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    return renderSessionChrome(
        <View testID="session-details-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <SessionDetailsPanel
                sessionId={props.sessionId}
                scopeId={props.scopeId}
                presentation={props.safeAreaPadding === false ? 'screen' : undefined}
                showHeaderActions={false}
            />
        </View>,
    );
});

const SessionCockpitLoadingFallback = React.memo((props: Readonly<{ color: string }>) => (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="small" color={props.color} />
    </View>
));

const SessionCockpitFullscreenSurface = React.memo((props: Readonly<{
    screenTestID: string;
    safeAreaPadding?: boolean;
    children: React.ReactNode;
}>) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const safeAreaPaddingEnabled = props.safeAreaPadding !== false;

    return (
        <View
            testID={props.screenTestID}
            style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                backgroundColor: theme.colors.surface,
                paddingTop: safeAreaPaddingEnabled ? safeArea.top : 0,
                paddingBottom: safeAreaPaddingEnabled ? safeArea.bottom : 0,
            }}
        >
            {props.children}
        </View>
    );
});
