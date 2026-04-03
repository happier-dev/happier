import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupTitleWithAction } from '@/components/ui/lists/ItemGroupTitleWithAction';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { useAllMachines, useSettingMutable } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveWorkspaceDisplayLabel } from '@/sync/domains/workspaces/workspaceLabel';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { Modal } from '@/modal';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { findWorkspaceRefByScope, upsertWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { buildProjectsListGroups } from './projectsListGrouping';

type AppTheme = ReturnType<typeof useUnistyles>['theme'];

function resolvePathBasename(rawPath: string): string | null {
    const trimmed = String(rawPath ?? '').trim().replace(/[\\/]+$/, '');
    if (!trimmed) return null;
    const parts = trimmed.split(/[/\\]/g).filter(Boolean);
    return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
}

function resolveWorkspaceFallbackPathLabel(workspaceRef: WorkspaceRefV1): string {
    return resolvePathBasename(workspaceRef.rootPath) ?? workspaceRef.rootPath;
}

type ProjectsListItemMenuProps = Readonly<{
    theme: AppTheme;
    items: ReadonlyArray<DropdownMenuItem>;
    onSelect: (itemId: string) => void;
}>;

function stopPressEventPropagation(event: unknown): void {
    const maybeEvent = event as {
        stopPropagation?: () => void;
        nativeEvent?: { stopPropagation?: () => void };
    };
    try {
        maybeEvent.stopPropagation?.();
    } catch {}
    try {
        maybeEvent.nativeEvent?.stopPropagation?.();
    } catch {}
}

const ProjectsListItemMenu = React.memo((props: ProjectsListItemMenuProps) => {
    const [open, setOpen] = React.useState(false);
    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={props.items}
            onSelect={props.onSelect}
            placement="left"
            variant="slim"
            matchTriggerWidth={false}
            maxWidthCap={240}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
            trigger={({ toggle }) => (
                <Pressable
                    onPress={(event) => {
                        stopPressEventPropagation(event);
                        toggle();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.moreActions')}
                    hitSlop={10}
                    style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
                >
                    <Octicons name="kebab-horizontal" size={14} color={props.theme.colors.textSecondary} />
                </Pressable>
            )}
        />
    );
});

export const ProjectsListView = React.memo(() => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const activeServer = useActiveServerSnapshot();
    const allMachines = useAllMachines();

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
        router.push(`/projects/${encodeURIComponent(workspaceRef.id)}`);
    }, [router]);

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

        const nowMs = Date.now();
        const nextRefs = upsertWorkspaceRefByScope(Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [], {
            scope: { serverId, machineId, rootPath: selected },
            nowMs,
            patch: { lastOpenedAtMs: nowMs },
        });
        setWorkspaceRefsV1(nextRefs);

        const added = findWorkspaceRefByScope(nextRefs, { serverId, machineId, rootPath: selected });
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
        const currentLabel = resolveWorkspaceDisplayLabel({
            scope: { serverId: workspaceRef.serverId, machineId: workspaceRef.machineId, rootPath: workspaceRef.rootPath },
            workspaceRef,
            fallbackPathLabel: resolveWorkspaceFallbackPathLabel(workspaceRef),
        });
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
                <ItemGroup>
                    <View style={{ alignItems: 'center', paddingVertical: 32, paddingHorizontal: 16 }}>
                        <Ionicons
                            name="folder-open-outline"
                            size={48}
                            color={theme.colors.textSecondary}
                            style={{ marginBottom: 12 }}
                        />
                        <View style={{ maxWidth: 520 }}>
                            <Text style={{
                                fontSize: 18,
                                ...Typography.default('semiBold'),
                                color: theme.colors.text,
                                textAlign: 'center',
                                marginBottom: 6,
                            }}>
                                {t('projects.emptyTitle')}
                            </Text>
                            <Text style={{
                                fontSize: 14,
                                ...Typography.default(),
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                lineHeight: 20,
                            }}>
                                {t('projects.emptyDescription')}
                            </Text>
                        </View>
                    </View>
                </ItemGroup>
            ) : null}

            {groups.pinned.length > 0 ? (
                <ItemGroup title={t('projects.groups.pinned')}>
                    {groups.pinned.map((workspaceRef) => (
                        <Item
                            key={workspaceRef.id}
                            testID={`projects-list-item-${workspaceRef.id}`}
                            title={resolveWorkspaceDisplayLabel({
                                scope: { serverId: workspaceRef.serverId, machineId: workspaceRef.machineId, rootPath: workspaceRef.rootPath },
                                workspaceRef,
                                fallbackPathLabel: resolveWorkspaceFallbackPathLabel(workspaceRef),
                            })}
                            subtitle={workspaceRef.rootPath}
                            subtitleLines={1}
                            icon={<Ionicons name="folder-outline" size={22} color={theme.colors.textSecondary} />}
                            rightElement={(
                                <ProjectsListItemMenu
                                    theme={theme}
                                    items={[
                                        {
                                            id: 'unpin',
                                            title: t('projects.actions.unpin'),
                                            icon: <Ionicons name="pin-outline" size={16} color={theme.colors.textSecondary} />,
                                        },
                                        {
                                            id: 'rename',
                                            title: t('sessionsList.renameWorkspace'),
                                            icon: <Ionicons name="pencil-outline" size={16} color={theme.colors.textSecondary} />,
                                        },
                                        {
                                            id: 'reset',
                                            title: t('sessionsList.resetWorkspaceName'),
                                            icon: <Ionicons name="refresh-outline" size={16} color={theme.colors.textSecondary} />,
                                        },
                                        {
                                            id: 'remove',
                                            title: t('projects.actions.remove'),
                                            icon: <Ionicons name="trash-outline" size={16} color={theme.colors.deleteAction} />,
                                        },
                                    ] satisfies DropdownMenuItem[]}
                                    onSelect={(itemId) => {
                                        if (itemId === 'unpin') handleTogglePinned(workspaceRef.id);
                                        if (itemId === 'rename') void handleRenameProject(workspaceRef);
                                        if (itemId === 'reset') handleResetProjectName(workspaceRef);
                                        if (itemId === 'remove') handleRemoveProject(workspaceRef);
                                    }}
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
                                    accessibilityLabel: t('projects.actions.addProjectToMachine'),
                                    iconName: 'add-outline',
                                    iconColor: theme.colors.groupped.sectionTitle,
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
                                title={resolveWorkspaceDisplayLabel({
                                    scope: { serverId: workspaceRef.serverId, machineId: workspaceRef.machineId, rootPath: workspaceRef.rootPath },
                                    workspaceRef,
                                    fallbackPathLabel: resolveWorkspaceFallbackPathLabel(workspaceRef),
                                })}
                                subtitle={workspaceRef.rootPath}
                                subtitleLines={1}
                                icon={<Ionicons name="folder-outline" size={22} color={theme.colors.textSecondary} />}
                                rightElement={(
                                    <ProjectsListItemMenu
                                        theme={theme}
                                        items={[
                                            {
                                                id: pinnedIdSet.has(workspaceRef.id) ? 'unpin' : 'pin',
                                                title: pinnedIdSet.has(workspaceRef.id) ? t('projects.actions.unpin') : t('projects.actions.pin'),
                                                icon: <Ionicons name="pin-outline" size={16} color={theme.colors.textSecondary} />,
                                            },
                                            {
                                                id: 'rename',
                                                title: t('sessionsList.renameWorkspace'),
                                                icon: <Ionicons name="pencil-outline" size={16} color={theme.colors.textSecondary} />,
                                            },
                                            {
                                                id: 'reset',
                                                title: t('sessionsList.resetWorkspaceName'),
                                                icon: <Ionicons name="refresh-outline" size={16} color={theme.colors.textSecondary} />,
                                            },
                                            {
                                                id: 'remove',
                                                title: t('projects.actions.remove'),
                                                icon: <Ionicons name="trash-outline" size={16} color={theme.colors.deleteAction} />,
                                            },
                                        ] satisfies DropdownMenuItem[]}
                                        onSelect={(itemId) => {
                                            if (itemId === 'pin' || itemId === 'unpin') handleTogglePinned(workspaceRef.id);
                                            if (itemId === 'rename') void handleRenameProject(workspaceRef);
                                            if (itemId === 'reset') handleResetProjectName(workspaceRef);
                                            if (itemId === 'remove') handleRemoveProject(workspaceRef);
                                        }}
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
                    {allMachines.map((machine) => (
                        <Item
                            key={machine.id}
                            testID={`projects-add-first-machine:${machine.id}`}
                            title={getMachineDisplayName(machine) ?? machine.metadata?.host ?? machine.id}
                            subtitle={t('projects.actions.addProject')}
                            icon={<Ionicons name="desktop-outline" size={22} color={theme.colors.textSecondary} />}
                            onPress={() => { void handleAddProjectToMachine(machine.id); }}
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});
