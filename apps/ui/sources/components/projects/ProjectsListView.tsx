import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupTitleWithAction } from '@/components/ui/lists/ItemGroupTitleWithAction';
import { Item } from '@/components/ui/lists/Item';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import {
    useAllMachines,
    useLocalSetting,
    useProjectLastMobileSurfacesByWorkspaceRefId,
    useSettingMutable,
} from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { Modal } from '@/modal';
import { findWorkspaceRefByScope, upsertWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { workspaceListDirectory } from '@/sync/ops/workspaceFileSystem';
import { resolveMachineActionCandidates } from '@/utils/sessions/resolveMachineActionCandidates';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useDeviceType } from '@/utils/platform/responsive';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { buildProjectsListGroups } from './projectsListGrouping';
import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import {
    buildProjectRouteHref,
    resolveProjectRouteSegment,
    resolveProjectRouteSelectionQuery,
} from './detail/projectRouteState';
import { ProjectsListItemMenu } from './ProjectsListItemMenu';
import { resolveWorkspaceRefDisplayName } from './resolveWorkspaceRefDisplayName';
import { resolveProjectMobileSurfaceIntent, resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { Icon } from '@/components/ui/icons/Icon';

export const ProjectsListView = React.memo(() => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const deviceType = useDeviceType();
    const paneContext = useOptionalAppPaneContext();
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const activeServer = useActiveServerSnapshot();
    const allMachines = useAllMachines();
    const addFirstMachines = React.useMemo(() => resolveMachineActionCandidates(allMachines), [allMachines]);
    const lastMobileSurfaceByWorkspaceRefId = useProjectLastMobileSurfacesByWorkspaceRefId();
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const lastActiveWorktreeIdByWorkspaceRefId = useLocalSetting('projectLastActiveWorktreeIdByWorkspaceRefId');

    const [workspaceRefsV1, setWorkspaceRefsV1] = useSettingMutable('workspaceRefsV1');
    const [pinnedWorkspaceRefIdsV1, setPinnedWorkspaceRefIdsV1] = useSettingMutable('pinnedWorkspaceRefIdsV1');

    const machinesById = React.useMemo(() => {
        return new Map(allMachines.map((machine) => [machine.id, machine] as const));
    }, [allMachines]);

    const groups = React.useMemo(() => {
        return buildProjectsListGroups({
            activeServerId: String(activeServer.serverId ?? '').trim(),
            workspaceRefs: Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [],
            pinnedWorkspaceRefIds: Array.isArray(pinnedWorkspaceRefIdsV1) ? pinnedWorkspaceRefIdsV1 : [],
        });
    }, [activeServer.serverId, pinnedWorkspaceRefIdsV1, workspaceRefsV1]);

    const handleOpenWorkspace = React.useCallback((workspaceRef: WorkspaceRefV1) => {
        if (deviceType !== 'phone') {
            router.push(`/projects/${encodeURIComponent(workspaceRef.id)}`);
            return;
        }

        const scopeId = buildProjectPaneScopeId(workspaceRef.id);
        const rememberedRightTabId = paneContext?.state.scopes[scopeId]?.right?.activeTabId;
        const persistedSegment = typeof lastMobileSurfaceByWorkspaceRefId[workspaceRef.id] === 'string'
            ? lastMobileSurfaceByWorkspaceRefId[workspaceRef.id]
            : null;
        const persistedRootPath = lastActiveRootPathByWorkspaceRefId?.[workspaceRef.id];
        const persistedWorktreeId = lastActiveWorktreeIdByWorkspaceRefId?.[workspaceRef.id];
        const activeRootPath = typeof persistedRootPath === 'string' && persistedRootPath.trim().length > 0
            ? persistedRootPath
            : workspaceRef.rootPath;
        const activeWorktreeId = typeof persistedWorktreeId === 'string' ? persistedWorktreeId : null;
        if (cockpitEnabled) {
            const surface = resolveProjectMobileSurfaceIntent({
                routeKind: 'index',
                activeRightTabId: rememberedRightTabId,
                persistedSurface: typeof persistedSegment === 'string' ? persistedSegment : null,
            });
            router.push(resolveProjectRoutePathForSurface({
                workspaceRefId: workspaceRef.id,
                surface,
                ...resolveProjectRouteSelectionQuery({
                    activeRootPath,
                    defaultRootPath: workspaceRef.rootPath,
                    activeWorktreeId,
                }),
            }));
            return;
        }
        const segment = resolveProjectRouteSegment(
            rememberedRightTabId,
            typeof persistedSegment === 'string' ? persistedSegment : null,
        );
        router.push(buildProjectRouteHref({
            workspaceRefId: workspaceRef.id,
            segment,
            activeRootPath,
            defaultRootPath: workspaceRef.rootPath,
            activeWorktreeId,
        }));
    }, [cockpitEnabled, deviceType, lastActiveRootPathByWorkspaceRefId, lastActiveWorktreeIdByWorkspaceRefId, lastMobileSurfaceByWorkspaceRefId, paneContext?.state.scopes, router]);

    const handleAddProjectToMachine = React.useCallback(async (machineId: string) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        if (!serverId) return;
        const selected = await openMachinePathBrowserModal({
            machineId,
            serverId,
            title: t('newSession.selectPathTitle'),
            selectionMode: 'directory',
        });
        if (!selected) return;
        const selectedRootPath = selected.trim();
        if (!selectedRootPath) return;

        const preflight = await workspaceListDirectory({ serverId, machineId, rootPath: selectedRootPath }, '');
        if (!preflight.success) {
            Modal.alert(t('common.error'), preflight.error);
            return;
        }

        const nowMs = Date.now();
        const nextRefs = upsertWorkspaceRefByScope(Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [], {
            scope: { serverId, machineId, rootPath: selectedRootPath },
            nowMs,
            patch: { lastOpenedAtMs: nowMs },
        });
        setWorkspaceRefsV1(nextRefs);

        const added = findWorkspaceRefByScope(nextRefs, { serverId, machineId, rootPath: selectedRootPath });
        if (added) {
            router.push(`/projects/${encodeURIComponent(added.id)}`);
        }
    }, [activeServer.serverId, router, setWorkspaceRefsV1, workspaceRefsV1]);

    const pinnedIdSet = React.useMemo(() => {
        return new Set(Array.isArray(pinnedWorkspaceRefIdsV1) ? pinnedWorkspaceRefIdsV1 : []);
    }, [pinnedWorkspaceRefIdsV1]);

    const handleTogglePinned = React.useCallback((workspaceRefId: string) => {
        const id = String(workspaceRefId ?? '').trim();
        if (!id) return;
        const current = Array.isArray(pinnedWorkspaceRefIdsV1) ? pinnedWorkspaceRefIdsV1 : [];
        if (pinnedIdSet.has(id)) {
            setPinnedWorkspaceRefIdsV1(current.filter((v) => String(v ?? '').trim() !== id));
            return;
        }
        setPinnedWorkspaceRefIdsV1([...current, id]);
    }, [pinnedIdSet, pinnedWorkspaceRefIdsV1, setPinnedWorkspaceRefIdsV1]);

    const handleRenameProject = React.useCallback(async (workspaceRef: WorkspaceRefV1) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        if (!serverId) return;
        const currentLabel = resolveWorkspaceRefDisplayName(workspaceRef);
        const newName = await Modal.prompt(
            t('sessionsList.renameWorkspacePromptTitle'),
            undefined,
            {
                defaultValue: currentLabel,
                placeholder: t('sessionsList.renameWorkspacePromptPlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (newName == null) return;
        const trimmed = newName.trim();
        if (!trimmed) return;

        const nextRefs = (Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : []).map((ref) => {
            if (ref.id !== workspaceRef.id) return ref;
            if (String(ref.serverId ?? '').trim() !== serverId) return ref;
            return { ...ref, label: trimmed };
        });
        setWorkspaceRefsV1(nextRefs);
    }, [activeServer.serverId, setWorkspaceRefsV1, workspaceRefsV1]);

    const handleResetProjectName = React.useCallback((workspaceRef: WorkspaceRefV1) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        if (!serverId) return;
        const nextRefs = (Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : []).map((ref) => {
            if (ref.id !== workspaceRef.id) return ref;
            if (String(ref.serverId ?? '').trim() !== serverId) return ref;
            return { ...ref, label: null };
        });
        setWorkspaceRefsV1(nextRefs);
    }, [activeServer.serverId, setWorkspaceRefsV1, workspaceRefsV1]);

    const handleRemoveProject = React.useCallback((workspaceRef: WorkspaceRefV1) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        if (!serverId) return;
        const id = String(workspaceRef.id ?? '').trim();
        if (!id) return;
        const nextRefs = (Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : []).filter((ref) => {
            if (String(ref.serverId ?? '').trim() !== serverId) return true;
            return String(ref.id ?? '').trim() !== id;
        });
        setWorkspaceRefsV1(nextRefs);
        const currentPinned = Array.isArray(pinnedWorkspaceRefIdsV1) ? pinnedWorkspaceRefIdsV1 : [];
        if (pinnedIdSet.has(id)) {
            setPinnedWorkspaceRefIdsV1(currentPinned.filter((v) => String(v ?? '').trim() !== id));
        }
    }, [
        activeServer.serverId,
        pinnedIdSet,
        pinnedWorkspaceRefIdsV1,
        setPinnedWorkspaceRefIdsV1,
        setWorkspaceRefsV1,
        workspaceRefsV1,
    ]);

    const hasAnyProjects = groups.pinned.length > 0 || groups.machineGroups.length > 0;

    return (
        <ItemList
            testID="projects-list"
            containerStyle={{ paddingTop: 12 }}
        >
            {!hasAnyProjects ? (
                <CenteredInfoTile
                    icon={(
                        <Icon
                            name="folder-open"
                            size={48}
                            color={theme.colors.text.secondary}
                            style={{ marginBottom: 12 }}
                        />
                    )}
                    title={t('projects.emptyTitle')}
                    description={t('projects.emptyDescription')}
                />
            ) : null}

            {groups.pinned.length > 0 ? (
                <ItemGroup title={t('projects.groups.pinned')}>
                    {groups.pinned.map((workspaceRef) => (
                        <Item
                            key={workspaceRef.id}
                            testID={`projects-list-item-${workspaceRef.id}`}
                            title={resolveWorkspaceRefDisplayName(workspaceRef)}
                            subtitle={workspaceRef.rootPath}
                            subtitleLines={1}
                            icon={<Icon name="folder" size={20} color={theme.colors.text.secondary} />}
                            rightElement={(
                                <ProjectsListItemMenu
                                    theme={theme}
                                    workspaceRef={workspaceRef}
                                    pinAction="unpin"
                                    onTogglePinned={handleTogglePinned}
                                    onRename={handleRenameProject}
                                    onReset={handleResetProjectName}
                                    onRemove={handleRemoveProject}
                                />
                            )}
                            onPress={() => handleOpenWorkspace(workspaceRef)}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {groups.machineGroups.map((group) => {
                const machine = machinesById.get(group.machineId) ?? null;
                const machineName = getMachineDisplayName(machine) ?? group.machineId;
                return (
                    <ItemGroup
                        key={group.machineId}
                        title={(
                            <ItemGroupTitleWithAction
                                title={machineName}
                                action={{
                                    testID: `projects-add-machine:${group.machineId}`,
                                    accessibilityLabel: t('projects.actions.addProjectToMachine'),
                                    iconName: 'plus',
                                    iconColor: theme.colors.text.secondary,
                                    disabled: false,
                                    onPress: () => { void handleAddProjectToMachine(group.machineId); },
                                }}
                            />
                        )}
                    >
                        {group.items.map((workspaceRef) => (
                            <Item
                                key={workspaceRef.id}
                                testID={`projects-list-item-${workspaceRef.id}`}
                                title={resolveWorkspaceRefDisplayName(workspaceRef)}
                                subtitle={workspaceRef.rootPath}
                                subtitleLines={1}
                                icon={<Icon name="folder" size={20} color={theme.colors.text.secondary} />}
                                rightElement={(
                                    <ProjectsListItemMenu
                                        theme={theme}
                                        workspaceRef={workspaceRef}
                                        pinAction={pinnedIdSet.has(workspaceRef.id) ? 'unpin' : 'pin'}
                                        onTogglePinned={handleTogglePinned}
                                        onRename={handleRenameProject}
                                        onReset={handleResetProjectName}
                                        onRemove={handleRemoveProject}
                                    />
                                )}
                                onPress={() => handleOpenWorkspace(workspaceRef)}
                            />
                        ))}
                    </ItemGroup>
                );
            })}

            {allMachines.length > 0 && !hasAnyProjects ? (
                <ItemGroup title={t('projects.groups.addFirst')}>
                    {addFirstMachines.map((machine) => (
                        <Item
                            key={machine.id}
                            testID={`projects-add-first-machine:${machine.id}`}
                            title={t('projects.actions.chooseProjectFolderOnMachine', {
                                machine: getMachineDisplayName(machine) ?? machine.metadata?.host ?? machine.id,
                            })}
                            subtitle={t('projects.actions.chooseProjectFolderSubtitle')}
                            icon={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />}
                            onPress={() => { void handleAddProjectToMachine(machine.id); }}
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});
