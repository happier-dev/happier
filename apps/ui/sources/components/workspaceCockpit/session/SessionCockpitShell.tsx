import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import {
    createSessionCommitDetailsTab,
    createSessionDetailsTerminalTab,
    createSessionFileDetailsTab,
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
import {
    resolveSessionRightTabIdForSurface,
    type SessionMobileSurface,
} from './sessionCockpitState';

type SessionCockpitShellProps = Readonly<{
    sessionId: string;
    scopeId: string;
    surface: SessionMobileSurface;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState | null;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    terminalTabAvailable?: boolean;
}>;

export const SessionCockpitShell = React.memo((props: SessionCockpitShellProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const pane = useAppPaneScope(props.scopeId);
    const activeRightTabId = pane.scopeState?.right?.activeTabId ?? null;
    const rightIsOpen = pane.scopeState?.right?.isOpen ?? false;
    const openRight = pane.openRight;
    const closeRight = pane.closeRight;
    const setRightTab = pane.setRightTab;
    const terminalTabAvailable = props.terminalTabAvailable !== false;

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
            } else {
                const tab = createSessionDetailsTerminalTab({
                    terminalInstanceId: target.terminalInstanceId,
                });
                pane.openDetailsTab(tab, intent);

                router.push({
                    pathname: '/session/[id]/details',
                    params: {
                        id: props.sessionId,
                        ...buildActiveDetailsRouteParams([tab], tab.key),
                    },
                } as any);
                return;
            }

            router.push({
                pathname: '/session/[id]/details',
                params: {
                    id: props.sessionId,
                    ...serializeSessionPaneUrlState({ details: target }),
                },
            } as any);
        });
    }, [pane, props.sessionId, router]);

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

    const openNewTerminalTab = React.useCallback(() => {
        openDetailsRoute({ kind: 'terminal' }, { intent: 'pinned' });
    }, [openDetailsRoute]);

    if (props.surface === 'chat') {
        return (
            <SessionView
                id={props.sessionId}
                jumpToSeq={props.jumpToSeq}
                paneUrlState={props.paneUrlState ?? undefined}
                initialAttachmentDrafts={props.initialAttachmentDrafts}
            />
        );
    }

    if (props.surface === 'browse') {
        return (
            <View testID="session-files-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.textSecondary} />}>
                    <SessionBrowseFilesSurface
                        sessionId={props.sessionId}
                        onOpenFile={openFileInDetails}
                        onOpenFilePinned={openFileInDetailsPinned}
                    />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'git') {
        return (
            <View testID="session-git-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.textSecondary} />}>
                    <SessionGitSurface
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        onOpenFile={openFileInDetails}
                        onOpenFilePinned={openFileInDetailsPinned}
                        onOpenCommit={openCommitInDetails}
                    />
                </React.Suspense>
            </View>
        );
    }

    if (props.surface === 'terminal' && terminalTabAvailable) {
        return (
            <View testID="session-terminal-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                <React.Suspense fallback={<SessionCockpitLoadingFallback color={theme.colors.textSecondary} />}>
                    <SessionTerminalSurface
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        onOpenNewTerminalTab={openNewTerminalTab}
                    />
                </React.Suspense>
            </View>
        );
    }

    return (
        <View testID="session-details-screen" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <SessionDetailsPanel sessionId={props.sessionId} scopeId={props.scopeId} />
        </View>
    );
});

const SessionCockpitLoadingFallback = React.memo((props: Readonly<{ color: string }>) => {
    return <PaneLoadingFallback color={props.color} paddingTop={0} showTypographyMetrics={false} />;
});
