import * as React from 'react';
import { Platform, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';

import {
    SessionCockpitBottomChromeHeightContext,
    useSessionCockpitBottomChromeHeight,
    useSessionCockpitChromeRegister,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { BrowserMobileSurfaceScreen } from '@/components/browser/surfaces/BrowserMobileSurfaceScreen';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDetailsTabCount } from '@/components/appShell/panes/hooks/useDetailsTabCount';
import {
    resolveRightSidebarMobileProjection,
} from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import {
    resolveSessionRightSidebarTabs,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import {
    createSessionCommitDetailsTab,
    createSessionDetailsTerminalTab,
    createSessionFileDetailsTab,
    createSessionScmReviewDetailsTab,
    createSessionScmStashDetailsTab,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { SessionTranscriptNavigationPane } from '@/components/sessions/panes/SessionTranscriptNavigationPane';
import { SessionBrowseFilesSurface } from '@/components/sessions/panes/surfaces/SessionBrowseFilesSurface';
import { SessionGitSurface } from '@/components/sessions/panes/surfaces/SessionGitSurface';
import { SessionTerminalSurface } from '@/components/sessions/panes/surfaces/SessionTerminalSurface';
import {
    type SessionPaneUrlDetailsTarget,
    type SessionPaneUrlState,
} from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';

import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import {
    resolveSessionRightTabIdForSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';
import { SessionServicesSurfaceScreen } from './SessionServicesSurfaceScreen';
import { useSessionCockpitSurfaceNavigation } from './SessionCockpitSurfaceNavigation';

export type SessionCockpitSurfaceScreenProps = Readonly<{
    sessionId: string;
    scopeId: string;
    surface: SessionMobileSurface;
    safeAreaPadding?: boolean;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    terminalTabAvailable?: boolean;
    routeServerId?: string | null;
    routeHydrationState?: SessionRouteHydrationState | null;
}>;

export const SessionCockpitSurfaceScreen = React.memo((props: SessionCockpitSurfaceScreenProps) => {
    const { theme } = useUnistyles();
    const isFocused = useIsFocused();
    const pane = useAppPaneScope(props.scopeId);
    const surfaceNavigation = useSessionCockpitSurfaceNavigation();
    const registerCockpitChrome = useSessionCockpitChromeRegister();
    const openDetailsTabCount = useDetailsTabCount(props.scopeId);
    const surfaceNavigationRef = React.useRef(surfaceNavigation);
    surfaceNavigationRef.current = surfaceNavigation;
    const sessionMachineTarget = useSessionMachineTarget(props.sessionId);
    const servicesServerId = usePreferredServerIdForSession(props.sessionId, props.routeServerId);
    const switchToBrowserSurface = React.useCallback(() => {
        surfaceNavigation?.switchSurface('browser');
    }, [surfaceNavigation]);
    // The mobile browser is a separate full-screen surface with its own pane scope; open a service
    // into that browser workspace, then switch the cockpit to it (only after a mappable target).
    const openServiceInBrowser = useServicesOpenInBrowser({
        scopeId: `${props.scopeId}:browser`,
        scope: 'sessionMobile',
        machineId: sessionMachineTarget?.machineId ?? null,
        serverId: servicesServerId,
        sessionId: props.sessionId,
        onAfterOpen: switchToBrowserSurface,
    });
    const activeRightTabId = pane.scopeState?.right?.activeTabId ?? null;
    const rightIsOpen = pane.scopeState?.right?.isOpen ?? false;
    const detailsIsOpen = pane.scopeState?.details?.isOpen ?? false;
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const closeDetails = pane.closeDetails;
    const setRightTab = pane.setRightTab;
    const terminalTabAvailable = props.terminalTabAvailable !== false;
    const hasDeepLinkedDetailsTarget = props.paneUrlState?.details != null;
    const pluginProjection = useScopedPluginUiProjection({
        machineId: sessionMachineTarget?.machineId ?? null,
        serverId: servicesServerId,
    });
    const pluginMobileTab = React.useMemo<RightSidebarPluginTabDefinition | null>(() => {
        if (!props.surface.startsWith('plugin:')) {
            return null;
        }
        const pluginPlacements = pluginProjection.pluginUiProjection
            ? selectPluginRightSidebarTabPlacements(pluginProjection.pluginUiProjection, 'session')
            : [];
        const tabs = resolveSessionRightSidebarTabs({
            presentation: 'mobile',
            terminalTabAvailable,
            pluginPlacements,
            projectionGeneration: pluginProjection.pluginUiProjection?.generation ?? null,
        });
        const entry = resolveRightSidebarMobileProjection({
            scope: 'session',
            tabs,
        }).find((candidate) => candidate.owner === 'plugin' && candidate.tabId === props.surface);
        return entry?.tab.owner === 'plugin' ? entry.tab : null;
    }, [pluginProjection.pluginUiProjection, props.surface, terminalTabAvailable]);

    const switchSurface = React.useCallback((surface: SessionMobileSurface) => {
        surfaceNavigationRef.current?.switchSurface(surface);
    }, []);

    // The cockpit's only exit from a fullscreen surface back to the transcript. The
    // navigation surface uses it both as its close affordance (button / Escape) and as the
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

    const targetRightTabId = pluginMobileTab?.id
        ?? (
            props.surface === 'browser' || props.surface === 'services'
                ? null
                : resolveSessionRightTabIdForSurface(props.surface, terminalTabAvailable)
        );
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
        surfaceNavigation?.switchSurface('tabs');
    }, [surfaceNavigation]);

    const openDetailsRoute = React.useCallback((
        target: SessionPaneUrlDetailsTarget,
        intent?: { intent: 'pinned' },
    ) => {
        deferOnWeb(() => {
            if (target.kind === 'file') {
                pane.openDetailsTab(createSessionFileDetailsTab(target.path), intent);
                openDetailsSurface();
                return;
            }

            if (target.kind === 'commit') {
                const tab = createSessionCommitDetailsTab(target.sha);
                if (!tab) return;

                pane.openDetailsTab(tab, intent);
                openDetailsSurface();
                return;
            }

            if (target.kind === 'terminal') {
                pane.openDetailsTab(createSessionDetailsTerminalTab({
                    terminalInstanceId: target.terminalInstanceId,
                }), intent);
                openDetailsSurface();
                return;
            }

            pane.openDetailsTab(createSessionScmReviewDetailsTab(), intent);
            openDetailsSurface();
        });
    }, [openDetailsSurface, pane]);

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
            openDetailsSurface();
        });
    }, [openDetailsSurface, pane]);

    const openNewTerminalTab = React.useCallback(() => {
        openDetailsRoute({ kind: 'terminal' }, { intent: 'pinned' });
    }, [openDetailsRoute]);

    const safeAreaTopMode = 'internal';
    const headerSafeAreaTopMode = 'internal';
    const renderSessionChrome = React.useCallback((contentOverride?: React.ReactNode) => (
        <SessionView
            id={props.sessionId}
            routeServerId={props.routeServerId ?? undefined}
            routeHydrationState={props.routeHydrationState}
            jumpToSeq={props.jumpToSeq}
            paneUrlState={props.paneUrlState ?? undefined}
            initialAttachmentDrafts={props.initialAttachmentDrafts}
            routeAnchorOverride={Platform.OS === 'web' ? undefined : true}
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
                    <SessionTerminalSurface
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        onOpenNewTerminalTab={openNewTerminalTab}
                    />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'browser') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-browser-screen" safeAreaPadding={false}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.text.secondary} />}>
                    <BrowserMobileSurfaceScreen sessionId={props.sessionId} scopeId={`${props.scopeId}:browser`} />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (props.surface === 'services') {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID="session-services-screen" safeAreaPadding={false}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.text.secondary} />}>
                    <SessionServicesSurfaceScreen
                        sessionId={props.sessionId}
                        serverId={props.routeServerId}
                        onOpenServiceInBrowser={openServiceInBrowser}
                    />
                </React.Suspense>
            </SessionCockpitFullscreenSurface>,
        );
    }

    if (pluginMobileTab) {
        return renderSessionChrome(
            <SessionCockpitFullscreenSurface screenTestID={`session-plugin-screen-${pluginMobileTab.id}`} safeAreaPadding={false}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.text.secondary} />}>
                    <PluginSurfacePlacementHost
                        placement={pluginMobileTab.placement}
                        machineId={pluginProjection.machineId}
                        serverId={pluginProjection.serverId}
                        pluginUiProjection={pluginProjection.pluginUiProjection}
                        projectionInteractionEnabled={pluginProjection.interactionEnabled}
                        platform={pluginProjection.platform}
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
