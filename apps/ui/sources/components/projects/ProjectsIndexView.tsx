import * as React from 'react';
import { View } from 'react-native';

import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { t } from '@/text';

import { ProjectsAddMenu } from './ProjectsAddMenu';
import { ProjectsListView } from './ProjectsListView';
import { useProjectsListModel } from './useProjectsListModel';

/**
 * `/projects`. Beside the Projects column the column is the list, so the page says no project is open
 * and offers to add one (a rail and its detail never both show the full state). Without the column —
 * collapsed, or on a phone — the page is the list.
 */
export const ProjectsIndexView = React.memo(function ProjectsIndexView() {
    const columnVisible = useAppShellColumn().columnVisible;
    return columnVisible ? <ProjectsNoneOpen /> : <ProjectsListView />;
});

const ProjectsNoneOpen = React.memo(function ProjectsNoneOpen() {
    const model = useProjectsListModel();
    // The same "+" as the column: a folder, a clone, your Sources, each Team's, Manage (plan 10 §2).
    const { addSources, cloneRepository } = model;
    const firstSaved = model.saved?.items[0] ?? null;
    const hasContent = model.hasAnyProjects || Boolean(firstSaved);
    return (
        <View testID="projects-none-open" style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
                layout="page"
                scene="noProjects"
                title={hasContent ? t('projects.noneOpenTitle') : t('projects.emptyTitle')}
                subtitle={hasContent ? t('projects.noneOpenDescription') : t('projects.emptyDescription')}
                action={(
                    <>
                    {firstSaved ? <RoundButton testID="projects-none-open:open-source" size="normal"
                        title={`${t('common.open')} ${firstSaved.title}`}
                        action={async () => { model.saved?.onOpen(firstSaved.key); }} /> : null}
                    <ProjectsAddMenu
                        testID="projects-none-open:add"
                        machines={model.addFirstMachines}
                        onAdd={model.addProjectToMachine}
                        onClone={cloneRepository}
                        sources={addSources}
                        // The page's one primary action, drawn as the empty state draws it.
                        renderTrigger={firstSaved ? undefined : (open) => (
                            <RoundButton
                                testID="projects-none-open:add-button"
                                size="normal"
                                title={t('projects.actions.addProject')}
                                accessibilityLabel={t('projects.actions.addProject')}
                                action={async () => { open(); }}
                            />
                        )}
                    />
                    </>
                )}
            />
        </View>
    );
});
