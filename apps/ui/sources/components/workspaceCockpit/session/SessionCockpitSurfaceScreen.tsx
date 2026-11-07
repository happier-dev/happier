import * as React from 'react';
import { View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import {
    SessionCockpitBottomChromeHeightContext,
    useSessionCockpitBottomChromeHeight,
    useSessionCockpitChromeRegister,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDetailsTabCount } from '@/components/appShell/panes/hooks/useDetailsTabCount';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import { SessionTranscriptNavigationPane } from '@/components/sessions/panes/SessionTranscriptNavigationPane';
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
    type SessionPaneUrlDetailsTarget,
    type SessionPaneUrlState,
} from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionView } from '@/components/sessions/shell/SessionView';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';

import {
    resolveSessionRightTabIdForSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';
import { useSessionCockpitSurfaceNavigation } from './SessionCockpitSurfaceNavigation';

export type SessionCockpitSurfaceScreenProps = Readonly<{
    sessionId: string;
    scopeId: string;
    surface: SessionMobileSurface;
    routeServerId?: string | null;
    safeAreaPadding?: boolean;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    terminalTabAvailable?: boolean;
    routeHydrationState?: SessionRouteHydrationState | null;
}>;

export const SessionCockpitSurfaceScreen = React.memo((props: SessionCockpitSurfaceScreenProps) => {
    const { theme } = useUnistyles();
    const isFocused = useIsFocused();
    const pane = useAppPaneScope(props.scopeId);
    const surfaceNavigation = useSessionCockpitSurfaceNavigation();
    const registerCockpitChrome = useSessionCockpitChromeRegister();
    const openDetailsTabCount = useDetailsTabCount(props.scopeId);
    const activeRightTabId = pane.scopeState?.right?.activeTabId ?? null;
    const rightIsOpen = pane.scopeState?.right?.isOpen ?? false;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const closeDetails = pane.closeDetails;
    const setRightTab = pane.setRightTab;
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const hasDeepLinkedDetailsTarget = props.paneUrlState?.details != null;
    const paneRef = React.useRef(pane);
    const surfaceNavigationRef = React.useRef(surfaceNavigation);
    paneRef.current = pane;
    surfaceNavigationRef.current = surfaceNavigation;

    const switchSurface = React.useCallback((surface: SessionMobileSurface) => {
        surfaceNavigationRef.current?.switchSurface(surface);
    }, []);

    // The cockpit's only exit from a fullscreen surface back to the transcript. The
    // navigation pane uses it both as its close affordance (button / Escape) and as the
    // reveal that must precede a jump, since jumping into a hidden scene moves a viewport
    // the reader cannot see.
    const revealChatSurface = React.useCallback(() => {
        switchSurface('chat');
    }, [switchSurface]);

    React.useEffect(() => {
        if (!isFocused || !surfaceNavigation) return;
        return registerCockpitChrome({
            sessionId: props.sessionId,
            activeSurface: props.surface,
            terminalTabAvailable,
            openDetailsTabCount,
            switchSurface,
        });
    }, [
        isFocused,
        openDetailsTabCount,
        props.sessionId,
        props.surface,
        registerCockpitChrome,
        surfaceNavigation,
        switchSurface,
        terminalTabAvailable,
    ]);

    const previousDetails = React.useRef({ scopeId: props.scopeId, count: openDetailsTabCount });
    React.useEffect(() => {
        const previous = previousDetails.current;
        previousDetails.current = { scopeId: props.scopeId, count: openDetailsTabCount };
        if (isFocused && props.surface === 'tabs' && previous.scopeId === props.scopeId
            && previous.count > 0 && openDetailsTabCount === 0) {
            surfaceNavigationRef.current?.returnToPreviousSurface();
        }
    }, [isFocused, openDetailsTabCount, props.scopeId, props.surface]);

    const targetRightTabId = resolveSessionRightTabIdForSurface(props.surface, terminalTabAvailable);
    React.useEffect(() => {
        if (!isFocused) return;
        if (!targetRightTabId) return;
        if (rightIsOpen === true && activeRightTabId === targetRightTabId) return;

        openRight({ tabId: targetRightTabId });
        if (activeRightTabId !== targetRightTabId) {
            setRightTab(targetRightTabId);
        }
    }, [activeRightTabId, isFocused, openRight, rightIsOpen, setRightTab, targetRightTabId]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (props.surface !== 'chat') return;
        if (rightIsOpen !== true) return;

        closeRight();
    }, [closeRight, isFocused, props.surface, rightIsOpen]);

    React.useEffect(() => {
        if (!isFocused) return;
        if (props.surface !== 'chat') return;
        if (detailsIsOpen !== true) return;
        if (hasDeepLinkedDetailsTarget) return;

        closeDetails();
    }, [closeDetails, detailsIsOpen, hasDeepLinkedDetailsTarget, isFocused, props.surface]);

    const openDetailsSurface = React.useCallback(() => {
        surfaceNavigationRef.current?.switchSurface('tabs');
    }, []);

    const openDetailsRoute = React.useCallback((
        target: SessionPaneUrlDetailsTarget,
        intent?: { intent: 'pinned' },
    ) => {
        deferOnWeb(() => {
            const currentPane = paneRef.current;
            if (target.kind === 'file') {
                currentPane.openDetailsTab(createSessionFileDetailsTab(target.path), intent);
                openDetailsSurface();
                return;
            }

            if (target.kind === 'commit') {
                const tab = createSessionCommitDetailsTab(target.sha);
                if (!tab) return;

                currentPane.openDetailsTab(tab, intent);
                openDetailsSurface();
                return;
            }

            if (target.kind === 'terminal') {
                currentPane.openDetailsTab(createSessionDetailsTerminalTab(), intent);
                openDetailsSurface();
                return;
            }

            currentPane.openDetailsTab(createSessionScmReviewDetailsTab(), intent);
            openDetailsSurface();
        });
    }, [openDetailsSurface]);

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
            paneRef.current.openDetailsTab(tab, { intent: 'pinned' });
            openDetailsSurface();
        });
    }, [openDetailsSurface]);

    const safeAreaTopMode = 'internal';
    const headerSafeAreaTopMode = 'internal';
    const renderSessionChrome = React.useCallback((contentOverride?: React.ReactNode) => (
        <SessionView
            id={props.sessionId}
            routeServerId={props.routeServerId ?? undefined}
            jumpToSeq={props.jumpToSeq}
            paneUrlState={props.paneUrlState ?? undefined}
            initialAttachmentDrafts={props.initialAttachmentDrafts}
            routeAnchorOverride={true}
            contentOverride={contentOverride}
            routeHydrationState={props.routeHydrationState}
            safeAreaTopMode={safeAreaTopMode}
            headerSafeAreaTopMode={headerSafeAreaTopMode}
            surfaceFocusedOverride={isFocused}
            chatBottomSpacing="none"
        />
    ), [
        headerSafeAreaTopMode,
        isFocused,
        props.initialAttachmentDrafts,
        props.jumpToSeq,
        props.paneUrlState,
        props.routeServerId,
        props.routeHydrationState,
        props.sessionId,
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
                        scopeId={props.scopeId}
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

    if (props.surface === 'navigation') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-transcript-navigation-screen" safeAreaPadding={false}>
                <SessionTranscriptNavigationPane
                    onRequestClose={revealChatSurface}
                    onRevealTranscript={revealChatSurface}
                    sessionId={props.sessionId}
                />
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'terminal' && terminalTabAvailable) {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-terminal-screen" safeAreaPadding={false}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.text.secondary} />}>
                    <SessionTerminalSurface sessionId={props.sessionId} scopeId={props.scopeId} />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.safeAreaPadding === false) {
        // Cockpit fullscreen details: reserve the overlay bar like the other
        // surfaces so the panel's bottom content clears it.
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-details-screen" safeAreaPadding={false}>
                <SessionDetailsPanel
                    sessionId={props.sessionId}
                    scopeId={props.scopeId}
                    presentation="screen"
                    isActive={isFocused}
                    showHeaderActions={false}
                />
            </SessionCockpitFullscreenSurface>,
        );
    }

    return renderSessionChrome(
        <View testID="session-details-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <SessionDetailsPanel
                sessionId={props.sessionId}
                scopeId={props.scopeId}
                presentation={undefined}
                isActive={isFocused}
                showHeaderActions={false}
            />
        </View>,
    );
});

const SessionCockpitLoadingFallback = React.memo((props: Readonly<{ color: string }>) => (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivitySpinner size="small" color={props.color} />
    </View>
));

const SessionCockpitFullscreenSurface = React.memo((props: Readonly<{
    screenTestID: string;
    safeAreaPadding?: boolean;
    children: React.ReactNode;
}>) => {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const safeAreaPaddingEnabled = props.safeAreaPadding !== false;

    // Cockpit fullscreen surfaces (files/git/terminal/details) sit under the
    // floating overlay bar, so reserve its height at the screen level — this keeps
    // fixed footers/buttons above the bar (scroll content alone self-pads, but
    // fixed elements don't). The reserved area is part of the session screen, so it
    // slides away on dismiss. Then zero the height for descendants so nested scroll
    // content doesn't reserve it a second time. `bottomChromeHeight` is 0 when the
    // bar is hidden, collapsing the reservation.
    const body = safeAreaPaddingEnabled ? props.children : (
        <SessionCockpitBottomChromeHeightContext.Provider value={0}>
            {props.children}
        </SessionCockpitBottomChromeHeightContext.Provider>
    );

    return (
        <View
            testID={props.screenTestID}
            style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                backgroundColor: theme.colors.surface.base,
                paddingTop: safeAreaPaddingEnabled ? safeArea.top : 0,
                paddingBottom: safeAreaPaddingEnabled ? safeArea.bottom : bottomChromeHeight,
            }}
        >
            {body}
        </View>
    );
});
