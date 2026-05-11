import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneFocusMode } from '@/components/appShell/panes/focusMode/usePaneFocusMode';
import { useDeviceType } from '@/utils/platform/responsive';
import { useAllMachines, useWorkspaceReviewCommentsDrafts } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { WorkspaceFileDetailsView, type WorkspaceFileDeepLinkAnchor } from '@/components/workspaces/files/details/WorkspaceFileDetailsView';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { WorkspaceCommitDetailsView } from '@/components/projects/panes/details/views/WorkspaceCommitDetailsView';
import { WorkspaceScmReviewDetailsView } from '@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView';
import { WorkspaceScmStashDetailsView } from '@/components/projects/panes/details/views/WorkspaceScmStashDetailsView';
import type { DetailsTabState } from '@/components/appShell/panes/model/appPaneReducer';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { ProjectTerminalSurface } from '@/components/projects/detail/surfaces/ProjectTerminalSurface';
import { readTerminalDetailsCwd, readTerminalDetailsInstanceId } from '@/components/terminal/terminalDetailsTabModel';
import { openProjectTerminalDetailsTab } from '@/components/projects/detail/openProjectTerminalDetailsTab';

export type WorkspaceDetailsPanelHeaderActionRenderParams = Readonly<{
    iconButtonStyle: Readonly<Record<string, unknown>>;
    iconColor: string;
}>;

export type WorkspaceDetailsPanelProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath?: string;
    displayPathOverride?: string;
    forceOverviewMode?: boolean;
    showTerminalHeaderAction?: boolean;
    showFocusModeToggle?: boolean;
    sessionIdForAugmentation?: string | null;
    /**
     * Optional override for the close action. Used by fullscreen/mobile routes that render the same
     * surface as the desktop details pane but need to navigate back in the router stack.
     */
    onRequestClose?: () => void;
    renderHeaderActionsPrefix?: (params: WorkspaceDetailsPanelHeaderActionRenderParams) => React.ReactNode;
    renderEmptyStateSupplementaryContent?: () => React.ReactNode;
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

export const WorkspaceDetailsPanel = React.memo((props: WorkspaceDetailsPanelProps) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const insets = useChromeSafeAreaInsets();
    const pane = useAppPaneScope(props.scopeId);
    const deviceType = useDeviceType();
    const requestClose = props.onRequestClose ?? pane.closeDetails;
    const effectiveRootPath = props.activeRootPath ?? props.workspaceRef.rootPath;
    const displayPath = props.displayPathOverride ?? props.workspaceRef.rootPath;
    const paneFocusMode = usePaneFocusMode(props.scopeId);
    const allMachines = useAllMachines();

    const workspaceScope = React.useMemo((): WorkspaceScopeBase => ({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: effectiveRootPath,
    }), [effectiveRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);

    const workspaceCacheKey = React.useMemo(() => buildWorkspaceCacheKey(workspaceScope), [workspaceScope]);
    const workspaceReviewCommentDrafts = useWorkspaceReviewCommentsDrafts(workspaceScope);
    const hasWorkspaceReviewCommentDrafts = workspaceReviewCommentDrafts.length > 0;

    const machineName = React.useMemo(() => {
        const machine = allMachines.find((m) => m.id === props.workspaceRef.machineId) ?? null;
        return getMachineDisplayName(machine) ?? props.workspaceRef.machineId;
    }, [allMachines, props.workspaceRef.machineId]);

    const displayName = React.useMemo(() => resolveWorkspaceRefDisplayName(props.workspaceRef), [props.workspaceRef]);

    const iconButtonStyle = React.useMemo(() => ({
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    }), [theme.colors.border.default, theme.colors.surface.base]);

    const openFileTab = React.useCallback((path: string, intent: 'default' | 'pinned' = 'default') => {
        const fileName = path.split('/').pop() ?? path;
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: `file:${path}`,
                    kind: 'file',
                    title: fileName,
                    resource: { kind: 'file', path },
                },
                { intent },
            );
        });
    }, [pane]);

    const renderEmptyState = React.useCallback(() => (
        <ItemList testID="project-details-info" containerStyle={{ paddingTop: 12 }}>
            <ItemGroup title={t('projects.detail.groupTitle')}>
                <Item title={t('projects.detail.fields.name')} detail={displayName} mode="info" />
                <Item title={t('projects.detail.fields.machine')} detail={machineName} mode="info" />
                <Item title={t('projects.detail.fields.path')} detail={displayPath} mode="info" copy={displayPath} />
            </ItemGroup>
            {props.renderEmptyStateSupplementaryContent ? props.renderEmptyStateSupplementaryContent() : null}
            <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: 6 }}>
                <Text style={{ color: theme.colors.text.secondary, fontSize: 13, ...Typography.default(), textAlign: 'center', maxWidth: 680 }}>
                    {t('projects.details.emptyBody')}
                </Text>
            </View>
        </ItemList>
    ), [displayName, displayPath, machineName, props, theme.colors.text.secondary]);

    const renderWorkspaceInfo = React.useCallback(() => (
        <ItemList testID="project-details-workspace-info" containerStyle={{ paddingTop: 12 }}>
            <ItemGroup title={t('projects.detail.groupTitle')}>
                <Item title={t('projects.detail.fields.name')} detail={displayName} mode="info" />
                <Item title={t('projects.detail.fields.machine')} detail={machineName} mode="info" />
                <Item title={t('projects.detail.fields.path')} detail={displayPath} mode="info" copy={displayPath} />
            </ItemGroup>
        </ItemList>
    ), [displayName, displayPath, machineName]);

    function readOptionalString(value: unknown): string | null {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    function readDeepLinkAnchor(resource: unknown): WorkspaceFileDeepLinkAnchor | null {
        if (resource == null || typeof resource !== 'object') return null;
        if (!('deepLinkAnchor' in resource)) return null;
        const value = (resource as { deepLinkAnchor?: unknown }).deepLinkAnchor;
        if (value == null || typeof value !== 'object') return null;
        if (!('source' in value) || !('anchor' in value)) return null;
        return value as WorkspaceFileDeepLinkAnchor;
    }

    function readCommitSha(resource: unknown): string {
        if (resource == null || typeof resource !== 'object') return '';
        const r = resource as { sha?: unknown; commitHash?: unknown };
        return readOptionalString(r.sha) ?? readOptionalString(r.commitHash) ?? '';
    }

    const renderTabContent = React.useCallback((tab: DetailsTabState) => {
        const resource = asResource(tab?.resource);

        if (tab?.kind === 'workspaceInfo' || resource?.kind === 'workspaceInfo') {
            return renderWorkspaceInfo();
        }

        if (resource?.kind === 'file') {
            if (isFileResource(tab.resource)) {
                const anchor = readDeepLinkAnchor(tab.resource);
                return (
                    <WorkspaceFileDetailsView
                        scopeId={props.scopeId}
                        scope={workspaceScope}
                        filePath={tab.resource.path}
                        deepLinkAnchor={anchor}
                        presentation={deviceType === 'phone' ? 'screen' : 'panel'}
                        sessionIdForAugmentation={props.sessionIdForAugmentation ?? null}
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
                const sha = readCommitSha(tab.resource);
                return (
                    <WorkspaceCommitDetailsView
                        scopeId={props.scopeId}
                        workspaceRefId={props.workspaceRef.id}
                        workspaceCacheKey={workspaceCacheKey}
                        machineId={props.workspaceRef.machineId}
                        rootPath={effectiveRootPath}
                        serverId={props.workspaceRef.serverId}
                        sha={sha}
                        presentation={deviceType === 'phone' ? 'screen' : 'panel'}
                        onOpenFile={(path) => openFileTab(path, 'default')}
                        onOpenFilePinned={(path) => openFileTab(path, 'pinned')}
                    />
                );
            }
        }

        if (resource?.kind === 'scmReview') {
            if (isScmReviewResource(tab.resource)) {
                return (
                    <WorkspaceScmReviewDetailsView
                        scopeId={props.scopeId}
                        workspaceRefId={props.workspaceRef.id}
                        workspaceCacheKey={workspaceCacheKey}
                        machineId={props.workspaceRef.machineId}
                        rootPath={effectiveRootPath}
                        serverId={props.workspaceRef.serverId}
                        onOpenFile={(path) => openFileTab(path, 'default')}
                        onOpenFilePinned={(path) => openFileTab(path, 'pinned')}
                    />
                );
            }
        }

        if (resource?.kind === 'scmStash') {
            if (isScmStashResource(tab.resource)) {
                return (
                    <WorkspaceScmStashDetailsView
                        scopeId={props.scopeId}
                        workspaceRefId={props.workspaceRef.id}
                        workspaceCacheKey={workspaceCacheKey}
                        machineId={props.workspaceRef.machineId}
                        rootPath={effectiveRootPath}
                        serverId={props.workspaceRef.serverId}
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
                    : 'main';
            const terminalInstanceId = readTerminalDetailsInstanceId(tab.resource, fallbackTerminalInstanceId);
            if (terminalInstanceId) {
                return (
                    <ProjectTerminalSurface
                        scopeId={props.scopeId}
                        workspaceRefId={props.workspaceRef.id}
                        machineId={props.workspaceRef.machineId}
                        rootPath={readTerminalDetailsCwd(tab.resource) ?? effectiveRootPath}
                        serverId={props.workspaceRef.serverId}
                        terminalInstanceId={terminalInstanceId}
                        closeOnUnmount={true}
                    />
                );
            }
        }

        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Octicons name="info" size={18} color={theme.colors.text.secondary} />
                <Text style={{ marginTop: 10, color: theme.colors.text.secondary, fontSize: 13, ...Typography.default(), textAlign: 'center', maxWidth: 520 }}>
                    {t('projects.details.placeholderUnsupportedBody')}
                </Text>
            </View>
        );
    }, [
        deviceType,
        openFileTab,
        pane,
        props.scopeId,
        props.sessionIdForAugmentation,
        props.workspaceRef.id,
        props.workspaceRef.machineId,
        props.workspaceRef.serverId,
        renderWorkspaceInfo,
        theme.colors.text.secondary,
        workspaceCacheKey,
        workspaceScope,
        effectiveRootPath,
    ]);

    const renderHeaderActions = React.useCallback(() => {
        const openNewSessionWithReviewComments = () => {
            router.push({
                pathname: '/new',
                params: {
                    machineId: props.workspaceRef.machineId,
                    directory: effectiveRootPath,
                    spawnServerId: props.workspaceRef.serverId,
                },
            });
        };
        return (
            <>
                {props.renderHeaderActionsPrefix ? props.renderHeaderActionsPrefix({ iconButtonStyle, iconColor: theme.colors.text.secondary }) : null}
                {hasWorkspaceReviewCommentDrafts ? (
                    <Pressable
                        onPress={openNewSessionWithReviewComments}
                        testID="workspace-details-open-review-comments-session"
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={t('newSession.title')}
                    >
                        <Ionicons name="chatbox-ellipses-outline" size={18} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
                {props.showTerminalHeaderAction !== false && deviceType !== 'phone' ? (
                    <Pressable
                        onPress={() => {
                            openProjectTerminalDetailsTab({
                                openDetailsTab: pane.openDetailsTab,
                                cwd: effectiveRootPath,
                            });
                        }}
                        testID="workspace-details-open-terminal"
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={t('settings.terminal')}
                    >
                        <Ionicons name="terminal-outline" size={18} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
                {props.showFocusModeToggle !== false && Platform.OS === 'web' ? (
                    <Pressable
                        onPress={paneFocusMode.toggle}
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
                {props.onRequestClose && deviceType !== 'phone' ? (
                    <Pressable
                        onPress={requestClose}
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                    >
                        <Octicons name="chevron-right" size={18} color={theme.colors.text.secondary} />
                    </Pressable>
                ) : null}
            </>
        );
    }, [
        iconButtonStyle,
        hasWorkspaceReviewCommentDrafts,
        pane,
        paneFocusMode.active,
        paneFocusMode.canEnter,
        paneFocusMode.toggle,
        props.onRequestClose,
        props.renderHeaderActionsPrefix,
        props.workspaceRef.machineId,
        props.workspaceRef.serverId,
        requestClose,
        router,
        theme.colors.text.secondary,
        deviceType,
        effectiveRootPath,
    ]);

    return (
        <DetailsSplitWorkspace
            pane={pane}
            paddingTop={insets.top}
            headerPaddingTop={10}
            testIds={{
                root: 'workspace-details-panel-root',
                tab: (safeTabKey) => `workspace-details-tab-${safeTabKey}`,
                tabClose: (safeTabKey) => `workspace-details-tab-close-${safeTabKey}`,
            }}
            forceEmptyState={props.forceOverviewMode}
            renderTabContent={renderTabContent}
            renderHeaderActions={renderHeaderActions}
            renderEmptyState={renderEmptyState}
        />
    );
});
