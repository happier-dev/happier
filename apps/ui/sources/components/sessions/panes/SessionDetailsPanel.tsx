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
import {
    renderProviderSessionDetailsTab,
    resolveProviderSessionDetailsTabIconName,
} from '@/agents/registry/sessionSubagentUiBehavior';
import { SessionExecutionRunLauncherView } from '@/components/sessions/runs/launcher/SessionExecutionRunLauncherView';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import { SESSION_PRIMARY_TERMINAL_INSTANCE_ID } from '@/components/sessions/terminal/embeddedTerminalDocking';
import { readTerminalDetailsInstanceId } from '@/components/terminal/terminalDetailsTabModel';
import { t } from '@/text';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';
import { createSessionFileDetailsTab } from './details/sessionDetailsTabBuilders';

export type SessionDetailsPanelProps = Readonly<{
    sessionId: string;
    scopeId: string;
    /**
     * Optional override for the close action. Used by fullscreen/mobile routes that render the same
     * surface as the desktop details pane but need to navigate back in the router stack.
     */
    onRequestClose?: () => void;
}>;

const LazySessionFileDetailsView = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionFileDetailsView');
    return { default: mod.SessionFileDetailsView };
});

const LazySessionCommitDetailsView = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionCommitDetailsView');
    return { default: mod.SessionCommitDetailsView };
});

const LazySessionScmReviewDetailsView = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
    return { default: mod.SessionScmReviewDetailsView };
});

const LazySessionScmStashDetailsView = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionScmStashDetailsView');
    return { default: mod.SessionScmStashDetailsView };
});

const LazySessionSubagentDetailsView = React.lazy(async () => {
    const mod = await import('@/components/sessions/agents/details/SessionSubagentDetailsView');
    return { default: mod.SessionSubagentDetailsView };
});

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
    const editorFocusModeEnabled = useLocalSetting('editorFocusModeEnabled');
    const [, setEditorFocusModeEnabled] = useLocalSettingMutable('editorFocusModeEnabled');
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();

    const openFileTab = React.useCallback((path: string, intent: 'default' | 'pinned' = 'default') => {
        deferOnWeb(() => {
            pane.openDetailsTab(createSessionFileDetailsTab(path), { intent });
        });
    }, [pane]);

    const renderTabContent = React.useCallback((tab: any) => {
        const resource = asResource(tab.resource);
        if (resource?.kind === 'file') {
            if (isFileResource(tab.resource)) {
                const anchor = (tab.resource as any)?.deepLinkAnchor ?? null;
                return (
                    <LazySessionFileDetailsView
                        sessionId={props.sessionId}
                        filePath={tab.resource.path}
                        deepLinkAnchor={anchor}
                        presentation="panel"
                        scopeId={props.scopeId}
                        onStartEditingFile={() => {
                            if (tab.isPreview) {
                                pane.pinDetailsTab(tab.key);
                            }
                        }}
                    />
                );
            }
        }
        if (resource?.kind === 'commit') {
            if (isCommitResource(tab.resource)) {
                const sha = (tab.resource as any)?.sha ?? (tab.resource as any)?.commitHash ?? '';
                return (
                    <LazySessionCommitDetailsView
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
                    <LazySessionScmReviewDetailsView sessionId={props.sessionId} scopeId={props.scopeId} />
                );
            }
        }
        if (resource?.kind === 'scmStash') {
            if (isScmStashResource(tab.resource)) {
                return (
                    <LazySessionScmStashDetailsView
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
                    <LazySessionSubagentDetailsView
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
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13, ...Typography.default(), textAlign: 'center' }}>
                    {t('session.detailsPanel.unsupportedTab')}
                </Text>
            </View>
        );
    }, [openFileTab, pane, props.scopeId, props.sessionId, requestClose, sessionScreenTestIdsEnabled, theme.colors.textSecondary]);

    const iconButtonStyle = {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    };

    const testIds = React.useMemo(() => ({
        root: resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-panel-root') ?? 'session-details-panel-root',
        tab: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-${safeTabKey}`),
        tabPin: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-pin-${safeTabKey}`),
        tabUnpin: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-unpin-${safeTabKey}`),
        tabClose: (safeTabKey: string) => resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-close-${safeTabKey}`),
    }), [sessionScreenTestIdsEnabled]);

    const renderHeaderActions = React.useCallback(() => (
        <>
            {Platform.OS === 'web' ? (
                <Pressable
                    onPress={() => setEditorFocusModeEnabled(!editorFocusModeEnabled)}
                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-focus-toggle')}
                    style={iconButtonStyle}
                    accessibilityRole="button"
                    accessibilityLabel={
                        editorFocusModeEnabled
                            ? t('session.detailsPanel.exitFocusModeA11y')
                            : t('session.detailsPanel.enterFocusModeA11y')
                    }
                >
                    <Ionicons
                        name={editorFocusModeEnabled ? 'contract-outline' : 'expand-outline'}
                        size={18}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            ) : null}
            <Pressable
                onPress={requestClose}
                testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-close')}
                style={iconButtonStyle}
                accessibilityRole="button"
                accessibilityLabel={t('session.detailsPanel.closeA11y')}
            >
                <Octicons name="chevron-right" size={18} color={theme.colors.textSecondary} />
            </Pressable>
        </>
    ), [
        editorFocusModeEnabled,
        iconButtonStyle,
        requestClose,
        sessionScreenTestIdsEnabled,
        setEditorFocusModeEnabled,
        theme.colors.textSecondary,
    ]);

    return (
        <DetailsSplitWorkspace
            pane={pane}
            paddingTop={insets.top}
            headerPaddingTop={10}
            testIds={testIds}
            resolveTabIconName={(tab) => resolveProviderSessionDetailsTabIconName(tab)}
            renderTabContent={renderTabContent}
            renderHeaderActions={renderHeaderActions}
        />
    );
});
