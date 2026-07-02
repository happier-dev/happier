import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    renderProviderSessionDetailsTab,
    resolveProviderSessionDetailsTabIconName,
} from '@/agents/registry/sessionSubagentUiBehavior';
import { SessionExecutionRunLauncherView } from '@/components/sessions/runs/launcher/SessionExecutionRunLauncherView';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import { SESSION_PRIMARY_TERMINAL_INSTANCE_ID } from '@/components/sessions/terminal/embeddedTerminalDocking';
import { readTerminalDetailsInstanceId } from '@/components/terminal/terminalDetailsTabModel';
import { t } from '@/text';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { createSessionFileDetailsTab } from './details/sessionDetailsTabBuilders';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { usePaneFocusMode } from '@/components/appShell/panes/focusMode/usePaneFocusMode';
import {
    SessionCommitDetailsViewForPanel,
    SessionFileDetailsViewForPanel,
    SessionScmReviewDetailsViewForPanel,
    SessionScmStashDetailsViewForPanel,
    SessionSubagentDetailsViewForPanel,
} from './SessionDetailsPanelDetailViews';
import {
    renderPluginSessionSurfaceTab,
    resolvePluginSessionSurfaceTabIconName,
} from './registry/sessionSurfaces';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';

export type SessionDetailsPanelProps = Readonly<{
    sessionId: string;
    scopeId: string;
    presentation?: 'pane' | 'screen';
    /**
     * Optional override for the close action. Used by fullscreen/mobile routes that render the same
     * surface as the desktop details pane but need to navigate back in the router stack.
     */
    onRequestClose?: () => void;
    /**
     * Cockpit embeds details inside the shared session chrome, so the per-panel close/focus
     * controls would duplicate route-level navigation controls.
     */
    showHeaderActions?: boolean;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
}>;

function asResource(value: unknown): { kind: string } | null {
    if (!value || typeof value !== 'object') return null;
    if (!('kind' in value)) return null;
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind !== 'string') return null;
    return { kind };
}

function isFileResource(value: unknown): value is Readonly<{ kind: 'file'; path: string }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; path?: unknown };
    return maybe.kind === 'file' && typeof maybe.path === 'string';
}

function isCommitResource(value: unknown): value is Readonly<{ kind: 'commit'; sha: string }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; sha?: unknown; commitHash?: unknown };
    const sha = typeof maybe.sha === 'string' ? maybe.sha : typeof maybe.commitHash === 'string' ? maybe.commitHash : null;
    return maybe.kind === 'commit' && typeof sha === 'string';
}

function isScmReviewResource(value: unknown): value is Readonly<{ kind: 'scmReview' }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown };
    return maybe.kind === 'scmReview';
}

function isScmStashResource(value: unknown): value is Readonly<{ kind: 'scmStash' }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown };
    return maybe.kind === 'scmStash';
}

function isSubagentResource(value: unknown): value is Readonly<{ kind: 'subagent'; subagentId: string }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; subagentId?: unknown };
    return maybe.kind === 'subagent' && typeof maybe.subagentId === 'string' && maybe.subagentId.trim().length > 0;
}

function isExecutionRunLauncherResource(value: unknown): value is Readonly<{
    kind: 'executionRunLauncher';
    intent?: 'review' | 'plan' | 'delegate';
}> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; intent?: unknown };
    if (maybe.kind !== 'executionRunLauncher') return false;
    return maybe.intent == null || maybe.intent === 'review' || maybe.intent === 'plan' || maybe.intent === 'delegate';
}

export const SessionDetailsPanel = React.memo((props: SessionDetailsPanelProps) => {
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const pane = useAppPaneScope(props.scopeId);
    const requestClose = props.onRequestClose ?? pane.closeDetails;
    const paneFocusMode = usePaneFocusMode(props.scopeId);
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const showHeaderActions = props.showHeaderActions !== false;
    const closeButtonAtStart = showHeaderActions && props.presentation === 'screen' && Platform.OS !== 'web';
    const panelPaddingTop = closeButtonAtStart ? 0 : insets.top;
    const rightPaneOpen = pane.scopeState?.right?.isOpen === true;
    const showRightPaneToggle = showHeaderActions && props.presentation !== 'screen';

    const openFileTab = React.useCallback((path: string, intent: 'default' | 'pinned' = 'default') => {
        deferOnWeb(() => {
            pane.openDetailsTab(createSessionFileDetailsTab(path), { intent });
        });
    }, [pane]);

    const paneRef = React.useRef(pane);
    React.useEffect(() => {
        paneRef.current = pane;
    }, [pane]);
    const startEditingFileHandlersRef = React.useRef(new Map<string, () => void>());
    const getStartEditingFileHandler = React.useCallback((tabKey: string, isPreview: boolean): () => void => {
        const cacheKey = `${tabKey}:${isPreview ? 'preview' : 'pinned'}`;
        const cached = startEditingFileHandlersRef.current.get(cacheKey);
        if (cached) return cached;

        const handler = () => {
            if (isPreview) {
                paneRef.current.pinDetailsTab(tabKey);
            }
        };
        startEditingFileHandlersRef.current.set(cacheKey, handler);
        return handler;
    }, []);

    const renderTabContent = React.useCallback((tab: any) => {
        const pluginSurfaceTab = renderPluginSessionSurfaceTab({
            tab,
            pluginUiProjection: props.pluginUiProjection,
            localServicePreviewState: props.localServicePreviewState,
        });
        if (pluginSurfaceTab) {
            return pluginSurfaceTab;
        }

        const resource = asResource(tab.resource);
        if (resource?.kind === 'file') {
            if (isFileResource(tab.resource)) {
                const anchor = (tab.resource as any)?.deepLinkAnchor ?? null;
                return (
                    <SessionFileDetailsViewForPanel
                        sessionId={props.sessionId}
                        filePath={tab.resource.path}
                        deepLinkAnchor={anchor}
                        presentation="panel"
                        scopeId={props.scopeId}
                        onStartEditingFile={getStartEditingFileHandler(tab.key, tab.isPreview)}
                    />
                );
            }
        }
        if (resource?.kind === 'commit') {
            if (isCommitResource(tab.resource)) {
                const sha = (tab.resource as any)?.sha ?? (tab.resource as any)?.commitHash ?? '';
                return (
                    <SessionCommitDetailsViewForPanel
                        sessionId={props.sessionId}
                        sha={String(sha)}
                        onBack={requestClose}
                        presentation="panel"
                        onOpenFile={(path) => openFileTab(path, 'default')}
                        onOpenFilePinned={(path) => openFileTab(path, 'pinned')}
                    />
                );
            }
        }
        if (resource?.kind === 'scmReview') {
            if (isScmReviewResource(tab.resource)) {
                return (
                    <SessionScmReviewDetailsViewForPanel sessionId={props.sessionId} scopeId={props.scopeId} />
                );
            }
        }
        if (resource?.kind === 'scmStash') {
            if (isScmStashResource(tab.resource)) {
                return (
                    <SessionScmStashDetailsViewForPanel
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        onOpenFile={(path) => openFileTab(path, 'default')}
                        onOpenFilePinned={(path) => openFileTab(path, 'pinned')}
                    />
                );
            }
        }
        if (resource?.kind === 'terminal') {
            const fallbackTerminalInstanceId =
                typeof tab?.key === 'string' && tab.key.startsWith('terminal:')
                    ? tab.key.slice('terminal:'.length)
                    : SESSION_PRIMARY_TERMINAL_INSTANCE_ID;
            const terminalInstanceId = readTerminalDetailsInstanceId(tab.resource, fallbackTerminalInstanceId);
            if (terminalInstanceId) {
                return (
                    <SessionEmbeddedTerminalPane
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        currentDockLocation="details"
                        terminalInstanceId={terminalInstanceId}
                        testIdPrefix={sessionScreenTestIdsEnabled ? 'session-details-terminal' : null}
                    />
                );
            }
        }
        if (resource?.kind === 'subagent') {
            if (isSubagentResource(tab.resource)) {
                return (
                    <SessionSubagentDetailsViewForPanel
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        subagentId={tab.resource.subagentId}
                    />
                );
            }
        }
        if (resource?.kind === 'executionRunLauncher') {
            if (isExecutionRunLauncherResource(tab.resource)) {
                return (
                    <SessionExecutionRunLauncherView
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        presentation="panel"
                        initialIntent={tab.resource.intent}
                        onRequestClose={() => pane.closeDetailsTab(tab.key)}
                    />
                );
            }
        }
        const providerDetailsTab = renderProviderSessionDetailsTab({
            sessionId: props.sessionId,
            scopeId: props.scopeId,
            tab,
        });
        if (providerDetailsTab) {
            return providerDetailsTab;
        }

        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Text style={{ color: theme.colors.text.secondary, fontSize: 13, ...Typography.default(), textAlign: 'center' }}>
                    {t('session.detailsPanel.unsupportedTab')}
                </Text>
            </View>
        );
    }, [getStartEditingFileHandler, openFileTab, pane, props.localServicePreviewState, props.pluginUiProjection, props.scopeId, props.sessionId, requestClose, sessionScreenTestIdsEnabled, theme.colors.text.secondary]);

    const iconButtonStyle = {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    };

    const testIds = React.useMemo(() => ({
        root: resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-panel-root') ?? 'session-details-panel-root',
        tab: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-${safeTabKey}`),
        tabPin: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-pin-${safeTabKey}`),
        tabUnpin: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-unpin-${safeTabKey}`),
        tabClose: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-close-${safeTabKey}`),
    }), [sessionScreenTestIdsEnabled]);

    const closeButton = (
        <Pressable
            onPress={requestClose}
            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-close')}
            style={closeButtonAtStart ? undefined : iconButtonStyle}
            hitSlop={closeButtonAtStart ? 15 : undefined}
            accessibilityRole="button"
            accessibilityLabel={closeButtonAtStart ? t('common.back') : t('session.detailsPanel.closeA11y')}
        >
            {closeButtonAtStart ? (
                <SafeIonicons
                    name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                    size={24}
                    color={theme.colors.chrome.header.foreground}
                />
            ) : (
                <Octicons name="chevron-right" size={18} color={theme.colors.text.secondary} />
            )}
        </Pressable>
    );

    const toggleRightPane = React.useCallback(() => {
        if (rightPaneOpen) {
            pane.closeRight();
            return;
        }
        pane.openRight();
    }, [pane, rightPaneOpen]);

    const renderHeaderLeadingActions = React.useCallback(() => (
        showHeaderActions && closeButtonAtStart ? closeButton : null
    ), [closeButton, closeButtonAtStart, showHeaderActions]);

    const renderHeaderActions = React.useCallback(() => {
        if (!showHeaderActions) {
            return null;
        }

        return (
            <>
                {Platform.OS === 'web' ? (
                    <Pressable
                        onPress={paneFocusMode.toggle}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-focus-toggle')}
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        disabled={!paneFocusMode.canEnter}
                        accessibilityLabel={
                            paneFocusMode.active
                                ? t('session.detailsPanel.exitFocusModeA11y')
                                : t('session.detailsPanel.enterFocusModeA11y')
                        }
                    >
                        <Ionicons
                            name={paneFocusMode.active ? 'contract-outline' : 'expand-outline'}
                            size={18}
                            color={theme.colors.text.secondary}
                        />
                    </Pressable>
                ) : null}
                {showRightPaneToggle ? (
                    <Pressable
                        onPress={toggleRightPane}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-right-pane-toggle')}
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={
                            rightPaneOpen
                                ? t('session.detailsPanel.closeRightSidebarA11y')
                                : t('session.detailsPanel.openRightSidebarA11y')
                        }
                    >
                        <Octicons
                            name={rightPaneOpen ? 'sidebar-collapse' : 'sidebar-expand'}
                            size={18}
                            color={theme.colors.text.secondary}
                        />
                    </Pressable>
                ) : null}
                {closeButtonAtStart ? null : closeButton}
            </>
        );
    }, [
        closeButton,
        closeButtonAtStart,
        iconButtonStyle,
        paneFocusMode.active,
        paneFocusMode.canEnter,
        paneFocusMode.toggle,
        rightPaneOpen,
        sessionScreenTestIdsEnabled,
        showHeaderActions,
        showRightPaneToggle,
        theme.colors.text.secondary,
        toggleRightPane,
    ]);

    return (
        <DetailsSplitWorkspace
            pane={pane}
            paddingTop={panelPaddingTop}
            headerPaddingTop={10}
            testIds={testIds}
            resolveTabIconName={(tab) =>
                resolvePluginSessionSurfaceTabIconName({
                    tab,
                    pluginUiProjection: props.pluginUiProjection,
                }) ?? resolveProviderSessionDetailsTabIconName(tab)
            }
            renderTabContent={renderTabContent}
            renderHeaderLeadingActions={renderHeaderLeadingActions}
            renderHeaderActions={renderHeaderActions}
        />
    );
});
