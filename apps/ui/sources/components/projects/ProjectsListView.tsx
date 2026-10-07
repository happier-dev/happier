import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupTitleWithAction } from '@/components/ui/lists/ItemGroupTitleWithAction';
import { Item } from '@/components/ui/lists/Item';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

import { ProjectsListItemMenu } from './ProjectsListItemMenu';
import { resolveWorkspaceRefDisplayName } from './resolveWorkspaceRefDisplayName';
import { Icon } from '@/components/ui/icons/Icon';
import { useProjectsListModel } from './useProjectsListModel';

/** The Projects page as a list: where the Projects column is not beside it (collapsed, and on phones). */
export const ProjectsListView = React.memo(() => {
    const { theme } = useUnistyles();
    const model = useProjectsListModel();
    const { groups, hasAnyProjects } = model;

    return (
        <ItemList presentation="grouped"
            testID="projects-list"
            containerStyle={{ paddingTop: 12 }}
        >
            {!hasAnyProjects ? (
                <EmptyState
                    testID="projects-list-empty"
                    scene="noProjects"
                    title={t('projects.emptyTitle')}
                    subtitle={t('projects.emptyDescription')}
                />
            ) : null}

            {groups.pinned.length > 0 ? (
                <ItemGroup title={t('projects.groups.pinned')}>
                    {groups.pinned.map((workspaceRef) => (
                        <Item
                            key={workspaceRef.id}
                            testID={`projects-list-item-${workspaceRef.id}`}
                            title={resolveWorkspaceRefDisplayName(workspaceRef)}
                            subtitle={model.workspaceSubtitle(workspaceRef)}
                            subtitleLines={model.workspaceSubtitleLines(workspaceRef)}
                            icon={<Icon name="folder" size={20} color={theme.colors.text.secondary} />}
                            rightElement={(
                                <ProjectsListItemMenu
                                    theme={theme}
                                    workspaceRef={workspaceRef}
                                    pinAction="unpin"
                                    onTogglePinned={model.togglePinned}
                                    onRename={model.renameProject}
                                    onReset={model.resetProjectName}
                                    onRemove={model.removeProject}
                                />
                            )}
                            onPress={() => { model.openProject(workspaceRef.id); }}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {groups.machineGroups.map((group) => {
                const machine = model.machinesById.get(group.machineId) ?? null;
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
                                    onPress: () => { void model.addProjectToMachine(group.machineId); },
                                }}
                            />
                        )}
                    >
                        {group.items.map((workspaceRef) => (
                            <Item
                                key={workspaceRef.id}
                                testID={`projects-list-item-${workspaceRef.id}`}
                                title={resolveWorkspaceRefDisplayName(workspaceRef)}
                                subtitle={model.workspaceSubtitle(workspaceRef)}
                                subtitleLines={model.workspaceSubtitleLines(workspaceRef)}
                                icon={<Icon name="folder" size={20} color={theme.colors.text.secondary} />}
                                rightElement={(
                                    <ProjectsListItemMenu
                                        theme={theme}
                                        workspaceRef={workspaceRef}
                                        pinAction={model.pinnedIdSet.has(workspaceRef.id) ? 'unpin' : 'pin'}
                                        onTogglePinned={model.togglePinned}
                                        onRename={model.renameProject}
                                        onReset={model.resetProjectName}
                                        onRemove={model.removeProject}
                                    />
                                )}
                                onPress={() => { model.openProject(workspaceRef.id); }}
                            />
                        ))}
                    </ItemGroup>
                );
            })}

            {model.allMachines.length > 0 && !hasAnyProjects ? (
                <ItemGroup title={t('projects.groups.addFirst')}>
                    {model.addFirstMachines.map((machine) => (
                        <Item
                            key={machine.id}
                            testID={`projects-add-first-machine:${machine.id}`}
                            title={t('projects.actions.chooseProjectFolderOnMachine', {
                                machine: getMachineDisplayName(machine) ?? machine.metadata?.host ?? machine.id,
                            })}
                            subtitle={t('projects.actions.chooseProjectFolderSubtitle')}
                            icon={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />}
                            onPress={() => { void model.addProjectToMachine(machine.id); }}
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});
