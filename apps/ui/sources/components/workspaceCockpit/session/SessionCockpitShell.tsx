import * as React from 'react';
import { View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
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
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { prepareMobileSurfaceTransition } from '@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent';
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
    safeAreaPadding?: boolean;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    terminalTabAvailable?: boolean;
    routeServerId?: string | null;
}>;

export const SessionCockpitShell = React.memo((props: SessionCockpitShellProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pathname = usePathname();
    const pane = useAppPaneScope(props.scopeId);
    const activeRightTabId = pane.scopeState?.right?.activeTabId ?? null;
    const rightIsOpen = pane.scopeState?.right?.isOpen ?? false;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const closeDetails = pane.closeDetails;
    const setRightTab = pane.setRightTab;
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const routeServerId = typeof props.routeServerId === 'string' && props.routeServerId.trim().length > 0
        ? props.routeServerId.trim()
        : null;

    const targetRightTabId = resolveSessionRightTabIdForSurface(props.surface, terminalTabAvailable);
    React.useEffect(() => {
        if (!targetRightTabId) {
            return;
        }
        openRight({ tabId: targetRightTabId });
        if (activeRightTabId !== targetRightTabId) {
            setRightTab(targetRightTabId);
        }
    }, [activeRightTabId, openRight, setRightTab, targetRightTabId]);

    React.useEffect(() => {
        if (props.surface !== 'chat') {
            return;
        }
        if (rightIsOpen !== true) {
            return;
        }
        closeRight();
    }, [closeRight, props.surface, rightIsOpen]);

    React.useEffect(() => {
        if (props.surface !== 'chat') {
            return;
        }
        if (!detailsIsOpen) {
            return;
        }
        closeDetails();
    }, [closeDetails, detailsIsOpen, props.surface]);

    const pushDetailsRoute = React.useCallback((query?: Readonly<Record<string, string | number | boolean | null | undefined>>) => {
        const targetHref = resolveSessionRoutePathForSurface(props.sessionId, 'tabs', {
            serverId: routeServerId,
            query: buildSessionDetailsRouteQuery(
                query ?? {},
                resolveSessionDetailsSourceSurface(props.surface),
            ),
        });
        prepareMobileSurfaceTransition({
            currentPathname: pathname,
            targetHref,
            operation: 'push',
        });
        router.push(targetHref);
    }, [pathname, props.sessionId, props.surface, routeServerId, router]);

    const openDetailsRoute = React.useCallback((
        target: SessionPaneUrlDetailsTarget,
        intent?: { intent: 'pinned' },
    ) => {
        deferOnWeb(() => {
            if (target.kind === 'file') {
                pane.openDetailsTab(createSessionFileDetailsTab(target.path), intent);
            } else if (target.kind === 'commit') {
                const tab = createSessionCommitDetailsTab(target.sha);
                if (!tab) {
                    return;
                }
                pane.openDetailsTab(tab, intent);
            } else if (target.kind === 'terminal') {
                const tab = createSessionDetailsTerminalTab({
                    terminalInstanceId: target.terminalInstanceId,
                });
                pane.openDetailsTab(tab, intent);

                pushDetailsRoute(buildActiveDetailsRouteParams([tab], tab.key));
                return;
            } else {
                pane.openDetailsTab(createSessionScmReviewDetailsTab(), intent);
            }

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
        if (!normalizedSha) {
            return;
        }
        openDetailsRoute({ kind: 'commit', sha: normalizedSha });
    }, [openDetailsRoute]);

    const openReviewAllChanges = React.useCallback(() => {
        openDetailsRoute({ kind: 'scmReview' }, { intent: 'pinned' });
    }, [openDetailsRoute]);

    const openStashDetails = React.useCallback(() => {
        deferOnWeb(() => {
            const tab = createSessionScmStashDetailsTab();
            pane.openDetailsTab(tab, { intent: 'pinned' });
            pushDetailsRoute(buildActiveDetailsRouteParams([tab], tab.key));
        });
    }, [pane, pushDetailsRoute]);

    const openNewTerminalTab = React.useCallback(() => {
        openDetailsRoute({ kind: 'terminal' }, { intent: 'pinned' });
    }, [openDetailsRoute]);

    const safeAreaTopMode = 'internal';
    const headerSafeAreaTopMode = 'internal';
    const renderSessionChrome = React.useCallback((contentOverride?: React.ReactNode) => (
        <SessionView
            id={props.sessionId}
            routeServerId={routeServerId}
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
        props.sessionId,
        routeServerId,
        safeAreaTopMode,
    ]);

    if (props.surface === 'chat') {
        return renderSessionChrome();
    }

    if (props.surface === 'browse') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-files-screen" safeAreaPadding={false}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.text.secondary} />}>
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
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.text.secondary} />}>
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
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.text.secondary} />}>
                    <SessionTerminalSurface
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        onOpenNewTerminalTab={openNewTerminalTab}
                    />
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

const SessionCockpitLoadingFallback = React.memo((props: Readonly<{ color: string }>) => {
    return <PaneLoadingFallback color={props.color} paddingTop={0} showTypographyMetrics={false} />;
});

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
                backgroundColor: theme.colors.surface.base,
                paddingTop: safeAreaPaddingEnabled ? safeArea.top : 0,
                paddingBottom: safeAreaPaddingEnabled ? safeArea.bottom : 0,
            }}
        >
            {props.children}
        </View>
    );
});
