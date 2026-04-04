import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { PaneDetailsTabsPanel } from '@/components/appShell/panes/details/PaneDetailsTabsPanel';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDeviceType } from '@/utils/platform/responsive';
import { useAllMachines, useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { WorkspaceFileDetailsView, type WorkspaceFileDeepLinkAnchor } from '@/components/workspaces/files/details/WorkspaceFileDetailsView';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { WorkspaceCommitDetailsView } from '@/components/projects/panes/details/views/WorkspaceCommitDetailsView';
import { WorkspaceScmReviewDetailsView } from '@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView';
import { WorkspaceScmStashDetailsView } from '@/components/projects/panes/details/views/WorkspaceScmStashDetailsView';
import { WorkspaceEmbeddedTerminalPane } from '@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane';
import type { DetailsTabState } from '@/components/appShell/panes/model/appPaneReducer';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';

export type WorkspaceDetailsPanelHeaderActionRenderParams = Readonly<{
    iconButtonStyle: Readonly<Record<string, unknown>>;
    iconColor: string;
}>;

export type WorkspaceDetailsPanelProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    sessionIdForAugmentation?: string | null;
    /**
     * Optional override for the close action. Used by fullscreen/mobile routes that render the same
     * surface as the desktop details pane but need to navigate back in the router stack.
     */
    onRequestClose?: () => void;
    renderHeaderActionsPrefix?: (params: WorkspaceDetailsPanelHeaderActionRenderParams) => React.ReactNode;
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

function isTerminalResource(value: unknown): value is Readonly<{ kind: 'terminal' }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown };
    return maybe.kind === 'terminal';
}

export const WorkspaceDetailsPanel = React.memo((props: WorkspaceDetailsPanelProps) => {
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const pane = useAppPaneScope(props.scopeId);
    const deviceType = useDeviceType();
    const requestClose = props.onRequestClose ?? pane.closeDetails;

    const editorFocusModeEnabled = useLocalSetting('editorFocusModeEnabled');
    const [, setEditorFocusModeEnabled] = useLocalSettingMutable('editorFocusModeEnabled');
    const allMachines = useAllMachines();

    const workspaceScope = React.useMemo((): WorkspaceScopeBase => ({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.workspaceRef.rootPath,
    }), [props.workspaceRef.machineId, props.workspaceRef.rootPath, props.workspaceRef.serverId]);

    const workspaceCacheKey = React.useMemo(() => buildWorkspaceCacheKey(workspaceScope), [workspaceScope]);

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
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    }), [theme.colors.divider, theme.colors.surface]);

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
                <Item title={t('projects.detail.fields.path')} detail={props.workspaceRef.rootPath} mode="info" copy={props.workspaceRef.rootPath} />
            </ItemGroup>
            <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: 6 }}>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13, ...Typography.default(), textAlign: 'center', maxWidth: 680 }}>
                    {t('projects.details.emptyBody')}
                </Text>
            </View>
        </ItemList>
    ), [displayName, machineName, props.workspaceRef.rootPath, theme.colors.textSecondary]);

    const renderWorkspaceInfo = React.useCallback(() => (
        <ItemList testID="project-details-workspace-info" containerStyle={{ paddingTop: 12 }}>
            <ItemGroup title={t('projects.detail.groupTitle')}>
                <Item title={t('projects.detail.fields.name')} detail={displayName} mode="info" />
                <Item title={t('projects.detail.fields.machine')} detail={machineName} mode="info" />
                <Item title={t('projects.detail.fields.path')} detail={props.workspaceRef.rootPath} mode="info" copy={props.workspaceRef.rootPath} />
            </ItemGroup>
        </ItemList>
    ), [displayName, machineName, props.workspaceRef.rootPath]);

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
                        rootPath={props.workspaceRef.rootPath}
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
                        rootPath={props.workspaceRef.rootPath}
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
                        rootPath={props.workspaceRef.rootPath}
                        serverId={props.workspaceRef.serverId}
                        onOpenFile={(path) => openFileTab(path, 'default')}
                        onOpenFilePinned={(path) => openFileTab(path, 'pinned')}
                    />
                );
            }
        }

        if (resource?.kind === 'terminal') {
            if (isTerminalResource(tab.resource)) {
                return (
                    <WorkspaceEmbeddedTerminalPane
                        scopeId={props.scopeId}
                        workspaceRefId={props.workspaceRef.id}
                        machineId={props.workspaceRef.machineId}
                        rootPath={props.workspaceRef.rootPath}
                        serverId={props.workspaceRef.serverId}
                    />
                );
            }
        }

        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Octicons name="info" size={18} color={theme.colors.textSecondary} />
                <Text style={{ marginTop: 10, color: theme.colors.textSecondary, fontSize: 13, ...Typography.default(), textAlign: 'center', maxWidth: 520 }}>
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
        props.workspaceRef.rootPath,
        props.workspaceRef.serverId,
        renderWorkspaceInfo,
        theme.colors.textSecondary,
        workspaceCacheKey,
        workspaceScope,
    ]);

    const renderHeaderActions = React.useCallback(() => {
        const openTerminal = () => {
            deferOnWeb(() => {
                pane.openDetailsTab(
                    {
                        key: 'terminal',
                        kind: 'terminal',
                        title: t('settings.terminal'),
                        resource: { kind: 'terminal' },
                    },
                    { intent: 'pinned' },
                );
            });
        };
        return (
            <>
                {props.renderHeaderActionsPrefix ? props.renderHeaderActionsPrefix({ iconButtonStyle, iconColor: theme.colors.textSecondary }) : null}
                <Pressable
                    onPress={openTerminal}
                    testID="workspace-details-open-terminal"
                    style={iconButtonStyle}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.terminal')}
                >
                    <Ionicons name="terminal-outline" size={18} color={theme.colors.textSecondary} />
                </Pressable>
                {Platform.OS === 'web' ? (
                    <Pressable
                        onPress={() => setEditorFocusModeEnabled(!editorFocusModeEnabled)}
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
                {props.onRequestClose && deviceType !== 'phone' ? (
                    <Pressable
                        onPress={requestClose}
                        style={iconButtonStyle}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                    >
                        <Octicons name="chevron-right" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                ) : null}
            </>
        );
    }, [
        editorFocusModeEnabled,
        iconButtonStyle,
        pane,
        props.onRequestClose,
        props.renderHeaderActionsPrefix,
        requestClose,
        setEditorFocusModeEnabled,
        theme.colors.textSecondary,
    ]);

    return (
        <PaneDetailsTabsPanel
            pane={pane}
            paddingTop={insets.top}
            headerPaddingTop={10}
            testIds={{ root: 'workspace-details-panel-root' }}
            renderTabContent={renderTabContent}
            renderHeaderActions={renderHeaderActions}
            renderEmptyState={renderEmptyState}
        />
    );
});
