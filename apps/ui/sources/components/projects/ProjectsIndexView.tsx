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
    return (
        <View testID="projects-none-open" style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState
                layout="page"
                scene="noProjects"
                title={model.hasAnyProjects ? t('projects.noneOpenTitle') : t('projects.emptyTitle')}
                subtitle={model.hasAnyProjects ? t('projects.noneOpenDescription') : t('projects.emptyDescription')}
                action={(
                    <ProjectsAddMenu
                        testID="projects-none-open:add"
                        machines={model.addFirstMachines}
                        onAdd={model.addProjectToMachine}
                        // The page's one primary action, drawn as the empty state draws it.
                        renderTrigger={(open) => (
                            <RoundButton
                                testID="projects-none-open:add-button"
                                size="normal"
                                title={t('projects.actions.addProject')}
                                accessibilityLabel={t('projects.actions.addProject')}
                                action={async () => { open(); }}
                            />
                        )}
                    />
                )}
            />
        </View>
    );
});
