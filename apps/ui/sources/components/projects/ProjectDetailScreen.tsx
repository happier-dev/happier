import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useResolvedRepoWorktreeSelection } from '@/components/workspaces/scm/worktrees/useResolvedRepoWorktreeSelection';
import { findVisibleRepoWorktreeByPath } from '@/components/workspaces/scm/worktrees/repoWorktreeIdentity';
import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import { PROJECT_ROUTE_ROOT_SENTINEL } from './detail/projectRouteState';
import { resolveProjectRightTabId } from './detail/resolveProjectRightTabId';
import { useWorkspaceRefById } from './detail/useWorkspaceRefById';
import { ProjectRightPanel } from './detail/ProjectRightPanel';
import { ProjectDetailsMainPanel } from './detail/ProjectDetailsMainPanel';
import { ProjectWorktreeRecoveryToast } from './detail/ProjectWorktreeRecoveryToast';
import { useProjectOverviewMode } from './detail/useProjectOverviewMode';
import { Icon } from '@/components/ui/icons/Icon';

export const ProjectDetailScreen = React.memo((props: Readonly<{
    workspaceRefId: string;
    activeRootPath?: string | null;
    isFocused?: boolean;
    showWorktrees?: boolean;
    onSelectRootPath?: (path: string) => void;
    onSetShowWorktrees?: (nextValue: boolean) => void;
    onPluginSurfaceOpenChange?: (handler: PluginSurfaceOpenHandler | undefined) => void;
}>) => {
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');
    const [, setLastActiveRootPathByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveRootPathByWorkspaceRefId');
    const [, setLastActiveWorktreeIdByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveWorktreeIdByWorkspaceRefId');
    const scopeId = React.useMemo(() => buildProjectPaneScopeId(props.workspaceRefId), [props.workspaceRefId]);
    const pane = useAppPaneScope(scopeId);
    const workspaceRef = useWorkspaceRefById(props.workspaceRefId);
    // This direct Project adapter is the one public target/currentness source
    // consumed by AppPane. Keep the projection lookup here rather than giving
    // AppPane a fallback lookup keyed by an opaque scope id.
    const pluginProjection = useScopedPluginUiProjection({
        machineId: workspaceRef?.machineId ?? null,
        serverId: workspaceRef?.serverId ?? null,
    });
    const [localActiveRootPath, setLocalActiveRootPath] = React.useState<string | null>(null);
    const controlledActiveRootPath = props.activeRootPath ?? null;
    const workspaceRootPath = workspaceRef?.rootPath ?? '';
    const persistedActiveRootPath = React.useMemo(() => {
        if (!workspaceRef) return null;
        const value = lastActiveRootPathByWorkspaceRefId?.[workspaceRef.id];
        return typeof value === 'string' && value.trim().length > 0 ? value : null;
    }, [lastActiveRootPathByWorkspaceRefId, workspaceRef]);
    React.useEffect(() => {
        if (!workspaceRef) return;
        if (controlledActiveRootPath != null) return;
        setLocalActiveRootPath((currentPath) => {
            if (currentPath == null) {
                return persistedActiveRootPath ?? workspaceRef.rootPath;
            }
            if (
                persistedActiveRootPath
                && currentPath === workspaceRef.rootPath
                && persistedActiveRootPath !== workspaceRef.rootPath
            ) {
                return persistedActiveRootPath;
            }
            return currentPath;
        });
    }, [controlledActiveRootPath, persistedActiveRootPath, workspaceRef]);

    React.useEffect(() => {
        if (!workspaceRef) return;
        if (!multiPaneEnabled) return;
        if (!(Platform.OS === 'web' || deviceType === 'tablet')) return;
        const right = pane.scopeState?.right ?? null;
        if (!right) return;
        if (right.isOpen === true) return;
        if (right.selectedDestination != null) {
            // Reopening is a layout action, not a destination choice. Passing
            // the retained built-in tab here would replace a restored plugin
            // selection before its current projection can resolve.
            pane.openRight();
            return;
        }
        const preferredTab = resolveProjectRightTabId(right.activeTabId);
        pane.openRight({ tabId: preferredTab });
        pane.setRightTab(preferredTab);
    }, [deviceType, multiPaneEnabled, pane, workspaceRef]);

    const detailsState = pane.scopeState?.details ?? null;
    const { forceOverviewMode } = useProjectOverviewMode({
        showWorktrees: props.showWorktrees,
        onSetShowWorktrees: props.onSetShowWorktrees,
        detailsState,
    });
    const requestedActiveRootPath = controlledActiveRootPath ?? localActiveRootPath ?? persistedActiveRootPath ?? workspaceRootPath;
    const {
        requestedRootPath,
        resolvedRootPath: resolvedActiveRootPath,
        resolvedWorktreeId: resolvedActiveWorktreeId,
        didRecoverMissingWorktree,
        availableWorktrees,
    } = useResolvedRepoWorktreeSelection({
        serverId: workspaceRef?.serverId ?? '',
        machineId: workspaceRef?.machineId ?? '',
        defaultRootPath: workspaceRootPath,
        requestedRootPath: requestedActiveRootPath,
            requestedWorktreeId: workspaceRef != null
            && controlledActiveRootPath == null
            && localActiveRootPath == null
            && typeof lastActiveWorktreeIdByWorkspaceRefId?.[workspaceRef.id] === 'string'
            && lastActiveWorktreeIdByWorkspaceRefId[workspaceRef.id] !== PROJECT_ROUTE_ROOT_SENTINEL
                ? lastActiveWorktreeIdByWorkspaceRefId[workspaceRef.id]
                : null,
    });
    const recoveryToastKey = didRecoverMissingWorktree
        ? `${workspaceRef?.id ?? props.workspaceRefId}:${requestedRootPath}`
        : null;
    const handleSelectRootPath = React.useCallback((path: string) => {
        const trimmedPath = path.trim();
        if (!trimmedPath || !workspaceRef) return;
        const nextWorktreeId = trimmedPath === workspaceRef.rootPath
            ? null
            : (findVisibleRepoWorktreeByPath(availableWorktrees, trimmedPath)?.id ?? null);
        if (controlledActiveRootPath == null) {
            setLocalActiveRootPath(trimmedPath);
        }
        setLastActiveRootPathByWorkspaceRefId({
            ...(lastActiveRootPathByWorkspaceRefId ?? {}),
            [props.workspaceRefId]: trimmedPath,
        });
        setLastActiveWorktreeIdByWorkspaceRefId({
            ...(lastActiveWorktreeIdByWorkspaceRefId ?? {}),
            [props.workspaceRefId]: nextWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL,
        });
        props.onSelectRootPath?.(trimmedPath);
    }, [
        availableWorktrees,
        controlledActiveRootPath,
        lastActiveRootPathByWorkspaceRefId,
        lastActiveWorktreeIdByWorkspaceRefId,
        props.onSelectRootPath,
        props.workspaceRefId,
        setLastActiveRootPathByWorkspaceRefId,
        setLastActiveWorktreeIdByWorkspaceRefId,
        workspaceRef,
    ]);

    React.useEffect(() => {
        if (props.isFocused === false) return;
        if (!workspaceRef) return;
        if (requestedRootPath === resolvedActiveRootPath) return;

        setLastActiveRootPathByWorkspaceRefId({
            ...(lastActiveRootPathByWorkspaceRefId ?? {}),
            [props.workspaceRefId]: resolvedActiveRootPath,
        });
        setLastActiveWorktreeIdByWorkspaceRefId({
            ...(lastActiveWorktreeIdByWorkspaceRefId ?? {}),
            [props.workspaceRefId]: resolvedActiveWorktreeId ?? PROJECT_ROUTE_ROOT_SENTINEL,
        });

        if (controlledActiveRootPath == null) {
            setLocalActiveRootPath(resolvedActiveRootPath);
        }

        if (controlledActiveRootPath != null) {
            props.onSelectRootPath?.(resolvedActiveRootPath);
        }
    }, [
        controlledActiveRootPath,
        lastActiveRootPathByWorkspaceRefId,
        lastActiveWorktreeIdByWorkspaceRefId,
        props.isFocused,
        props.onSelectRootPath,
        props.workspaceRefId,
        requestedRootPath,
        resolvedActiveRootPath,
        resolvedActiveWorktreeId,
        setLastActiveRootPathByWorkspaceRefId,
        setLastActiveWorktreeIdByWorkspaceRefId,
        workspaceRef,
    ]);

    const projectSurfaceScope = React.useMemo(() => (
        workspaceRef
            ? {
                targetKind: 'project' as const,
                projectId: workspaceRef.id,
                machineId: workspaceRef.machineId,
                serverId: workspaceRef.serverId,
                pluginUiProjection: pluginProjection.pluginUiProjection,
                projectionPhase: pluginProjection.phase,
                interactionEnabled: pluginProjection.interactionEnabled,
                platform: pluginProjection.platform,
            }
            : null
    ), [
        pluginProjection.interactionEnabled,
        pluginProjection.phase,
        pluginProjection.platform,
        pluginProjection.pluginUiProjection,
        workspaceRef,
    ]);
    const renderProjectRightSidebar = React.useCallback(() => (
        workspaceRef
            ? <ProjectRightPanel
                scopeId={scopeId}
                workspaceRef={workspaceRef}
                activeRootPath={resolvedActiveRootPath}
                activeWorktreeId={resolvedActiveWorktreeId}
                onSelectRootPath={handleSelectRootPath}
            />
            : null
    ), [handleSelectRootPath, resolvedActiveRootPath, resolvedActiveWorktreeId, scopeId, workspaceRef]);
    const projectRightPaneBuiltinAdapter = React.useMemo(() => ({
        destinationIds: ['git', 'files', 'browser', 'services'],
        defaultDestinationId: 'files',
        render: renderProjectRightSidebar,
    }), [renderProjectRightSidebar]);
    const projectRightSidebarAdapter = React.useMemo(() => ({
        render: renderProjectRightSidebar,
    }), [renderProjectRightSidebar]);

    if (!workspaceRef) {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{ alignItems: 'center', paddingVertical: 32, paddingHorizontal: 16 }}>
                        <Icon
                            name="warning"
                            size={48}
                            color={theme.colors.text.secondary}
                            style={{ marginBottom: 12 }}
                        />
                        <View style={{ maxWidth: 520 }}>
                            <Text style={{
                                fontSize: 16,
                                ...Typography.default('semiBold'),
                                color: theme.colors.text.primary,
                                textAlign: 'center',
                                marginBottom: 6,
                            }}>
                                {t('projects.detail.notFoundTitle')}
                            </Text>
                            <Text style={{
                                fontSize: 14,
                                ...Typography.default(),
                                color: theme.colors.text.secondary,
                                textAlign: 'center',
                                lineHeight: 20,
                            }}>
                                {t('projects.detail.notFoundDescription')}
                            </Text>
                        </View>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <View style={{ flex: 1 }} {...pane.overlayFocusReturnCaptureProps}>
            <AppPaneScopeHost
                scopeId={scopeId}
                onPluginSurfaceOpenChange={props.onPluginSurfaceOpenChange}
                detailsPaneEnabled={false}
                surfaceScope={projectSurfaceScope!}
                rightPaneBuiltinAdapter={projectRightPaneBuiltinAdapter}
                rightSidebarAdapter={projectRightSidebarAdapter}
                main={(
                    <ProjectDetailsMainPanel
                        scopeId={scopeId}
                        workspaceRef={workspaceRef}
                        activeRootPath={resolvedActiveRootPath}
                        activeWorktreeId={resolvedActiveWorktreeId}
                        forceOverviewMode={forceOverviewMode}
                        onSelectRootPath={handleSelectRootPath}
                    />
                )}
            />
            <ProjectWorktreeRecoveryToast recoveryToastKey={recoveryToastKey} />
        </View>
    );
});
